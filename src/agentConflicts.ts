// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Uri, workspace } from "vscode";
import {
	type CommitInfo,
	type ConflictRegion,
	type ConflictSnapshot,
	createConflictSnapshot,
	createThreeWayComparison,
	createTwoWayComparison,
	fetchConflictIndexStages,
	fetchConflictStages,
	getBaseCommitInfo,
	getCommitInfo,
	getConflictRegion,
	getRemoteRef,
	isBinaryConflict,
	type LineRange,
	rangesOverlap,
} from "./conflictSnapshot.ts";
import { execGit, repositoryRelativePath } from "./gitUtils.ts";
import type { DiffChunk } from "./matchers/myers.ts";
import {
	type ConflictedItem,
	createConflictedItem,
	getGitApi,
	isSupportedScheme,
} from "./repoContext.ts";
import { isActiveSubmoduleGitlinkConflict } from "./submoduleConflict.ts";

const DEFAULT_CONTEXT_LINES = 5;
const DEFAULT_MAX_SECTION_LINES = 40;
const DEFAULT_INLINE_CONFLICT_LINES = 40;
const STRAY_MARKER_LIMIT = 50;
const CONFLICT_SENTINEL_REGEX = /\(\?\?\)/u;
const MARKER_START_REGEX = /^<+(?:\s|$)/u;
const MARKER_END_REGEX = /^>+(?:\s|$)/u;
const MARKER_MIDDLE_REGEX = /^(\|+|=+)(?:\s|$)/u;
// name-rev output containing these is an approximation (e.g. "main~3"), not a
// real branch/tag name; such names are omitted rather than sent as noise.
const APPROXIMATE_REF_REGEX = /[~^]/u;

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

interface CommitId {
	hash: string;
	ref?: string;
	title: string;
}

/** One-based [startLine, endLineExclusive) in the file on disk. */
type DiskRange = [startLine: number, endLineExclusive: number];

interface StrayMarker {
	range: DiskRange;
	kind: "gitMarker" | "weldSentinel";
}

/**
 * One rendered conflict. `text` is a generated diff3-style marker block with
 * surrounding context lines; the opening marker label repeats the disk
 * location so the mapping is unambiguous inside the text itself.
 */
interface ConflictBlock {
	index: number;
	/** Disk lines the agent's resolution replaces; absent when unmappable. */
	range?: DiskRange;
	/** Present instead of `range` when the conflict no longer maps to disk. */
	note?: string;
	text: string;
	/**
	 * Present only when the file on disk differs from the auto-merge result
	 * near this conflict: the same alternatives with auto-merge context. It
	 * has no file location; it shows the expected surroundings.
	 */
	autoMergeView?: string;
	/**
	 * Base→Local and Base→Remote unified diffs for this conflict's region,
	 * present only when the request opted in (`includeBaseDiffs`). Optional
	 * because the alternatives in `text` already convey what changed; these
	 * are the same "compare with base" data the UI's buttons show, for the
	 * harder conflicts where the diff highlights the change more clearly
	 * than reading two full sections side by side.
	 */
	localDiff?: string;
	remoteDiff?: string;
}

interface ListedConflict extends ConflictLocation {
	conflictCount: number;
	kind: ConflictKind;
	commits: { base?: CommitId; local: CommitId; remote?: CommitId };
	/**
	 * Marker syntax or Weld `(??)` sentinels found on disk. During an active
	 * merge these may belong to unresolved conflicts; once all conflicts are
	 * resolved, any remaining entry is stray and needs attention.
	 */
	strayMarkers?: StrayMarker[];
	strayMarkersTruncated?: true;
	/** Present when every conflict fit the inline budget. */
	conflicts?: ConflictBlock[];
}

interface ConflictList {
	files: ListedConflict[];
}

interface ListConflictsToolInput {
	inlineConflictLines?: number;
}

interface GetConflictToolInput extends ConflictLocation {
	conflicts?: [number, number] | null;
	contextLines?: number;
	maxSectionLines?: number;
	includeBaseDiffs?: boolean;
}

interface GetConflictRequest extends ConflictLocation {
	conflicts: [number, number] | null;
	contextLines: number;
	maxSectionLines: number;
	includeBaseDiffs: boolean;
}

