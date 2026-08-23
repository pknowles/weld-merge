// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Uri, workspace } from "vscode";
import {
	type CommitInfo,
	type ConflictRegion,
	type ConflictSnapshot,
	createConflictSnapshot,
	createGitMergeFileContent,
	createThreeWayComparison,
	createTwoWayComparison,
	fetchConflictIndexStages,
	fetchConflictStages,
	getCommitInfo,
	getConflictRegion,
	getRemoteRef,
	isBinaryConflict,
	type LineRange,
	rangesOverlap,
} from "./conflictSnapshot.ts";
import { repositoryRelativePath } from "./gitUtils.ts";
import type { DiffChunk, DiffChunkTag } from "./matchers/myers.ts";
import {
	type ConflictedItem,
	createConflictedItem,
	getGitApi,
	isSupportedScheme,
} from "./repoContext.ts";
import { isActiveSubmoduleGitlinkConflict } from "./submoduleConflict.ts";

const DEFAULT_CONTEXT_LINES = 5;
const DEFAULT_MAX_STAGE_LINES = 80;
const DEFAULT_MAX_RESULT_ITEMS = 80;
const CONFLICT_SENTINEL_REGEX = /\(\?\?\)/u;
const MARKER_START_REGEX = /^<+(?:\s|$)/u;
const MARKER_END_REGEX = /^>+(?:\s|$)/u;
const MARKER_MIDDLE_REGEX = /^(\|+|=+)(?:\s|$)/u;

type ConflictKind =
	| "text"
	| "bothAdded"
	| "binary"
	| "deletedByUs"
	| "deletedByThem"
	| "bothDeleted"
	| "submodule";
type TextConflictKind = "text" | "bothAdded";
type NonTextConflictKind = Exclude<ConflictKind, TextConflictKind>;

interface ConflictLocation {
	repositoryRoot: string;
	path: string;
}

interface CommitMetadata {
	hash: string;
	title: string;
}

interface ListedConflict extends ConflictLocation {
	conflictCount: number;
	kind: ConflictKind;
	commits: { local: CommitMetadata; remote: CommitMetadata | null };
}

interface ConflictList {
	files: ListedConflict[];
}

interface GetConflictToolInput extends ConflictLocation {
	conflictIndex?: number | null;
	contextLines?: number;
	maxStageLines?: number;
	maxResultItems?: number;
}

interface GetConflictRequest extends ConflictLocation {
	conflictIndex: number | null;
	contextLines: number;
	maxStageLines: number;
	maxResultItems: number;
}

interface RawGitAccess {
	stage: 1 | 2 | 3;
	command: string;
}

type DiskRange = [startLine: number, endLineExclusive: number];

interface DiskHunk {
	range: DiskRange;
	local: DiffChunkTag | null;
	remote: DiffChunkTag | null;
}

interface DiskTextRegion {
	range: DiskRange;
	text: string;
}

interface MappedDiskTarget {
	state: "mapped";
	range: DiskRange;
	contextBefore?: DiskTextRegion;
	contextAfter?: DiskTextRegion;
	omitted?: { reason: "exceedsMaxStageLines" };
}

interface UnavailableDiskTarget {
	state: "unavailable";
	reason: "notFound" | "ambiguous";
	message: string;
}

type DiskTarget = MappedDiskTarget | UnavailableDiskTarget;

interface ResidualMarker {
	range: DiskRange;
	kind: "gitMarker" | "weldSentinel";
}

interface OmittedStageContent {
	reason: "exceedsMaxStageLines";
	rawGitAccess: RawGitAccess;
}

interface Suggestion {
	range: DiskRange;
	text: string;
}

interface ConflictResultIdentity {
	type: ConflictKind;
	repositoryRoot: string;
	path: string;
	conflictIndex: number | null;
	conflictCount: number;
}

interface NonTextConflictResult extends ConflictResultIdentity {
	type: NonTextConflictKind;
	message: string;
}

