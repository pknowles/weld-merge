// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitExecutable } from "./gitPath.ts";
import {
	execGit,
	readConflictState,
	repositoryRelativePath,
} from "./gitUtils.ts";
import { Merger } from "./matchers/merge.ts";
import { type DiffChunk, MyersSequenceMatcher } from "./matchers/myers.ts";
import {
	createThreeWayChanges,
	type ThreeWayChange,
} from "./matchers/threeWayDiff.ts";
import type { ConflictedItem, GitApiRepository } from "./repoContext.ts";
import { GitStatus } from "./repoContext.ts";

const GIT_STAGE_BASE = 1;
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;
const LINE_BREAK_REGEX = /\r?\n/u;
const INDEX_STAGE_ENTRY_REGEX = /^\d{6} [0-9a-fA-F]{40,64} ([123])\t/u;

interface ConflictStages {
	base: string;
	local: string;
	remote: string;
}

interface CommitInfo {
	hash: string;
	title: string;
	authorName: string;
	authorEmail: string;
	date: string;
	body: string;
}

interface ConflictSnapshot {
	stages: ConflictStages;
	lines: {
		base: string[];
		local: string[];
		remote: string[];
	};
	mergedContent: string;
	changes: ThreeWayChange[];
	conflictChangeIndexes: number[];
}

interface LineRange {
	start: number;
	end: number;
}

interface ConflictRegion {
	base: LineRange;
	local: LineRange;
	remote: LineRange;
	changes: {
		local: DiffChunk;
		remote: DiffChunk;
	};
}

interface ConflictIndexStages {
	base: boolean;
	local: boolean;
	remote: boolean;
}

interface TwoWayComparison {
	baseLines: string[];
	targetLines: string[];
	opcodes: DiffChunk[];
}

interface ThreeWayComparison {
	localLines: string[];
	middleLines: string[];
	remoteLines: string[];
	changes: ThreeWayChange[];
}

/**
 * The canonical two-way line matching used by Weld's base comparison views.
 *
 * Consumers may select or render a bounded projection, but must not recompute
 * matching on an independently sliced pair of inputs.
 */
function twoWayChanges(base: string[], target: string[]): DiffChunk[] {
	return new MyersSequenceMatcher<string>(null, base, target).getOpcodes();
}

/** Source model for Weld's base comparison views and compact agent projections. */
function createTwoWayComparison(
	base: string,
	target: string,
): TwoWayComparison {
	const baseLines = base.split("\n");
	const targetLines = target.split("\n");
	return {
		baseLines,
		targetLines,
		opcodes: twoWayChanges(baseLines, targetLines),
	};
}

/** Source model shared by the GUI three-way view and live-disk tool mapping. */
function createThreeWayComparison(
	local: string,
	middle: string,
	remote: string,
): ThreeWayComparison {
	const localLines = local.split("\n");
	const middleLines = middle.split("\n");
	const remoteLines = remote.split("\n");
	return {
		localLines,
		middleLines,
		remoteLines,
		changes: createThreeWayChanges({
			local: localLines,
			middle: middleLines,
			remote: remoteLines,
		}),
	};
}

function getGitState(
	repository: GitApiRepository,
	file: ConflictedItem["uri"],
	stage: number,
): Promise<string> {
	return repository.show(`:${stage}`, file.fsPath);
}

async function getCommitInfo(
	repository: GitApiRepository,
	ref: string,
): Promise<CommitInfo> {
	const commit = await repository.getCommit(ref);
	const [title = "", ...bodyLines] = commit.message.split("\n");
	return {
		hash: commit.hash,
		title,
		authorName: commit.authorName ?? "",
		authorEmail: commit.authorEmail ?? "",
		date: (commit.authorDate ?? new Date(0)).toISOString(),
		body: bodyLines.join("\n"),
	};
}

async function getRemoteRef(
	repository: GitApiRepository,
): Promise<string | null> {
	const conflictState = await readConflictState(repository);
	return conflictState?.otherRef ?? null;
}