interface TextConflictResult extends ConflictLocation {
	type: TextConflictKind;
	conflictCount: number;
	conflicts: ConflictBlock[];
}

interface NonTextConflictResult extends ConflictLocation {
	type: NonTextConflictKind;
	conflictCount: 1;
	message: string;
}

type GetConflictResult = TextConflictResult | NonTextConflictResult;

type ConflictInspection =
	| { kind: TextConflictKind; snapshot: ConflictSnapshot }
	| { kind: NonTextConflictKind };

type TextConflictInspection = Extract<
	ConflictInspection,
	{ kind: TextConflictKind }
>;

function normalizeListConflictsInput(input: ListConflictsToolInput): {
	inlineConflictLines: number;
} {
	const inlineConflictLines =
		input.inlineConflictLines ?? DEFAULT_INLINE_CONFLICT_LINES;
	if (!Number.isSafeInteger(inlineConflictLines) || inlineConflictLines < 0) {
		throw new Error(
			"inlineConflictLines must be a nonnegative safe integer.",
		);
	}
	return { inlineConflictLines };
}

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
	const conflicts = input.conflicts ?? null;
	if (conflicts !== null && !validConflictRange(conflicts)) {
		throw new Error(
			"conflicts must be a [first, last] pair of nonnegative safe integers with first <= last.",
		);
	}
	const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
	const maxSectionLines = input.maxSectionLines ?? DEFAULT_MAX_SECTION_LINES;
	if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
		throw new Error("contextLines must be a nonnegative safe integer.");
	}
	if (!Number.isSafeInteger(maxSectionLines) || maxSectionLines < 0) {
		throw new Error("maxSectionLines must be a nonnegative safe integer.");
	}
	return {
		repositoryRoot: input.repositoryRoot,
		path: input.path,
		conflicts,
		contextLines,
		maxSectionLines,
		includeBaseDiffs: input.includeBaseDiffs === true,
	};
}

function validConflictRange(conflicts: [number, number]): boolean {
	return (
		Array.isArray(conflicts) &&
		conflicts.length === 2 &&
		Number.isSafeInteger(conflicts[0]) &&
		Number.isSafeInteger(conflicts[1]) &&
		conflicts[0] >= 0 &&
		conflicts[0] <= conflicts[1]
	);
}

async function headRefName(
	repositoryFsPath: string,
): Promise<string | undefined> {
	const name = (
		await execGit(["branch", "--show-current"], repositoryFsPath)
	).trim();
	return name === "" ? undefined : name;
}

async function commitRefName(
	repositoryFsPath: string,
	hash: string,
): Promise<string | undefined> {
	const name = (
		await execGit(["name-rev", "--name-only", hash], repositoryFsPath)
	).trim();
	if (
		name === "" ||
		name === "undefined" ||
		APPROXIMATE_REF_REGEX.test(name)
	) {
		return;
	}
	return name;
}

function commitId(commit: CommitInfo, ref: string | undefined): CommitId {
	const { hash, title } = commit;
	return { hash, title, ...(ref === undefined ? {} : { ref }) };
}

async function repositoryCommits(
	item: ConflictedItem,
): Promise<ListedConflict["commits"]> {
	const repositoryFsPath = item.repository.rootUri.fsPath;
	const [local, localRef, remoteRef, base] = await Promise.all([
		getCommitInfo(item.repository, "HEAD"),
		headRefName(repositoryFsPath),
		getRemoteRef(item.repository),
		getBaseCommitInfo(item.repository),
	]);
	const remote =
		remoteRef === null
			? undefined
			: await getCommitInfo(item.repository, remoteRef);
	const [remoteName, baseName] = await Promise.all([
		remote === undefined
			? undefined
			: commitRefName(repositoryFsPath, remote.hash),
		base === undefined
			? undefined
			: commitRefName(repositoryFsPath, base.hash),
	]);
	return {
		...(base === undefined ? {} : { base: commitId(base, baseName) }),
		local: commitId(local, localRef),
		...(remote === undefined
			? {}
			: { remote: commitId(remote, remoteName) }),
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
		snapshot: createConflictSnapshot(await fetchConflictStages(item)),
	};
}

