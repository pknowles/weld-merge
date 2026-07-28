// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Uri, workspace } from "vscode";
import {
	type CommitInfo,
	type ConflictSnapshot,
	createConflictSnapshot,
	createGitMergeFileContent,
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
import { createThreeWayChanges } from "./matchers/threeWayDiff.ts";
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
	| "binary"
	| "deletedByUs"
	| "deletedByThem"
	| "bothDeleted"
	| "submodule";
type NonTextConflictKind = Exclude<ConflictKind, "text">;

interface ConflictLocation {
	repositoryRoot: string;
	path: string;
}

interface CommitMetadata {
	hash: string;
	title: string;
	authorName: string;
	authorEmail: string;
	date: string;
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

interface WireLineRange {
	startLine: number;
	endLineExclusive: number;
}

interface NumberedLine {
	lineNumber: number;
	text: string;
}

interface RawGitAccess {
	stage: 1 | 2 | 3;
	command: string;
}

interface StageRegionContent {
	present: boolean;
	range: WireLineRange;
	lines: NumberedLine[];
	contextBefore: NumberedLine[];
	contextAfter: NumberedLine[];
	/** True when any requested region or context content was omitted. */
	truncated: boolean;
	/** Present exactly when truncated is true, so callers can retrieve omissions. */
	rawGitAccess: RawGitAccess | null;
}

interface StageChange {
	tag: DiffChunkTag;
	baseRange: WireLineRange;
	stageRange: WireLineRange;
}

interface CurrentHunk {
	range: WireLineRange;
	changes: { local: DiffChunkTag | null; remote: DiffChunkTag | null };
}

interface ConflictMarker {
	range: WireLineRange;
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
	type: "text";
	base: StageRegionContent;
	local: StageRegionContent;
	remote: StageRegionContent;
	changes: { local: StageChange; remote: StageChange };
	current: {
		unresolvedHunks: CurrentHunk[];
		unresolvedHunksTruncated: boolean;
		conflictMarkers: ConflictMarker[];
		conflictMarkersTruncated: boolean;
	};
	autoMergeSuggestions: CurrentHunk[];
	autoMergeSuggestionsTruncated: boolean;
}

interface FileConflictSummary extends ConflictResultIdentity {
	type: "text";
	conflictIndex: null;
	conflictCount: 0;
	current: TextConflictResult["current"];
	autoMergeSuggestions: CurrentHunk[];
	autoMergeSuggestionsTruncated: boolean;
}

type GetConflictResult =
	| TextConflictResult
	| FileConflictSummary
	| NonTextConflictResult;

type ConflictInspection =
	| { kind: "text"; snapshot: ConflictSnapshot; baseStagePresent: boolean }
	| { kind: NonTextConflictKind };

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
	const { hash, title, authorName, authorEmail, date } = commit;
	return { hash, title, authorName, authorEmail, date };
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
	return {
		kind: "text",
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
						inspection.kind === "text"
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

function wireRange(range: LineRange): WireLineRange {
	return { startLine: range.start + 1, endLineExclusive: range.end + 1 };
}

function numberedLines(
	lines: string[],
	start: number,
	end: number,
): NumberedLine[] {
	return lines
		.slice(start, end)
		.map((text, index) => ({ lineNumber: start + index + 1, text }));
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function stageContent(
	lines: string[],
	range: LineRange,
	stage: 1 | 2 | 3,
	present: boolean,
	request: GetConflictRequest,
): StageRegionContent {
	if (!present) {
		return {
			present: false,
			range: wireRange({ start: 0, end: 0 }),
			lines: [],
			contextBefore: [],
			contextAfter: [],
			truncated: false,
			rawGitAccess: null,
		};
	}
	const regionTruncated = range.end - range.start > request.maxStageLines;
	const regionLineCount = regionTruncated ? 0 : range.end - range.start;
	const contextBudget = Math.max(0, request.maxStageLines - regionLineCount);
	const availableBefore = Math.min(request.contextLines, range.start);
	const availableAfter = Math.min(
		request.contextLines,
		lines.length - range.end,
	);
	const totalContextLines = Math.min(
		contextBudget,
		availableBefore + availableAfter,
	);
	let beforeContextLines = Math.min(
		availableBefore,
		Math.floor(totalContextLines / 2),
	);
	let afterContextLines = Math.min(
		availableAfter,
		totalContextLines - beforeContextLines,
	);
	const remainingContextLines =
		totalContextLines - beforeContextLines - afterContextLines;
	beforeContextLines += Math.min(
		availableBefore - beforeContextLines,
		remainingContextLines,
	);
	afterContextLines += Math.min(
		availableAfter - afterContextLines,
		totalContextLines - beforeContextLines - afterContextLines,
	);
	const truncated =
		regionTruncated ||
		beforeContextLines < availableBefore ||
		afterContextLines < availableAfter;
	return {
		present: true,
		range: wireRange(range),
		lines: regionTruncated
			? []
			: numberedLines(lines, range.start, range.end),
		contextBefore: numberedLines(
			lines,
			Math.max(0, range.start - beforeContextLines),
			range.start,
		),
		contextAfter: numberedLines(
			lines,
			range.end,
			Math.min(lines.length, range.end + afterContextLines),
		),
		truncated,
		rawGitAccess: truncated
			? {
					stage,
					command: `git -C ${shellQuote(Uri.parse(request.repositoryRoot).fsPath)} show ${shellQuote(`:${stage}:${request.path}`)}`,
				}
			: null,
	};
}

function stageChange(change: DiffChunk): StageChange {
	return {
		tag: change.tag,
		baseRange: wireRange({ start: change.startA, end: change.endA }),
		stageRange: wireRange({ start: change.startB, end: change.endB }),
	};
}

function hunkFromChanges(
	local: DiffChunk | null,
	remote: DiffChunk | null,
): CurrentHunk {
	const range = hunkRange(local, remote);
	return {
		range: wireRange(range),
		changes: { local: local?.tag ?? null, remote: remote?.tag ?? null },
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

function currentHunks(
	snapshot: ConflictSnapshot,
	current: string,
): CurrentHunk[] {
	return createThreeWayChanges({
		local: snapshot.lines.local,
		middle: current.split("\n"),
		remote: snapshot.lines.remote,
	})
		.filter(
			([local, remote]) =>
				local?.tag === "conflict" || remote?.tag === "conflict",
		)
		.map(([local, remote]) => hunkFromChanges(local, remote));
}

function conflictMarkers(current: string): ConflictMarker[] {
	const markers: ConflictMarker[] = [];
	let inMarkerBlock = false;
	for (const [index, text] of current.split("\n").entries()) {
		const isStart = MARKER_START_REGEX.test(text);
		const isEnd = MARKER_END_REGEX.test(text);
		const isMiddle = inMarkerBlock && MARKER_MIDDLE_REGEX.test(text);
		if (
			isStart ||
			isMiddle ||
			isEnd ||
			CONFLICT_SENTINEL_REGEX.test(text)
		) {
			markers.push({
				range: { startLine: index + 1, endLineExclusive: index + 2 },
				text,
			});
		}
		if (isStart) {
			inMarkerBlock = true;
		}
		if (isEnd) {
			inMarkerBlock = false;
		}
	}
	return markers;
}

async function autoMergeSuggestions(
	item: ConflictedItem,
	snapshot: ConflictSnapshot,
): Promise<CurrentHunk[]> {
	const mergeFile = await createGitMergeFileContent(
		item.repository.rootUri.fsPath,
		snapshot.stages,
		["LOCAL", "BASE", "REMOTE"],
	);
	const markerRanges = markerBodyRanges(mergeFile);
	if (markerRanges.length === 0) {
		return [];
	}
	const gitConflictBaseRanges = createThreeWayChanges({
		local: snapshot.lines.base,
		middle: mergeFile.split("\n"),
		remote: snapshot.lines.base,
	})
		.filter(([local, remote]) =>
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
		.map(([local, remote]) => hunkFromChanges(local, remote));
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

async function fileConflictSummary(
	request: GetConflictRequest,
	item: ConflictedItem,
	snapshot: ConflictSnapshot,
): Promise<FileConflictSummary> {
	const current = new TextDecoder().decode(
		await workspace.fs.readFile(item.uri),
	);
	const unresolvedHunks = bounded(
		currentHunks(snapshot, current),
		request.maxResultItems,
	);
	const markers = bounded(conflictMarkers(current), request.maxResultItems);
	const suggestions = bounded(
		await autoMergeSuggestions(item, snapshot),
		request.maxResultItems,
	);
	return {
		type: "text",
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: null,
		conflictCount: 0,
		current: {
			unresolvedHunks: unresolvedHunks.items,
			unresolvedHunksTruncated: unresolvedHunks.truncated,
			conflictMarkers: markers.items,
			conflictMarkersTruncated: markers.truncated,
		},
		autoMergeSuggestions: suggestions.items,
		autoMergeSuggestionsTruncated: suggestions.truncated,
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

async function getConflict(
	request: GetConflictRequest,
): Promise<GetConflictResult> {
	const item = resolveConflictedItem(request);
	const inspection = await inspectConflict(item);
	if (inspection.kind !== "text") {
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
		return fileConflictSummary(request, item, inspection.snapshot);
	}
	const region = getConflictRegion(
		inspection.snapshot,
		request.conflictIndex,
	);
	const current = new TextDecoder().decode(
		await workspace.fs.readFile(item.uri),
	);
	const unresolvedHunks = bounded(
		currentHunks(inspection.snapshot, current),
		request.maxResultItems,
	);
	const markers = bounded(conflictMarkers(current), request.maxResultItems);
	const suggestions = bounded(
		await autoMergeSuggestions(item, inspection.snapshot),
		request.maxResultItems,
	);
	return {
		type: "text",
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: request.conflictIndex,
		conflictCount: inspection.snapshot.conflictChangeIndexes.length,
		base: stageContent(
			inspection.snapshot.lines.base,
			region.base,
			1,
			inspection.baseStagePresent,
			request,
		),
		local: stageContent(
			inspection.snapshot.lines.local,
			region.local,
			2,
			true,
			request,
		),
		remote: stageContent(
			inspection.snapshot.lines.remote,
			region.remote,
			3,
			true,
			request,
		),
		changes: {
			local: stageChange(region.changes.local),
			remote: stageChange(region.changes.remote),
		},
		current: {
			unresolvedHunks: unresolvedHunks.items,
			unresolvedHunksTruncated: unresolvedHunks.truncated,
			conflictMarkers: markers.items,
			conflictMarkersTruncated: markers.truncated,
		},
		autoMergeSuggestions: suggestions.items,
		autoMergeSuggestionsTruncated: suggestions.truncated,
	};
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
