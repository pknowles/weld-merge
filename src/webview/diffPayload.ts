// Copyright (C) 2002-2006 Stephen Kennedy <stevek@gnome.org>
// Copyright (C) 2009-2019 Kai Willadsen <kai.willadsen@gmail.com>
// Copyright (C) 2026 Pyarelal Knowles
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 2 of the License, or (at
// your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Uri } from "vscode";
import { getGitExecutable } from "../gitPath.ts";
import { GIT_STATUS_BOTH_ADDED, readConflictState } from "../gitUtils.ts";
import { Differ } from "../matchers/diffutil.ts";
import { Merger } from "../matchers/merge.ts";
import { MyersSequenceMatcher } from "../matchers/myers.ts";
import type { GitApiRepository, RepoContext } from "../repoContext.ts";
import type { DiffChunk, PayloadFiles, WebviewPayload } from "./ui/types.ts";

const GIT_STAGE_BASE = 1;
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;

interface CommitInfo {
	hash: string;
	title: string;
	authorName: string;
	authorEmail: string;
	date: string;
	body: string;
}

interface ConflictStages {
	base: string;
	local: string;
	incoming: string;
}

interface ConflictLabels {
	localLabel: string;
	baseLabel: string;
	remoteLabel: string;
}

interface BuildDiffPayloadOptions {
	stages?: ConflictStages;
	// The merged pane text that the user will edit and that syncs to the file
	// on disk. On first open this is seeded by runMerge(); on re-runs (e.g.
	// after an external .git state change) the caller passes the live
	// TextDocument text so diffs align with what the user currently sees.
	workingContent?: string;
}

const getGitState = async (
	repository: GitApiRepository,
	file: Uri,
	stage: number,
): Promise<string> => repository.show(`:${stage}`, file.fsPath);

const getCommitInfo = async (
	repository: GitApiRepository,
	ref: string,
): Promise<CommitInfo> => {
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
};

// Returns null only for the genuinely expected absence case: the repo is not
// in an active merge/cherry-pick/rebase operation. Any other failure (fs error
// reading .git state, etc.) propagates as a thrown exception from
// readConflictState, so callers can distinguish absent from failed.
const getRemoteRef = async (
	repository: GitApiRepository,
): Promise<string | null> => {
	const conflictState = await readConflictState(repository);
	return conflictState?.otherRef ?? null;
};

const getBaseCommitInfo = async (
	repository: GitApiRepository,
): Promise<CommitInfo | undefined> => {
	const remoteRef = await getRemoteRef(repository);
	if (remoteRef === null) {
		return;
	}
	const mergeBaseHash = await repository.getMergeBase("HEAD", remoteRef);
	if (!mergeBaseHash) {
		return;
	}
	return await getCommitInfo(repository, mergeBaseHash);
};

const runMerge = (
	localLines: string[],
	baseLines: string[],
	incomingLines: string[],
): string => {
	// Step 1: Run the Merger to produce merged text with (??) conflict markers
	// This matches Meld's _merge_files() in filediff.py
	const merger = new Merger();
	const sequences = [localLines, baseLines, incomingLines];
	merger.initialize(sequences, sequences);
	return merger.merge3Files(true);
};

const runDiff = (
	localLines: string[],
	workingLines: string[],
	incomingLines: string[],
) => {
	// Step 2: Initialize the Differ with [Local, Merged, Incoming]
	// This matches Meld's _diff_files() in filediff.py, which runs AFTER
	// _merge_files() has placed the merged text in the middle buffer.
	// set_sequences_iter computes diffs as matcher(sequences[1], sequences[i*2])
	// so the Differ diffs Merged(a) vs Local(b) and Merged(a) vs Incoming(b).
	// The three-way _auto_merge logic naturally produces 'conflict' tags.
	const differ = new Differ();
	const diffSequences = [localLines, workingLines, incomingLines];
	differ.setSequences(diffSequences);

	// Extract from _merge_cache, not differ.diffs.
	// differ.diffs is raw Myers output (replace/insert/delete/equal only).
	// conflict tags only exist in _mergeCache, produced by _mergeDiffs/_autoMerge.
	// This matches what Meld's pair_changes() method yields for rendering.
	// _mergeCache[i] = [chunk_for_diffs0 | null, chunk_for_diffs1 | null]
	// These chunks have a=Merged(pane1), b=Outer(Local or Incoming).
	const leftDiffs = differ._mergeCache
		.map((pair) => pair[0])
		.filter((c): c is DiffChunk => c !== null);
	const rightDiffs = differ._mergeCache
		.map((pair) => pair[1])
		.filter((c): c is DiffChunk => c !== null);

	return { leftDiffs, rightDiffs };
};

async function fetchConflictStages(
	repository: GitApiRepository,
	file: Uri,
): Promise<ConflictStages> {
	const isBothAdded =
		repository.state.mergeChanges.find((c) => c.uri.fsPath === file.fsPath)
			?.status === GIT_STATUS_BOTH_ADDED;
	const [base, local, incoming] = await Promise.all([
		isBothAdded ? "" : getGitState(repository, file, GIT_STAGE_BASE),
		getGitState(repository, file, GIT_STAGE_LOCAL),
		getGitState(repository, file, GIT_STAGE_REMOTE),
	]);
	return { base, local, incoming };
}

async function buildInitialConflictedState(
	repoUri: Uri,
	stages: ConflictStages,
	labels: ConflictLabels,
): Promise<string> {
	// Re-run git merge-file with the same labels from the working file markers
	// to reproduce git's original conflicted text for byte-for-byte comparison.
	// git merge-file requires real files on disk, so this helper creates a
	// temporary directory and always removes it in the finally block.
	const tempDir = await mkdtemp(join(tmpdir(), "weld-"));
	const localPath = join(tempDir, "local");
	const basePath = join(tempDir, "base");
	const remotePath = join(tempDir, "remote");

	try {
		await writeFile(localPath, stages.local);
		await writeFile(basePath, stages.base);
		await writeFile(remotePath, stages.incoming);

		return await new Promise<string>((resolve, reject) => {
			execFile(
				getGitExecutable(),
				[
					"merge-file",
					"-p",
					"-L",
					labels.localLabel,
					"-L",
					labels.baseLabel,
					"-L",
					labels.remoteLabel,
					localPath,
					basePath,
					remotePath,
				],
				{ cwd: repoUri.fsPath },
				(err, stdout, stderr) => {
					// git-merge-file documents: 0 = clean merge, 1..127 = conflict count,
					// and negative values indicate errors. In Node callbacks these error
					// codes are surfaced as unsigned exit codes (>=128), so treat >=128
					// as real failure and keep 0..127 as valid stdout-producing results.
					// Source: https://git-scm.com/docs/git-merge-file
					if (err && ((err as { code?: number }).code ?? 0) >= 128) {
						reject(
							new Error(
								`git merge-file failed for ${repoUri}: ${stderr || err.message}`,
							),
						);
						return;
					}
					resolve(stdout);
				},
			);
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function buildDiffPayload(
	repoContext: RepoContext,
	file: Uri,
	options: BuildDiffPayloadOptions = {},
): Promise<WebviewPayload["data"]> {
	const { repository } = repoContext;
	const stages =
		options.stages ?? (await fetchConflictStages(repository, file));
	const { base, local, incoming } = stages;

	const [localCommit, remoteRef] = await Promise.all([
		getCommitInfo(repository, "HEAD"),
		getRemoteRef(repository),
	]);
	const incomingCommit =
		remoteRef === null
			? undefined
			: await getCommitInfo(repository, remoteRef);

	const localLines = local.split("\n");
	const baseLines = base.split("\n");
	const incomingLines = incoming.split("\n");

	const workingContent =
		options.workingContent ??
		runMerge(localLines, baseLines, incomingLines);
	// Diffs are computed against the exact working-pane content we will render.
	// This keeps hunk actions/highlights aligned with what the user sees.
	const workingLines = workingContent.split("\n");

	const { leftDiffs, rightDiffs } = runDiff(
		localLines,
		workingLines,
		incomingLines,
	);

	const contents: PayloadFiles = [
		{ label: "Local", content: local, commit: localCommit },
		{ label: "Merged", content: workingContent },
		{ label: "Remote", content: incoming, commit: incomingCommit },
	];

	return {
		files: contents,
		diffs: [leftDiffs, rightDiffs],
		isConflicted: true,
	};
}

async function buildBaseDiffPayload(
	repoContext: RepoContext,
	file: Uri,
	side: "left" | "right",
) {
	const { repository } = repoContext;
	// Base is stage 1, Local is 2, Remote is 3
	const targetStage = side === "left" ? GIT_STAGE_LOCAL : GIT_STAGE_REMOTE;
	const [base, target] = await Promise.all([
		getGitState(repository, file, GIT_STAGE_BASE),
		getGitState(repository, file, targetStage),
	]);

	const baseCommit = await getBaseCommitInfo(repository);

	const baseLines = base.split("\n");
	const targetLines = target.split("\n");

	// We only need a 2-way diff for this.
	// For left side (Base -> Local), a=Base, b=Local
	// For right side (Remote <- Base), a=Remote, b=Base
	const seqA = side === "left" ? baseLines : targetLines;
	const seqB = side === "left" ? targetLines : baseLines;

	const matcher = new MyersSequenceMatcher(null, seqA, seqB);
	matcher.initialize();

	const diffs = matcher.getDifferenceOpcodes();

	return {
		command: "loadBaseDiff",
		data: {
			side,
			file: {
				label: "Base",
				content: base,
				commit: baseCommit,
			},
			diffs,
		},
	};
}

export {
	buildBaseDiffPayload,
	buildDiffPayload,
	buildInitialConflictedState,
	fetchConflictStages,
};