// Kinds whose working-tree file exists as readable text; the other kinds have
// no file on disk (deleted/both-deleted), are binary, or are a directory.
const DISK_READABLE_KINDS = new Set<ConflictKind>([
	"text",
	"bothAdded",
	"deletedByThem",
]);

async function readDiskContent(item: ConflictedItem): Promise<string> {
	try {
		return new TextDecoder().decode(await workspace.fs.readFile(item.uri));
	} catch (error: unknown) {
		throw new Error(`Failed to read ${item.uri.toString()} from disk.`, {
			cause: error,
		});
	}
}

function diskRange(range: LineRange): DiskRange {
	return [range.start + 1, range.end + 1];
}

function scanMarkers(current: string): StrayMarker[] {
	const markers: StrayMarker[] = [];
	let markerStart: number | null = null;
	const lines = current.split("\n");
	for (const [index, text] of lines.entries()) {
		if (CONFLICT_SENTINEL_REGEX.test(text)) {
			markers.push({
				range: diskRange({ start: index, end: index + 1 }),
				kind: "weldSentinel",
			});
		}
		if (MARKER_START_REGEX.test(text)) {
			if (markerStart !== null) {
				markers.push({
					range: diskRange({ start: markerStart, end: index }),
					kind: "gitMarker",
				});
			}
			markerStart = index;
			continue;
		}
		if (markerStart !== null && MARKER_END_REGEX.test(text)) {
			markers.push({
				range: diskRange({ start: markerStart, end: index + 1 }),
				kind: "gitMarker",
			});
			markerStart = null;
			continue;
		}
		if (markerStart === null && MARKER_MIDDLE_REGEX.test(text)) {
			markers.push({
				range: diskRange({ start: index, end: index + 1 }),
				kind: "gitMarker",
			});
		}
	}
	if (markerStart !== null) {
		markers.push({
			range: diskRange({ start: markerStart, end: lines.length }),
			kind: "gitMarker",
		});
	}
	return markers;
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

// The same three-way comparison the GUI computes for its merged pane (see
// buildDiffPayload); the middle may be the file on disk or the regenerated
// auto-merge result. Returned pairs are the conflict-tagged changes only,
// with middle coordinates in each chunk's A range.
function conflictChanges(
	snapshot: ConflictSnapshot,
	middle: string,
): [DiffChunk | null, DiffChunk | null][] {
	return createThreeWayComparison(
		snapshot.stages.local,
		middle,
		snapshot.stages.remote,
	).changes.filter(
		([local, remote]) =>
			local?.tag === "conflict" || remote?.tag === "conflict",
	);
}

function regionHunks(
	changes: [DiffChunk | null, DiffChunk | null][],
	region: ConflictRegion,
): LineRange[] {
	return changes
		.filter(([local, remote]) => hunkOverlapsRegion(local, remote, region))
		.map(([local, remote]) => hunkRange(local, remote));
}

/**
 * Interior ellipsis for a section longer than `maxSectionLines`: keep the
 * head and tail, elide the middle, and state the elided one-based inclusive
 * line numbers in `label`'s file so locations stay clear exactly where
 * content is missing.
 */
function sectionLines(
	lines: string[],
	range: LineRange,
	label: "local" | "base" | "remote",
	maxSectionLines: number,
): string[] {
	const content = lines.slice(range.start, range.end);
	const keep = Math.max(1, Math.floor(maxSectionLines / 2));
	if (content.length <= maxSectionLines || content.length <= keep * 2) {
		return content;
	}
	return [
		...content.slice(0, keep),
		`... ${content.length - keep * 2} lines elided (${label} ${range.start + keep + 1}-${range.end - keep}) ...`,
		...content.slice(content.length - keep),
	];
}

// Context lines never cross a Weld `(??)` sentinel or a conflict-marker
// line: sentinels encode "auto-merge has no answer here", and a neighboring
// conflict's markers are not the final surrounding text an edit must fit.
// (A non-marker line that merely looks like one, e.g. a Markdown "==="
// underline, at worst shortens the context; it never corrupts it.)
function contextStopLine(line: string): boolean {
	return (
		CONFLICT_SENTINEL_REGEX.test(line) ||
		MARKER_START_REGEX.test(line) ||
		MARKER_END_REGEX.test(line) ||
		MARKER_MIDDLE_REGEX.test(line)
	);
}

function contextAround(
	lines: string[],
	range: LineRange,
	contextLines: number,
): { before: string[]; after: string[] } {
	const beforeAll = lines.slice(
		Math.max(0, range.start - contextLines),
		range.start,
	);
	const lastStop = beforeAll.findLastIndex(contextStopLine);
	const afterAll = lines.slice(
		range.end,
		Math.min(lines.length, range.end + contextLines),
	);
	const firstStop = afterAll.findIndex(contextStopLine);
	return {
		before: lastStop === -1 ? beforeAll : beforeAll.slice(lastStop + 1),
		after: firstStop === -1 ? afterAll : afterAll.slice(0, firstStop),
	};
}

function unifiedDiffRangeStart(start: number, count: number): number {
	return count === 0 ? start : start + 1;
}

interface BaseDiffInput {
	opcodes: DiffChunk[];
	baseLines: string[];
	targetLines: string[];
	baseRange: LineRange;
	targetRange: LineRange;
	contextLines: number;
}

// Renders a standard unified diff over the shared Base-vs-target opcodes
// (the same ones buildBaseDiffPayload's "compare with base" panels use),
// selecting only the opcodes overlapping this conflict's region plus up to
// `contextLines` of a single adjacent equal opcode on each side. Never
// crosses into a neighboring change: a fixed-line-count window could
// otherwise walk past this conflict's boundary into an unrelated one.
function renderBaseDiff({
	opcodes,
	baseLines,
	targetLines,
	baseRange,
	targetRange,
	contextLines,
}: BaseDiffInput): string {
	const changeIndexes = opcodes.flatMap((opcode, index) =>
		opcode.tag !== "equal" &&
		rangesOverlap({ start: opcode.startA, end: opcode.endA }, baseRange) &&
		rangesOverlap({ start: opcode.startB, end: opcode.endB }, targetRange)
			? [index]
			: [],
	);
	const firstChange = changeIndexes[0];
	const lastChange = changeIndexes.at(-1);
	if (firstChange === undefined || lastChange === undefined) {
		throw new Error(
			"Could not find the conflict change in the shared diff.",
		);
	}
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
				...targetLines
					.slice(opcode.startB, opcode.endB)
					.map((line) => `+${line}`),
			);
		}
	}
	const baseLength = last.endA - first.startA;
	const targetLength = last.endB - first.startB;
	return [
		`@@ -${unifiedDiffRangeStart(first.startA, baseLength)},${baseLength} +${unifiedDiffRangeStart(first.startB, targetLength)},${targetLength} @@`,
		...body,
	].join("\n");
}