interface TextConflictResult extends ConflictResultIdentity {
	type: TextConflictKind;
	localDiff?: string;
	remoteDiff?: string;
	local?: string;
	remote?: string;
	localOmitted?: OmittedStageContent;
	remoteOmitted?: OmittedStageContent;
	current: {
		target: DiskTarget;
		possibleConflictHunks?: DiskHunk[];
		possibleConflictHunksTruncated?: true;
		residualMarkers?: ResidualMarker[];
		residualMarkersTruncated?: true;
	};
	autoMergeSuggestions?: Suggestion[];
	autoMergeSuggestionsTruncated?: true;
}

interface FileConflictSummary extends ConflictResultIdentity {
	type: TextConflictKind;
	conflictIndex: null;
	conflictCount: 0;
	current: TextConflictResult["current"];
	autoMergeSuggestions?: Suggestion[];
	autoMergeSuggestionsTruncated?: true;
}

type GetConflictResult =
	| TextConflictResult
	| FileConflictSummary
	| NonTextConflictResult;

type ConflictInspection =
	| {
			kind: TextConflictKind;
			snapshot: ConflictSnapshot;
			baseStagePresent: boolean;
	  }
	| { kind: NonTextConflictKind };

type TextConflictInspection = Extract<
	ConflictInspection,
	{ kind: TextConflictKind }
>;

function normalizeGetConflictInput(
	input: GetConflictToolInput,
): GetConflictRequest {
	if (
		typeof input.repositoryRoot !== "string" ||
		input.repositoryRoot === ""
	) {
		throw new Error("repositoryRoot must be a non-empty URI string.");
	}
	if (typeof input.path !== "string" || input.path === "") {
		throw new Error("path must be a non-empty repository-relative string.");
	}
	if (!validConflictIndex(input.conflictIndex)) {
		throw new Error("conflictIndex must be a nonnegative safe integer.");
	}
	const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
	const maxStageLines = input.maxStageLines ?? DEFAULT_MAX_STAGE_LINES;
	const maxResultItems = input.maxResultItems ?? DEFAULT_MAX_RESULT_ITEMS;
	if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
		throw new Error("contextLines must be a nonnegative safe integer.");
	}
	if (!Number.isSafeInteger(maxStageLines) || maxStageLines < 0) {
		throw new Error("maxStageLines must be a nonnegative safe integer.");
	}
	if (!Number.isSafeInteger(maxResultItems) || maxResultItems < 0) {
		throw new Error("maxResultItems must be a nonnegative safe integer.");
	}
	return {
		repositoryRoot: input.repositoryRoot,
		path: input.path,
		conflictIndex: input.conflictIndex ?? null,
		contextLines,
		maxStageLines,
		maxResultItems,
	};
}

function validConflictIndex(conflictIndex: number | null | undefined): boolean {
	return (
		conflictIndex === null ||
		conflictIndex === undefined ||
		(Number.isSafeInteger(conflictIndex) && conflictIndex >= 0)
	);
}

function commitMetadata(commit: CommitInfo): CommitMetadata {
	const { hash, title } = commit;
	return { hash, title };
}

async function repositoryCommits(
	item: ConflictedItem,
): Promise<ListedConflict["commits"]> {
	const [local, remoteRef] = await Promise.all([
		getCommitInfo(item.repository, "HEAD"),
		getRemoteRef(item.repository),
	]);
	const remote =
		remoteRef === null
			? null
			: await getCommitInfo(item.repository, remoteRef);
	return {
		local: commitMetadata(local),
		remote: remote === null ? null : commitMetadata(remote),
	};
}

function listedConflict(
	conflictedItem: ConflictedItem,
	conflictCount: number,
	kind: ConflictKind,
	commits: ListedConflict["commits"],
): ListedConflict {
	return {
		repositoryRoot: conflictedItem.repository.rootUri.toString(),
		path: repositoryRelativePath(
			conflictedItem.repository.rootUri,
			conflictedItem.uri,
		),
		conflictCount,
		kind,
		commits,
	};
}