async function getBaseCommitInfo(
	repository: GitApiRepository,
): Promise<CommitInfo | undefined> {
	const remoteRef = await getRemoteRef(repository);
	if (remoteRef === null) {
		return;
	}
	const mergeBaseHash = await repository.getMergeBase("HEAD", remoteRef);
	if (!mergeBaseHash) {
		return;
	}
	return getCommitInfo(repository, mergeBaseHash);
}

async function createGitMergeFileContent(
	cwd: string,
	stages: ConflictStages,
	labels: [string, string, string],
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "weld-"));
	const localPath = join(directory, "local");
	const basePath = join(directory, "base");
	const remotePath = join(directory, "remote");
	try {
		await Promise.all([
			writeFile(localPath, stages.local),
			writeFile(basePath, stages.base),
			writeFile(remotePath, stages.remote),
		]);
		return await new Promise<string>((resolve, reject) => {
			execFile(
				getGitExecutable(),
				[
					"merge-file",
					"-p",
					"-L",
					labels[0],
					"-L",
					labels[1],
					"-L",
					labels[2],
					localPath,
					basePath,
					remotePath,
				],
				{ cwd },
				(error, stdout, stderr) => {
					const exitCode =
						(error as { code?: number } | null)?.code ?? 0;
					if (error && exitCode >= 128) {
						reject(
							new Error(
								`git merge-file failed in ${cwd}: ${stderr || error.message}`,
							),
						);
						return;
					}
					resolve(stdout);
				},
			);
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function fetchConflictStages(
	conflictedItem: ConflictedItem,
): Promise<ConflictStages> {
	const { repository, uri } = conflictedItem;
	const isBothAdded =
		conflictedItem.mergeChange?.status === GitStatus.BOTH_ADDED;
	const [base, local, remote] = await Promise.all([
		isBothAdded ? "" : getGitState(repository, uri, GIT_STAGE_BASE),
		getGitState(repository, uri, GIT_STAGE_LOCAL),
		getGitState(repository, uri, GIT_STAGE_REMOTE),
	]);
	return { base, local, remote };
}

async function fetchConflictIndexStages(
	conflictedItem: ConflictedItem,
): Promise<ConflictIndexStages> {
	const { repository, uri } = conflictedItem;
	const path = repositoryRelativePath(repository.rootUri, uri);
	const output = await execGit(
		["ls-files", "--stage", "--", path],
		repository.rootUri.fsPath,
	);
	const stages = new Set<number>();
	for (const line of output.split(LINE_BREAK_REGEX).filter(Boolean)) {
		const match = INDEX_STAGE_ENTRY_REGEX.exec(line);
		if (!match?.[1]) {
			throw new Error(
				`Cannot inspect conflict stages for ${uri.toString()}: malformed index entry.`,
			);
		}
		const stage = Number(match[1]);
		if (stages.has(stage)) {
			throw new Error(
				`Cannot inspect conflict stages for ${uri.toString()}: duplicate stage ${stage}.`,
			);
		}
		stages.add(stage);
	}
	if (stages.size === 0) {
		throw new Error(
			`Cannot inspect conflict stages for ${uri.toString()}: no unmerged index entries.`,
		);
	}
	const result = {
		base: stages.has(GIT_STAGE_BASE),
		local: stages.has(GIT_STAGE_LOCAL),
		remote: stages.has(GIT_STAGE_REMOTE),
	};
	if (!(result.base || (result.local && result.remote))) {
		throw new Error(
			`Cannot inspect conflict stages for ${uri.toString()}: invalid unmerged index shape.`,
		);
	}
	return result;
}

function createConflictSnapshot(stages: ConflictStages): ConflictSnapshot {
	const lines = {
		base: stages.base.split("\n"),
		local: stages.local.split("\n"),
		remote: stages.remote.split("\n"),
	};
	const sequences = [lines.local, lines.base, lines.remote];
	const merger = new Merger();
	merger.initialize(sequences, sequences);
	const changes = merger.differ.allChanges();
	const conflictChangeIndexes = merger.differ.conflicts.slice();
	const mergedContent = merger.merge3Files(true);
	return { stages, lines, mergedContent, changes, conflictChangeIndexes };
}

function expandSideRange(
	chunk: DiffChunk,
	base: LineRange,
	sideLineCount: number,
): LineRange {
	const range = {
		start: chunk.startB - (chunk.startA - base.start),
		end: chunk.endB + (base.end - chunk.endA),
	};
	if (
		range.start < 0 ||
		range.end < range.start ||
		range.end > sideLineCount
	) {
		throw new Error(
			"Conflict chunk expansion produced an invalid side range.",
		);
	}
	return range;
}

function getConflictRegion(
	snapshot: ConflictSnapshot,
	conflictIndex: number,
): ConflictRegion {
	if (!Number.isSafeInteger(conflictIndex) || conflictIndex < 0) {
		throw new Error("Conflict index must be a nonnegative safe integer.");
	}
	const changeIndex = snapshot.conflictChangeIndexes[conflictIndex];
	if (changeIndex === undefined) {
		throw new Error(
			`Conflict index ${conflictIndex} is out of range for ${snapshot.conflictChangeIndexes.length} conflict(s).`,
		);
	}
	const change = snapshot.changes[changeIndex];
	if (!(change?.[0] && change[1])) {
		throw new Error(
			`Conflict index ${conflictIndex} does not contain both local and remote chunks.`,
		);
	}
	const [localChange, remoteChange] = change;
	const base = {
		start: Math.min(localChange.startA, remoteChange.startA),
		end: Math.max(localChange.endA, remoteChange.endA),
	};
	return {
		base,
		local: expandSideRange(localChange, base, snapshot.lines.local.length),
		remote: expandSideRange(
			remoteChange,
			base,
			snapshot.lines.remote.length,
		),
		changes: { local: localChange, remote: remoteChange },
	};
}

function rangesOverlap(left: LineRange, right: LineRange): boolean {
	if (left.start === left.end && right.start === right.end) {
		return left.start === right.start;
	}
	if (left.start === left.end) {
		return left.start >= right.start && left.start < right.end;
	}
	if (right.start === right.end) {
		return right.start >= left.start && right.start < left.end;
	}
	return left.start < right.end && right.start < left.end;
}

async function isBinaryConflict(
	conflictedItem: ConflictedItem,
): Promise<boolean> {
	const { repository, uri } = conflictedItem;
	const path = repositoryRelativePath(repository.rootUri, uri);
	const output = await execGit(
		["diff", "--numstat", `:2:${path}`, `:3:${path}`],
		repository.rootUri.fsPath,
	);
	const lines = output
		.split(LINE_BREAK_REGEX)
		.filter((line) => line.length > 0);
	if (lines.length !== 1) {
		throw new Error(
			`Cannot classify binary conflict for ${uri.toString()}: expected one numstat line, got ${lines.length}.`,
		);
	}
	const fields = lines[0]?.split("\t");
	if (!fields || fields.length !== 3) {
		throw new Error(
			`Cannot classify binary conflict for ${uri.toString()}: malformed numstat output.`,
		);
	}
	const [added, deleted] = fields;
	if ((added === "-") !== (deleted === "-")) {
		throw new Error(
			`Cannot classify binary conflict for ${uri.toString()}: inconsistent numstat output.`,
		);
	}
	return added === "-";
}

export type {
	CommitInfo,
	ConflictRegion,
	ConflictSnapshot,
	ConflictStages,
	LineRange,
};
export {
	createConflictSnapshot,
	createGitMergeFileContent,
	createThreeWayComparison,
	createTwoWayComparison,
	fetchConflictIndexStages,
	fetchConflictStages,
	GIT_STAGE_BASE,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	getBaseCommitInfo,
	getCommitInfo,
	getConflictRegion,
	getGitState,
	getRemoteRef,
	isBinaryConflict,
	rangesOverlap,
};