function addBaseDiffs(
	block: ConflictBlock,
	snapshot: ConflictSnapshot,
	region: ConflictRegion,
	contextLines: number,
): void {
	const localComparison = createTwoWayComparison(
		snapshot.stages.base,
		snapshot.stages.local,
	);
	const remoteComparison = createTwoWayComparison(
		snapshot.stages.base,
		snapshot.stages.remote,
	);
	block.localDiff = renderBaseDiff({
		opcodes: localComparison.opcodes,
		baseLines: localComparison.baseLines,
		targetLines: localComparison.targetLines,
		baseRange: region.base,
		targetRange: region.local,
		contextLines,
	});
	block.remoteDiff = renderBaseDiff({
		opcodes: remoteComparison.opcodes,
		baseLines: remoteComparison.baseLines,
		targetLines: remoteComparison.targetLines,
		baseRange: region.base,
		targetRange: region.remote,
		contextLines,
	});
}

function locationLabel(range: DiskRange): string {
	const [start, endExclusive] = range;
	return endExclusive > start
		? ` replaces lines ${start}-${endExclusive - 1}`
		: ` inserts before line ${start}`;
}

function renderBlockText(args: {
	before: string[];
	after: string[];
	local: string[];
	base: string[] | null;
	remote: string[];
	location: string;
}): string {
	return [
		...args.before,
		`<<<<<<< LOCAL${args.location}`,
		...args.local,
		...(args.base === null ? [] : ["||||||| BASE", ...args.base]),
		"=======",
		...args.remote,
		">>>>>>> REMOTE",
		...args.after,
	].join("\n");
}