async function inspectConflict(
	item: ConflictedItem,
): Promise<ConflictInspection> {
	if (await isActiveSubmoduleGitlinkConflict(item.repository, item.uri)) {
		return { kind: "submodule" };
	}
	const indexStages = await fetchConflictIndexStages(item);
	if (!indexStages.local && indexStages.remote) {
		return { kind: "deletedByUs" };
	}
	if (indexStages.local && !indexStages.remote) {
		return { kind: "deletedByThem" };
	}
	if (!(indexStages.local || indexStages.remote)) {
		return { kind: "bothDeleted" };
	}
	if (await isBinaryConflict(item)) {
		return { kind: "binary" };
	}
	// No base index entry at all (as opposed to a base stage that simply
	// differs from both sides) means there is no common ancestor for this
	// path: local and remote each independently created an unrelated file
	// at the same path, not an edit conflict on a shared file.
	return {
		kind: indexStages.base ? "text" : "bothAdded",
		baseStagePresent: indexStages.base,
		snapshot: createConflictSnapshot(await fetchConflictStages(item)),
	};
}

async function listConflicts(): Promise<ConflictList> {
	const items = getGitApi()
		.repositories.filter((repository) =>
			isSupportedScheme(repository.rootUri),
		)
		.flatMap((repository) =>
			repository.state.mergeChanges.map((change) =>
				createConflictedItem(repository, change),
			),
		);
	const commitsByRepository = new Map<
		string,
		Promise<ListedConflict["commits"]>
	>();
	return {
		files: await Promise.all(
			items.map(async (item) => {
				try {
					const commits =
						commitsByRepository.get(
							item.repository.rootUri.toString(),
						) ?? repositoryCommits(item);
					commitsByRepository.set(
						item.repository.rootUri.toString(),
						commits,
					);
					const inspection = await inspectConflict(item);
					return listedConflict(
						item,
						inspection.kind === "text" ||
							inspection.kind === "bothAdded"
							? inspection.snapshot.conflictChangeIndexes.length
							: 1,
						inspection.kind,
						await commits,
					);
				} catch (error: unknown) {
					throw new Error(
						`Failed to inspect conflict ${item.uri.toString()}.`,
						{ cause: error },
					);
				}
			}),
		),
	};
}

function resolveConflictedItem(location: ConflictLocation): ConflictedItem {
	const repository = getGitApi().repositories.find(
		(candidate) =>
			candidate.rootUri.toString() === location.repositoryRoot &&
			isSupportedScheme(candidate.rootUri),
	);
	if (!repository) {
		throw new Error(
			`No open Git repository matches ${location.repositoryRoot}. Call weld_list_conflicts again.`,
		);
	}
	const uri = Uri.joinPath(repository.rootUri, ...location.path.split("/"));
	if (repositoryRelativePath(repository.rootUri, uri) !== location.path) {
		throw new Error("path must be a canonical repository-relative path.");
	}
	const change = repository.state.mergeChanges.find(
		(candidate) => candidate.uri.toString() === uri.toString(),
	);
	if (!change) {
		throw new Error(
			`${location.path} is not an active conflict in ${location.repositoryRoot}. Call weld_list_conflicts again.`,
		);
	}
	return createConflictedItem(repository, change);
}

