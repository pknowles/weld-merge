// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Uri, workspace } from "vscode";
import {
	type ConflictRegion,
	type ConflictSnapshot,
	createConflictSnapshot,
	fetchConflictIndexStages,
	fetchConflictStages,
	getConflictRegion,
	getCurrentConflictRegion,
	isBinaryConflict,
	type LineRange,
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
const CURRENT_MAPPING_NOTE =
	"The current region is Weld's diff alignment between the live VS Code document and the Git conflict stages. Merge conflicts can depend on code outside the returned context; request more context or inspect the file when necessary.";

type ConflictKind =
	| "text"
	| "binary"
	| "deletedByUs"
	| "deletedByThem"
	| "bothDeleted"
	| "submodule";
type NonTextConflictKind = Exclude<ConflictKind, "text">;

interface ListedConflict {
	repositoryRoot: string;
	path: string;
	conflictCount: number;
	kind: ConflictKind;
}

interface ConflictList {
	files: ListedConflict[];
}

interface GetConflictToolInput {
	repositoryRoot: string;
	path: string;
	conflictIndex: number;
	contextLines?: number;
}

interface GetConflictRequest {
	repositoryRoot: string;
	path: string;
	conflictIndex: number;
	contextLines: number;
}

interface WireLineRange {
	startLine: number;
	endLineExclusive: number;
}

interface NumberedLine {
	lineNumber: number;
	text: string;
}

interface RegionContent {
	range: WireLineRange;
	lines: NumberedLine[];
	contextBefore: NumberedLine[];
	contextAfter: NumberedLine[];
}

interface StageRegionContent extends RegionContent {
	present: boolean;
}

interface StageChange {
	tag: DiffChunkTag;
	baseRange: WireLineRange;
	stageRange: WireLineRange;
}

interface CurrentChange {
	tag: DiffChunkTag;
	currentRange: WireLineRange;
	stageRange: WireLineRange;
}

interface CurrentRegion extends RegionContent {
	changes: {
		local: CurrentChange[];
		remote: CurrentChange[];
	};
}

interface ConflictResultIdentity {
	type: ConflictKind;
	repositoryRoot: string;
	path: string;
	conflictIndex: number;
	conflictCount: number;
}

interface NonTextConflictResult extends ConflictResultIdentity {
	type: NonTextConflictKind;
	message: string;
}

interface TextConflictBase extends ConflictResultIdentity {
	type: "text";
	note: string;
	base: StageRegionContent;
	local: StageRegionContent;
	remote: StageRegionContent;
	changes: {
		local: StageChange;
		remote: StageChange;
	};
}

interface CurrentDocumentIdentity {
	uri: string;
	version: number;
	isDirty: boolean;
}

type TextConflictResult =
	| (TextConflictBase & {
			currentDocument: CurrentDocumentIdentity & {
				matchesWeldMergedContent: true;
			};
	  })
	| (TextConflictBase & {
			currentDocument: CurrentDocumentIdentity & {
				matchesWeldMergedContent: false;
			};
			current: CurrentRegion;
	  });

type GetConflictResult = TextConflictResult | NonTextConflictResult;

type ConflictInspection =
	| {
			kind: "text";
			snapshot: ConflictSnapshot;
			baseStagePresent: boolean;
	  }
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
	if (!Number.isSafeInteger(input.conflictIndex) || input.conflictIndex < 0) {
		throw new Error("conflictIndex must be a nonnegative safe integer.");
	}
	const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES;
	if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
		throw new Error("contextLines must be a nonnegative safe integer.");
	}
	return {
		repositoryRoot: input.repositoryRoot,
		path: input.path,
		conflictIndex: input.conflictIndex,
		contextLines,
	};
}

function listedConflict(
	conflictedItem: ConflictedItem,
	conflictCount: number,
	kind: ConflictKind,
): ListedConflict {
	return {
		repositoryRoot: conflictedItem.repository.rootUri.toString(),
		path: repositoryRelativePath(
			conflictedItem.repository.rootUri,
			conflictedItem.uri,
		),
		conflictCount,
		kind,
	};
}