function sameContext(
	left: { before: string[]; after: string[] },
	right: { before: string[]; after: string[] },
): boolean {
	return (
		left.before.length === right.before.length &&
		left.after.length === right.after.length &&
		left.before.every((line, index) => line === right.before[index]) &&
		left.after.every((line, index) => line === right.after[index])
	);
}

interface FileConflictContext {
	snapshot: ConflictSnapshot;
	kind: TextConflictKind;
	diskLines: string[];
	diskChanges: [DiffChunk | null, DiffChunk | null][];
	mergedLines: string[];
	mergedChanges: [DiffChunk | null, DiffChunk | null][];
	contextLines: number;
	maxSectionLines: number;
	includeBaseDiffs: boolean;
}

function fileConflictContext(
	snapshot: ConflictSnapshot,
	kind: TextConflictKind,
	diskContent: string,
	options: {
		contextLines: number;
		maxSectionLines: number;
		includeBaseDiffs: boolean;
	},
): FileConflictContext {
	return {
		snapshot,
		kind,
		diskLines: diskContent.split("\n"),
		diskChanges: conflictChanges(snapshot, diskContent),
		mergedLines: snapshot.mergedContent.split("\n"),
		mergedChanges: conflictChanges(snapshot, snapshot.mergedContent),
		contextLines: options.contextLines,
		maxSectionLines: options.maxSectionLines,
		includeBaseDiffs: options.includeBaseDiffs,
	};
}

function buildConflictBlock(
	context: FileConflictContext,
	index: number,
): ConflictBlock {
	const { snapshot, kind } = context;
	const region = getConflictRegion(snapshot, index);
	const local = sectionLines(
		snapshot.lines.local,
		region.local,
		"local",
		context.maxSectionLines,
	);
	const base =
		kind === "text"
			? sectionLines(
					snapshot.lines.base,
					region.base,
					"base",
					context.maxSectionLines,
				)
			: null;
	const remote = sectionLines(
		snapshot.lines.remote,
		region.remote,
		"remote",
		context.maxSectionLines,
	);
	const mergedHunks = regionHunks(context.mergedChanges, region);
	const mergedHunk = mergedHunks[0];
	if (mergedHunks.length !== 1 || !mergedHunk) {
		throw new Error(
			`Conflict ${index} did not map to exactly one region of the auto-merge result.`,
		);
	}
	const mergedContext = contextAround(
		context.mergedLines,
		mergedHunk,
		context.contextLines,
	);
	const diskHunks = regionHunks(context.diskChanges, region);
	const diskHunk = diskHunks[0];
	if (diskHunks.length !== 1 || !diskHunk) {
		return {
			index,
			note:
				diskHunks.length === 0
					? "This conflict no longer maps to the file on disk; read the file before editing. Context shown is the auto-merge result."
					: "This conflict maps to multiple regions of the file on disk; read the file before editing. Context shown is the auto-merge result.",
			text: renderBlockText({
				...mergedContext,
				local,
				base,
				remote,
				location: "",
			}),
		};
	}
	const range = diskRange(diskHunk);
	const diskContext = contextAround(
		context.diskLines,
		diskHunk,
		context.contextLines,
	);
	const block: ConflictBlock = {
		index,
		range,
		text: renderBlockText({
			...diskContext,
			local,
			base,
			remote,
			location: locationLabel(range),
		}),
		...(sameContext(diskContext, mergedContext)
			? {}
			: {
					autoMergeView: renderBlockText({
						...mergedContext,
						local,
						base,
						remote,
						location: "",
					}),
				}),
	};
	if (context.includeBaseDiffs && kind === "text") {
		addBaseDiffs(block, snapshot, region, context.contextLines);
	}
	return block;
}

async function fileConflictBlocks(
	item: ConflictedItem,
	inspection: TextConflictInspection,
	range: [number, number] | null,
	options: {
		contextLines: number;
		maxSectionLines: number;
		includeBaseDiffs: boolean;
	},
): Promise<ConflictBlock[]> {
	const count = inspection.snapshot.conflictChangeIndexes.length;
	const [first, last] = range ?? [0, count - 1];
	if (range !== null && last >= count) {
		throw new Error(
			`Conflict range [${first}, ${last}] is out of range for ${count} conflict(s).`,
		);
	}
	if (count === 0) {
		return [];
	}
	const context = fileConflictContext(
		inspection.snapshot,
		inspection.kind,
		await readDiskContent(item),
		options,
	);
	return Array.from({ length: last - first + 1 }, (_, offset) =>
		buildConflictBlock(context, first + offset),
	);
}