function diskRange(range: LineRange): DiskRange {
	return [range.start + 1, range.end + 1];
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function rawGitAccess(stage: 2 | 3, request: GetConflictRequest): RawGitAccess {
	return {
		stage,
		command: `git -C ${shellQuote(Uri.parse(request.repositoryRoot).fsPath)} show ${shellQuote(`:${stage}:${request.path}`)}`,
	};
}

function unifiedRangeStart(start: number, count: number): number {
	return count === 0 ? start : start + 1;
}

/**
 * Serializes one conflict from the GUI's whole-file two-way matching result.
 * It only selects existing chunks (plus adjacent equal context); it never
 * re-matches independently sliced windows.
 */
interface ScopedDiffInput {
	baseLines: string[];
	stageLines: string[];
	opcodes: DiffChunk[];
	baseChange: LineRange;
	stageChange: LineRange;
	contextLines: number;
}

function renderScopedUnifiedDiff({
	baseLines,
	stageLines,
	opcodes,
	baseChange,
	stageChange,
	contextLines,
}: ScopedDiffInput): string {
	const changeIndexes = opcodes.flatMap((opcode, index) =>
		opcode.tag !== "equal" &&
		rangesOverlap({ start: opcode.startA, end: opcode.endA }, baseChange) &&
		rangesOverlap({ start: opcode.startB, end: opcode.endB }, stageChange)
			? [index]
			: [],
	);
	if (changeIndexes.length === 0) {
		throw new Error(
			"Could not find the conflict change in the shared diff.",
		);
	}
	const firstChange = changeIndexes[0] as number;
	const lastChange = changeIndexes.at(-1) as number;
	const preceding = opcodes[firstChange - 1];
	const following = opcodes[lastChange + 1];
	const chunks: DiffChunk[] = [
		...(preceding?.tag === "equal"
			? [
					{
						...preceding,
						startA: Math.max(
							preceding.startA,
							preceding.endA - contextLines,
						),
						startB: Math.max(
							preceding.startB,
							preceding.endB - contextLines,
						),
					},
				]
			: []),
		...opcodes.slice(firstChange, lastChange + 1),
		...(following?.tag === "equal"
			? [
					{
						...following,
						endA: Math.min(
							following.endA,
							following.startA + contextLines,
						),
						endB: Math.min(
							following.endB,
							following.startB + contextLines,
						),
					},
				]
			: []),
	];
	const first = chunks[0] as DiffChunk;
	const last = chunks.at(-1) as DiffChunk;
	const body: string[] = [];
	for (const opcode of chunks) {
		if (opcode.tag === "equal") {
			body.push(
				...baseLines
					.slice(opcode.startA, opcode.endA)
					.map((line) => ` ${line}`),
			);
			continue;
		}
		if (opcode.tag === "delete" || opcode.tag === "replace") {
			body.push(
				...baseLines
					.slice(opcode.startA, opcode.endA)
					.map((line) => `-${line}`),
			);
		}
		if (opcode.tag === "insert" || opcode.tag === "replace") {
			body.push(
				...stageLines
					.slice(opcode.startB, opcode.endB)
					.map((line) => `+${line}`),
			);
		}
	}
	const baseLength = last.endA - first.startA;
	const stageLength = last.endB - first.startB;
	return [
		`@@ -${unifiedRangeStart(first.startA, baseLength)},${baseLength} +${unifiedRangeStart(first.startB, stageLength)},${stageLength} @@`,
		...body,
	].join("\n");
}

interface BoundedDiffInput extends Omit<ScopedDiffInput, "contextLines"> {
	stage: 2 | 3;
	request: GetConflictRequest;
}

function boundedDiff({ stage, request, ...input }: BoundedDiffInput): {
	diff: string | null;
	omitted: OmittedStageContent | null;
} {
	const diff = renderScopedUnifiedDiff({
		...input,
		contextLines: request.contextLines,
	});
	if (diff.split("\n").length <= request.maxStageLines) {
		return { diff, omitted: null };
	}
	return {
		diff: null,
		omitted: {
			reason: "exceedsMaxStageLines",
			rawGitAccess: rawGitAccess(stage, request),
		},
	};
}

function boundedBothAddedText(
	lines: string[],
	stage: 2 | 3,
	request: GetConflictRequest,
): { text: string | null; omitted: OmittedStageContent | null } {
	if (lines.length <= request.maxStageLines) {
		return { text: lines.join("\n"), omitted: null };
	}
	return {
		text: null,
		omitted: {
			reason: "exceedsMaxStageLines",
			rawGitAccess: rawGitAccess(stage, request),
		},
	};
}

function diskHunkFromChanges(
	local: DiffChunk | null,
	remote: DiffChunk | null,
): DiskHunk {
	const range = hunkRange(local, remote);
	return {
		range: diskRange(range),
		local: local?.tag ?? null,
		remote: remote?.tag ?? null,
	};
}

function hunkRange(
	local: DiffChunk | null,
	remote: DiffChunk | null,
): LineRange {
	const changes = [local, remote].filter(
		(change): change is DiffChunk => change !== null,
	);
	if (changes.length === 0) {
		throw new Error("Three-way change did not contain either side.");
	}
	return {
		start: Math.min(...changes.map((change) => change.startA)),
		end: Math.max(...changes.map((change) => change.endA)),
	};
}

// When `region` is given, only hunks whose stage-side (local/remote blob)
// range overlaps this specific conflict's region are returned — otherwise
// every unresolved hunk in the whole file comes back regardless of which
// conflictIndex was requested, which is both wasteful and misleading (the
// caller asked about one conflict, not the file).
function currentHunks(
	snapshot: ConflictSnapshot,
	current: string,
	region?: ConflictRegion,
): DiskHunk[] {
	return createThreeWayComparison(
		snapshot.stages.local,
		current,
		snapshot.stages.remote,
	)
		.changes.filter(
			([local, remote]) =>
				local?.tag === "conflict" || remote?.tag === "conflict",
		)
		.filter(
			([local, remote]) =>
				!region || hunkOverlapsRegion(local, remote, region),
		)
		.map(([local, remote]) => diskHunkFromChanges(local, remote));
}

function hunkOverlapsRegion(
	local: DiffChunk | null,
	remote: DiffChunk | null,
	region: ConflictRegion,
): boolean {
	return (
		(local !== null &&
			rangesOverlap(
				{ start: local.startB, end: local.endB },
				{
					start: region.changes.local.startB,
					end: region.changes.local.endB,
				},
			)) ||
		(remote !== null &&
			rangesOverlap(
				{ start: remote.startB, end: remote.endB },
				{
					start: region.changes.remote.startB,
					end: region.changes.remote.endB,
				},
			))
	);
}

function marker(
	range: DiskRange,
	kind: ResidualMarker["kind"],
): ResidualMarker {
	return { range, kind };
}

function scanMarkers(current: string): ResidualMarker[] {
	const markers: ResidualMarker[] = [];
	let markerStart: number | null = null;
	for (const [index, text] of current.split("\n").entries()) {
		if (CONFLICT_SENTINEL_REGEX.test(text)) {
			markers.push(
				marker(
					diskRange({ start: index, end: index + 1 }),
					"weldSentinel",
				),
			);
		}
		if (MARKER_START_REGEX.test(text)) {
			if (markerStart !== null) {
				markers.push(
					marker(
						diskRange({ start: markerStart, end: index }),
						"gitMarker",
					),
				);
			}
			markerStart = index;
			continue;
		}
		if (markerStart !== null && MARKER_END_REGEX.test(text)) {
			markers.push(
				marker(
					diskRange({ start: markerStart, end: index + 1 }),
					"gitMarker",
				),
			);
			markerStart = null;
			continue;
		}
		if (markerStart === null && MARKER_MIDDLE_REGEX.test(text)) {
			markers.push(
				marker(
					diskRange({ start: index, end: index + 1 }),
					"gitMarker",
				),
			);
		}
	}
	if (markerStart !== null) {
		markers.push(
			marker(
				diskRange({
					start: markerStart,
					end: current.split("\n").length,
				}),
				"gitMarker",
			),
		);
	}
	return markers;
}

function residualMarkers(
	current: string,
	target: DiskTarget,
): ResidualMarker[] {
	const markers = scanMarkers(current);
	if (target.state === "unavailable") {
		return markers;
	}
	return markers.filter(
		(marker) =>
			!rangesOverlap(
				{ start: marker.range[0] - 1, end: marker.range[1] - 1 },
				{ start: target.range[0] - 1, end: target.range[1] - 1 },
			),
	);
}

async function autoMergeSuggestions(
	item: ConflictedItem,
	snapshot: ConflictSnapshot,
): Promise<Suggestion[]> {
	const mergeFile = await createGitMergeFileContent(
		item.repository.rootUri.fsPath,
		snapshot.stages,
		["LOCAL", "BASE", "REMOTE"],
	);
	const markerRanges = markerBodyRanges(mergeFile);
	if (markerRanges.length === 0) {
		return [];
	}
	const gitConflictBaseRanges = createThreeWayComparison(
		snapshot.stages.base,
		mergeFile,
		snapshot.stages.base,
	)
		.changes.filter(([local, remote]) =>
			markerRanges.some((range) =>
				rangesOverlap(hunkRange(local, remote), range),
			),
		)
		.map(([local, remote]) => {
			const chunks = [local, remote].filter(
				(chunk): chunk is DiffChunk => chunk !== null,
			);
			return {
				start: Math.min(...chunks.map((chunk) => chunk.startB)),
				end: Math.max(...chunks.map((chunk) => chunk.endB)),
			};
		});
	return snapshot.changes
		.filter(
			([local, remote]) =>
				local?.tag !== "conflict" && remote?.tag !== "conflict",
		)
		.filter(([local, remote]) =>
			gitConflictBaseRanges.some((range) =>
				rangesOverlap(hunkRange(local, remote), range),
			),
		)
		.map(([local, remote]) => {
			const range = hunkRange(local, remote);
			return {
				range: diskRange(range),
				text: snapshot.mergedContent
					.split("\n")
					.slice(range.start, range.end)
					.join("\n"),
			};
		});
}

function markerBodyRanges(content: string): LineRange[] {
	const ranges: LineRange[] = [];
	let start: number | null = null;
	for (const [index, line] of content.split("\n").entries()) {
		if (MARKER_START_REGEX.test(line)) {
			start = index;
		}
		if (MARKER_END_REGEX.test(line) && start !== null) {
			ranges.push({ start, end: index + 1 });
			start = null;
		}
	}
	return ranges;
}

function bounded<T>(
	items: T[],
	maximum: number,
): { items: T[]; truncated: boolean } {
	return {
		items: items.slice(0, maximum),
		truncated: items.length > maximum,
	};
}

function compactCurrent(
	target: DiskTarget,
	hunks: { items: DiskHunk[]; truncated: boolean },
	markers: { items: ResidualMarker[]; truncated: boolean },
): TextConflictResult["current"] {
	return {
		target,
		...(hunks.items.length === 0
			? {}
			: { possibleConflictHunks: hunks.items }),
		...(hunks.truncated ? { possibleConflictHunksTruncated: true } : {}),
		...(markers.items.length === 0
			? {}
			: { residualMarkers: markers.items }),
		...(markers.truncated ? { residualMarkersTruncated: true } : {}),
	};
}

function compactSuggestions(suggestions: {
	items: Suggestion[];
	truncated: boolean;
}): Pick<
	TextConflictResult,
	"autoMergeSuggestions" | "autoMergeSuggestionsTruncated"
> {
	return {
		...(suggestions.items.length === 0
			? {}
			: { autoMergeSuggestions: suggestions.items }),
		...(suggestions.truncated
			? { autoMergeSuggestionsTruncated: true }
			: {}),
	};
}

function diskTextRegion(
	lines: string[],
	range: LineRange,
): DiskTextRegion | null {
	if (range.start === range.end) {
		return null;
	}
	return {
		range: diskRange(range),
		text: lines.slice(range.start, range.end).join("\n"),
	};
}

function diskTarget(
	hunks: DiskHunk[],
	current: string,
	request: GetConflictRequest,
): DiskTarget {
	if (hunks.length === 0) {
		return {
			state: "unavailable",
			reason: "notFound",
			message:
				"The requested conflict no longer maps to a disk conflict region. Read the current file before editing.",
		};
	}
	if (hunks.length > 1) {
		return {
			state: "unavailable",
			reason: "ambiguous",
			message:
				"The requested conflict maps to multiple disk conflict regions. Read the current file before editing.",
		};
	}
	const hunk = hunks[0];
	if (!hunk) {
		throw new Error("Expected exactly one disk conflict hunk.");
	}
	const lines = current.split("\n");
	const range = { start: hunk.range[0] - 1, end: hunk.range[1] - 1 };
	const requestedBefore = Math.min(request.contextLines, range.start);
	const requestedAfter = Math.min(
		request.contextLines,
		lines.length - range.end,
	);
	const budget = Math.max(
		0,
		request.maxStageLines - (range.end - range.start),
	);
	let before = Math.min(requestedBefore, Math.floor(budget / 2));
	let after = Math.min(requestedAfter, budget - before);
	before += Math.min(requestedBefore - before, budget - before - after);
	after += Math.min(requestedAfter - after, budget - before - after);
	const contextBefore = diskTextRegion(lines, {
		start: range.start - before,
		end: range.start,
	});
	const contextAfter = diskTextRegion(lines, {
		start: range.end,
		end: range.end + after,
	});
	return {
		state: "mapped",
		range: hunk.range,
		...(contextBefore === null ? {} : { contextBefore }),
		...(contextAfter === null ? {} : { contextAfter }),
		...(before < requestedBefore || after < requestedAfter
			? { omitted: { reason: "exceedsMaxStageLines" as const } }
			: {}),
	};
}

async function fileConflictSummary(
	request: GetConflictRequest,
	item: ConflictedItem,
	snapshot: ConflictSnapshot,
	kind: TextConflictKind,
): Promise<FileConflictSummary> {
	const current = new TextDecoder().decode(
		await workspace.fs.readFile(item.uri),
	);
	const possibleConflictHunks = bounded(
		currentHunks(snapshot, current),
		request.maxResultItems,
	);
	const target: DiskTarget = {
		state: "unavailable",
		reason: "notFound",
		message:
			"This file has no initial Weld conflict region. Read the current file before editing.",
	};
	const markers = bounded(
		residualMarkers(current, target),
		request.maxResultItems,
	);
	const suggestions = bounded(
		await autoMergeSuggestions(item, snapshot),
		request.maxResultItems,
	);
	return {
		type: kind,
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: null,
		conflictCount: 0,
		current: compactCurrent(target, possibleConflictHunks, markers),
		...compactSuggestions(suggestions),
	};
}

function nonTextMessage(kind: NonTextConflictKind): string {
	return {
		binary: "Binary conflicts do not have textual conflict regions.",
		deletedByUs:
			"The local side deleted this file while the remote side modified it.",
		deletedByThem:
			"The remote side deleted this file while the local side modified it.",
		bothDeleted:
			"Both sides deleted this file; no text stages are available.",
		submodule:
			"Submodule conflicts contain Git commit references rather than text regions.",
	}[kind];
}

function createNonTextConflictResult(
	request: GetConflictRequest,
	type: NonTextConflictKind,
): NonTextConflictResult {
	return {
		type,
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: request.conflictIndex,
		conflictCount: 1,
		message: nonTextMessage(type),
	};
}

async function conflictContext(
	request: GetConflictRequest,
	item: ConflictedItem,
	snapshot: ConflictSnapshot,
	region: ConflictRegion,
): Promise<
	TextConflictResult["current"] & {
		suggestions?: Suggestion[];
		suggestionsTruncated?: true;
	}
> {
	const current = new TextDecoder().decode(
		await workspace.fs.readFile(item.uri),
	);
	const scopedHunks = currentHunks(snapshot, current, region);
	const target = diskTarget(scopedHunks, current, request);
	const possibleConflictHunks = bounded(scopedHunks, request.maxResultItems);
	const markers = bounded(
		residualMarkers(current, target),
		request.maxResultItems,
	);
	const suggestions = bounded(
		(await autoMergeSuggestions(item, snapshot)).filter((suggestion) =>
			rangesOverlap(
				{
					start: suggestion.range[0] - 1,
					end: suggestion.range[1] - 1,
				},
				region.base,
			),
		),
		request.maxResultItems,
	);
	return {
		...compactCurrent(target, possibleConflictHunks, markers),
		...compactSuggestions(suggestions),
	};
}

function addBothAddedContent(
	result: TextConflictResult,
	snapshot: ConflictSnapshot,
	request: GetConflictRequest,
): void {
	const local = boundedBothAddedText(snapshot.lines.local, 2, request);
	const remote = boundedBothAddedText(snapshot.lines.remote, 3, request);
	if (local.text !== null) {
		result.local = local.text;
	}
	if (remote.text !== null) {
		result.remote = remote.text;
	}
	if (local.omitted !== null) {
		result.localOmitted = local.omitted;
	}
	if (remote.omitted !== null) {
		result.remoteOmitted = remote.omitted;
	}
}

function addStageDiffs(
	result: TextConflictResult,
	snapshot: ConflictSnapshot,
	region: ConflictRegion,
	request: GetConflictRequest,
): void {
	const localComparison = createTwoWayComparison(
		snapshot.stages.base,
		snapshot.stages.local,
	);
	const remoteComparison = createTwoWayComparison(
		snapshot.stages.base,
		snapshot.stages.remote,
	);
	const local = boundedDiff({
		baseLines: localComparison.baseLines,
		stageLines: localComparison.targetLines,
		opcodes: localComparison.opcodes,
		baseChange: {
			start: region.changes.local.startA,
			end: region.changes.local.endA,
		},
		stageChange: {
			start: region.changes.local.startB,
			end: region.changes.local.endB,
		},
		stage: 2,
		request,
	});
	const remote = boundedDiff({
		baseLines: remoteComparison.baseLines,
		stageLines: remoteComparison.targetLines,
		opcodes: remoteComparison.opcodes,
		baseChange: {
			start: region.changes.remote.startA,
			end: region.changes.remote.endA,
		},
		stageChange: {
			start: region.changes.remote.startB,
			end: region.changes.remote.endB,
		},
		stage: 3,
		request,
	});
	if (local.diff !== null) {
		result.localDiff = local.diff;
	}
	if (remote.diff !== null) {
		result.remoteDiff = remote.diff;
	}
	if (local.omitted !== null) {
		result.localOmitted = local.omitted;
	}
	if (remote.omitted !== null) {
		result.remoteOmitted = remote.omitted;
	}
}

async function textConflictResult(
	request: GetConflictRequest,
	item: ConflictedItem,
	inspection: TextConflictInspection,
	region: ConflictRegion,
): Promise<TextConflictResult> {
	const context = await conflictContext(
		request,
		item,
		inspection.snapshot,
		region,
	);
	const { suggestions, suggestionsTruncated, ...current } = context;
	const result: TextConflictResult = {
		type: inspection.kind,
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: request.conflictIndex,
		conflictCount: inspection.snapshot.conflictChangeIndexes.length,
		current,
		...(suggestions === undefined
			? {}
			: { autoMergeSuggestions: suggestions }),
		...(suggestionsTruncated === undefined
			? {}
			: { autoMergeSuggestionsTruncated: suggestionsTruncated }),
	};
	if (inspection.kind === "bothAdded") {
		addBothAddedContent(result, inspection.snapshot, request);
	} else {
		addStageDiffs(result, inspection.snapshot, region, request);
	}
	return result;
}

async function getConflict(
	request: GetConflictRequest,
): Promise<GetConflictResult> {
	const item = resolveConflictedItem(request);
	const inspection = await inspectConflict(item);
	if (inspection.kind !== "text" && inspection.kind !== "bothAdded") {
		if (request.conflictIndex !== 0) {
			throw new Error(
				`Conflict index ${request.conflictIndex} is out of range for 1 conflict.`,
			);
		}
		return createNonTextConflictResult(request, inspection.kind);
	}
	if (request.conflictIndex === null) {
		if (inspection.snapshot.conflictChangeIndexes.length > 0) {
			throw new Error(
				"conflictIndex is required when initial Weld conflicts exist.",
			);
		}
		return fileConflictSummary(
			request,
			item,
			inspection.snapshot,
			inspection.kind,
		);
	}
	const region = getConflictRegion(
		inspection.snapshot,
		request.conflictIndex,
	);
	return textConflictResult(request, item, inspection, region);
}

export type {
	ConflictList,
	ConflictLocation,
	GetConflictResult,
	GetConflictToolInput,
	ListedConflict,
};
export {
	createNonTextConflictResult,
	getConflict,
	listConflicts,
	normalizeGetConflictInput,
	resolveConflictedItem,
};