async function inspectConflict(
	conflictedItem: ConflictedItem,
): Promise<ConflictInspection> {
	if (
		await isActiveSubmoduleGitlinkConflict(
			conflictedItem.repository,
			conflictedItem.uri,
		)
	) {
		return { kind: "submodule" };
	}

	const indexStages = await fetchConflictIndexStages(conflictedItem);
	if (!indexStages.local && indexStages.remote) {
		return { kind: "deletedByUs" };
	}
	if (indexStages.local && !indexStages.remote) {
		return { kind: "deletedByThem" };
	}
	if (!(indexStages.local || indexStages.remote)) {
		return { kind: "bothDeleted" };
	}
	if (await isBinaryConflict(conflictedItem)) {
		return { kind: "binary" };
	}
	return {
		kind: "text",
		baseStagePresent: indexStages.base,
		snapshot: createConflictSnapshot(
			await fetchConflictStages(conflictedItem),
		),
	};
}

async function listConflicts(): Promise<ConflictList> {
	const conflictedItems = getGitApi()
		.repositories.filter((repository) =>
			isSupportedScheme(repository.rootUri),
		)
		.flatMap((repository) =>
			repository.state.mergeChanges.map((change) =>
				createConflictedItem(repository, change),
			),
		);
	const files = await Promise.all(
		conflictedItems.map(async (conflictedItem) => {
			try {
				const inspection = await inspectConflict(conflictedItem);
				return listedConflict(
					conflictedItem,
					inspection.kind === "text"
						? inspection.snapshot.conflictChangeIndexes.length
						: 1,
					inspection.kind,
				);
			} catch (error: unknown) {
				throw new Error(
					`Failed to inspect conflict ${conflictedItem.uri.toString()}.`,
					{ cause: error },
				);
			}
		}),
	);
	return { files };
}

function resolveConflictedItem(request: GetConflictRequest): ConflictedItem {
	const repository = getGitApi().repositories.find(
		(candidate) =>
			candidate.rootUri.toString() === request.repositoryRoot &&
			isSupportedScheme(candidate.rootUri),
	);
	if (!repository) {
		throw new Error(
			`No open Git repository matches ${request.repositoryRoot}. Call weld_list_conflicts again.`,
		);
	}
	const candidateUri = Uri.joinPath(
		repository.rootUri,
		...request.path.split("/"),
	);
	if (
		repositoryRelativePath(repository.rootUri, candidateUri) !==
		request.path
	) {
		throw new Error("path must be a canonical repository-relative path.");
	}
	const mergeChange = repository.state.mergeChanges.find(
		(change) => change.uri.toString() === candidateUri.toString(),
	);
	if (!mergeChange) {
		throw new Error(
			`${request.path} is not an active conflict in ${request.repositoryRoot}. Call weld_list_conflicts again.`,
		);
	}
	return createConflictedItem(repository, mergeChange);
}

function wireRange(range: LineRange): WireLineRange {
	return {
		startLine: range.start + 1,
		endLineExclusive: range.end + 1,
	};
}

function numberedLines(
	lines: string[],
	start: number,
	end: number,
): NumberedLine[] {
	return lines.slice(start, end).map((text, index) => ({
		lineNumber: start + index + 1,
		text,
	}));
}

function regionContent(
	lines: string[],
	range: LineRange,
	contextLines: number,
): RegionContent {
	return {
		range: wireRange(range),
		lines: numberedLines(lines, range.start, range.end),
		contextBefore: numberedLines(
			lines,
			Math.max(0, range.start - contextLines),
			range.start,
		),
		contextAfter: numberedLines(
			lines,
			range.end,
			Math.min(lines.length, range.end + contextLines),
		),
	};
}

function stageRegionContent(
	lines: string[],
	range: LineRange,
	contextLines: number,
	present: boolean,
): StageRegionContent {
	const content = regionContent(lines, range, contextLines);
	if (present) {
		return { ...content, present: true };
	}
	return {
		...content,
		present: false,
		range: wireRange({ start: 0, end: 0 }),
		lines: [],
		contextBefore: [],
		contextAfter: [],
	};
}