async function strayMarkerReport(
	item: ConflictedItem,
	kind: ConflictKind,
): Promise<Pick<ListedConflict, "strayMarkers" | "strayMarkersTruncated">> {
	if (!DISK_READABLE_KINDS.has(kind)) {
		return {};
	}
	const markers = bounded(
		scanMarkers(await readDiskContent(item)),
		STRAY_MARKER_LIMIT,
	);
	return {
		...(markers.items.length === 0 ? {} : { strayMarkers: markers.items }),
		...(markers.truncated ? { strayMarkersTruncated: true } : {}),
	};
}

function blockLineCount(blocks: ConflictBlock[]): number {
	return blocks.reduce(
		(total, block) =>
			total +
			block.text.split("\n").length +
			(block.autoMergeView === undefined
				? 0
				: block.autoMergeView.split("\n").length),
		0,
	);
}

async function listConflicts(
	input: ListConflictsToolInput = {},
): Promise<ConflictList> {
	const { inlineConflictLines } = normalizeListConflictsInput(input);
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
	const files = await Promise.all(
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
				const isText =
					inspection.kind === "text" ||
					inspection.kind === "bothAdded";
				const blocks = isText
					? await fileConflictBlocks(item, inspection, null, {
							contextLines: DEFAULT_CONTEXT_LINES,
							maxSectionLines: DEFAULT_MAX_SECTION_LINES,
							includeBaseDiffs: false,
						})
					: [];
				return {
					listed: {
						repositoryRoot: item.repository.rootUri.toString(),
						path: repositoryRelativePath(
							item.repository.rootUri,
							item.uri,
						),
						conflictCount: isText ? blocks.length : 1,
						kind: inspection.kind,
						commits: await commits,
						...(await strayMarkerReport(item, inspection.kind)),
					} satisfies ListedConflict,
					blocks,
				};
			} catch (error: unknown) {
				throw new Error(
					`Failed to inspect conflict ${item.uri.toString()}.`,
					{ cause: error },
				);
			}
		}),
	);
	// Opportunistic inline: when every conflict in the workspace fits the
	// budget together, one list call carries everything a resolution needs.
	const totalLines = files.reduce(
		(total, file) => total + blockLineCount(file.blocks),
		0,
	);
	const inline = totalLines > 0 && totalLines <= inlineConflictLines;
	return {
		files: files.map(({ listed, blocks }) => ({
			...listed,
			...(inline && blocks.length > 0 ? { conflicts: blocks } : {}),
		})),
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
	location: ConflictLocation,
	type: NonTextConflictKind,
): NonTextConflictResult {
	return {
		type,
		repositoryRoot: location.repositoryRoot,
		path: location.path,
		conflictCount: 1,
		message: nonTextMessage(type),
	};
}

async function getConflict(
	request: GetConflictRequest,
): Promise<GetConflictResult> {
	const item = resolveConflictedItem(request);
	const inspection = await inspectConflict(item);
	if (inspection.kind !== "text" && inspection.kind !== "bothAdded") {
		if (request.conflicts !== null && request.conflicts[1] > 0) {
			throw new Error(
				`Conflict range [${request.conflicts[0]}, ${request.conflicts[1]}] is out of range for 1 conflict.`,
			);
		}
		return createNonTextConflictResult(request, inspection.kind);
	}
	return {
		type: inspection.kind,
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictCount: inspection.snapshot.conflictChangeIndexes.length,
		conflicts: await fileConflictBlocks(
			item,
			inspection,
			request.conflicts,
			request,
		),
	};
}

export type {
	BaseDiffInput,
	ConflictList,
	ConflictLocation,
	GetConflictResult,
	GetConflictToolInput,
	ListConflictsToolInput,
	ListedConflict,
	NonTextConflictKind,
};
export {
	createNonTextConflictResult,
	getConflict,
	listConflicts,
	nonTextMessage,
	normalizeGetConflictInput,
	renderBaseDiff,
	resolveConflictedItem,
};