function stageChange(change: DiffChunk): StageChange {
	const stageRange = wireRange({ start: change.startB, end: change.endB });
	return {
		tag: change.tag,
		baseRange: wireRange({ start: change.startA, end: change.endA }),
		stageRange,
	};
}

function currentChange(change: DiffChunk): CurrentChange {
	return {
		tag: change.tag,
		currentRange: wireRange({ start: change.startA, end: change.endA }),
		stageRange: wireRange({ start: change.startB, end: change.endB }),
	};
}

interface TextResultOptions {
	request: GetConflictRequest;
	snapshot: ConflictSnapshot;
	region: ConflictRegion;
	baseStagePresent: boolean;
	currentDocument: CurrentDocumentIdentity & { content: string };
}

function createTextConflictResult(
	options: TextResultOptions,
): TextConflictResult {
	const {
		request,
		snapshot,
		region,
		baseStagePresent,
		currentDocument: { content, ...currentDocument },
	} = options;
	const result = {
		type: "text" as const,
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: request.conflictIndex,
		conflictCount: snapshot.conflictChangeIndexes.length,
		note: CURRENT_MAPPING_NOTE,
		base: stageRegionContent(
			snapshot.lines.base,
			region.base,
			request.contextLines,
			baseStagePresent,
		),
		local: stageRegionContent(
			snapshot.lines.local,
			region.local,
			request.contextLines,
			true,
		),
		remote: stageRegionContent(
			snapshot.lines.remote,
			region.remote,
			request.contextLines,
			true,
		),
		changes: {
			local: stageChange(region.changes.local),
			remote: stageChange(region.changes.remote),
		},
	};
	const current = getCurrentConflictRegion(snapshot, region, content);
	if (current === null) {
		return {
			...result,
			currentDocument: {
				...currentDocument,
				matchesWeldMergedContent: true,
			},
		};
	}
	return {
		...result,
		currentDocument: {
			...currentDocument,
			matchesWeldMergedContent: false,
		},
		current: {
			...regionContent(
				current.lines,
				current.range,
				request.contextLines,
			),
			changes: {
				local: current.changes.local.map(currentChange),
				remote: current.changes.remote.map(currentChange),
			},
		},
	};
}

function nonTextMessage(kind: NonTextConflictKind): string {
	const messages: Record<NonTextConflictKind, string> = {
		binary: "Binary conflicts do not have textual conflict regions.",
		deletedByUs:
			"The local side deleted this file while the remote side modified it.",
		deletedByThem:
			"The remote side deleted this file while the local side modified it.",
		bothDeleted:
			"Both sides deleted this file; no text stages are available.",
		submodule:
			"Submodule conflicts contain Git commit references rather than text regions.",
	};
	return messages[kind];
}

function createNonTextConflictResult(
	request: GetConflictRequest,
	kind: NonTextConflictKind,
): NonTextConflictResult {
	return {
		type: kind,
		repositoryRoot: request.repositoryRoot,
		path: request.path,
		conflictIndex: request.conflictIndex,
		conflictCount: 1,
		message: nonTextMessage(kind),
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
	const region = getConflictRegion(
		inspection.snapshot,
		request.conflictIndex,
	);
	const document = await workspace.openTextDocument(item.uri);
	return createTextConflictResult({
		request,
		snapshot: inspection.snapshot,
		region,
		baseStagePresent: inspection.baseStagePresent,
		currentDocument: {
			uri: item.uri.toString(),
			version: document.version,
			isDirty: document.isDirty,
			content: document.getText(),
		},
	});
}

export type {
	ConflictList,
	GetConflictResult,
	GetConflictToolInput,
	ListedConflict,
};
export {
	createNonTextConflictResult,
	createTextConflictResult,
	getConflict,
	listConflicts,
	normalizeGetConflictInput,
};
