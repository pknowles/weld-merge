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
import { getGitExecutable } from "../gitPath.ts";
import { Differ } from "../matchers/diffutil.ts";
import { Merger } from "../matchers/merge.ts";
import { MyersSequenceMatcher } from "../matchers/myers.ts";
import type { DiffChunk, FileState, WebviewPayload } from "./ui/types.ts";

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

const getGitState = async (
	repoPath: string,
	relativeFilePath: string,
	stage: number,
): Promise<string> => {
	const gitCmd = await getGitExecutable();
	return new Promise<string>((resolve) => {
		execFile(
			gitCmd,
			["show", `:${stage}:${relativeFilePath}`],
			{ cwd: repoPath },
			(err, stdout) => {
				if (err) {
					resolve("");
				} else {
					resolve(stdout);
				}
			},
		);
	});
};

const getCommitInfo = async (
	repoPath: string,
	ref: string,
): Promise<CommitInfo | undefined> => {
	const gitCmd = await getGitExecutable();
	return new Promise((resolve) => {
		execFile(
			gitCmd,
			["log", "-1", "--format=%H%x00%s%x00%an%x00%ae%x00%aI%x00%b", ref],
			{ cwd: repoPath },
			(err, stdout) => {
				if (err) {
					resolve(undefined);
				} else {
					const [
						hash,
						title,
						authorName,
						authorEmail,
						date,
						...bodyParts
					] = stdout.trim().split("\0");
					if (hash && title && authorName && authorEmail && date) {
						resolve({
							hash,
							title,
							authorName,
							authorEmail,
							date,
							body: bodyParts.join("\0"),
						});
					} else {
						resolve(undefined);
					}
				}
			},
		);
	});
};

const getRemoteRef = (repoPath: string): Promise<string | undefined> => {
	const refs = [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"REBASE_HEAD",
	];

	const checkNext = async (index: number): Promise<string | undefined> => {
		const ref = refs[index];
		if (!ref) {
			return;
		}
		const commit = await getCommitInfo(repoPath, ref);
		if (commit) {
			return ref;
		}
		return checkNext(index + 1);
	};

	return checkNext(0);
};

const getBaseCommitInfo = async (repoPath: string) => {
	const remoteRef = await getRemoteRef(repoPath);
	if (!remoteRef) {
		return;
	}

	const gitCmd = await getGitExecutable();
	const mergeBaseHash = await new Promise<string>((resolve) => {
		execFile(
			gitCmd,
			["merge-base", "HEAD", remoteRef],
			{ cwd: repoPath },
			(err, stdout) => {
				if (err) {
					resolve("");
				} else {
					resolve(stdout.trim());
				}
			},
		);
	});

	if (mergeBaseHash) {
		return await getCommitInfo(repoPath, mergeBaseHash);
	}
	return;
};

const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
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
	const initGen = merger.initialize(sequences, sequences);
	let val = initGen.next();
	while (!val.done) {
		val = initGen.next();
	}

	const mergeGen = merger.merge3Files(true);
	let res = mergeGen.next();
	while (!res.done) {
		res = mergeGen.next();
	}
	const result = res.value;
	if (typeof result !== "string") {
		throw new Error("Merge engine failed to produce a result string.");
	}
	return result;
};

const runDiff = (
	localLines: string[],
	mergedLines: string[],
	incomingLines: string[],
) => {
	// Step 2: Initialize the Differ with [Local, Merged, Incoming]
	// This matches Meld's _diff_files() in filediff.py, which runs AFTER
	// _merge_files() has placed the merged text in the middle buffer.
	// set_sequences_iter computes diffs as matcher(sequences[1], sequences[i*2])
	// so the Differ diffs Merged(a) vs Local(b) and Merged(a) vs Incoming(b).
	// The three-way _auto_merge logic naturally produces 'conflict' tags.
	const differ = new Differ();
	const diffSequences = [localLines, mergedLines, incomingLines];
	const diffInit = differ.setSequencesIter(diffSequences);
	let step = diffInit.next();
	while (!step.done) {
		step = diffInit.next();
	}

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

async function buildDiffPayload(
	repoPath: string,
	relativeFilePath: string,
): Promise<WebviewPayload> {
	const [base, local, incoming] = await Promise.all([
		getGitState(repoPath, relativeFilePath, GIT_STAGE_BASE),
		getGitState(repoPath, relativeFilePath, GIT_STAGE_LOCAL),
		getGitState(repoPath, relativeFilePath, GIT_STAGE_REMOTE),
	]);

	const localCommit = await getCommitInfo(repoPath, "HEAD");
	const remoteRef = await getRemoteRef(repoPath);
	const incomingCommit = remoteRef
		? await getCommitInfo(repoPath, remoteRef)
		: undefined;

	const localLines = splitLines(local);
	const baseLines = splitLines(base);
	const incomingLines = splitLines(incoming);

	const mergedContent = runMerge(localLines, baseLines, incomingLines);
	const mergedLines = splitLines(mergedContent);

	const { leftDiffs, rightDiffs } = runDiff(
		localLines,
		mergedLines,
		incomingLines,
	);

	const contents: FileState[] = [
		{ label: "Local", content: local, commit: localCommit },
		{ label: "Merged", content: mergedContent },
		{ label: "Remote", content: incoming, commit: incomingCommit },
	];

	return {
		command: "loadDiff",
		data: {
			files: contents,
			diffs: [leftDiffs, rightDiffs],
		},
	} as WebviewPayload;
}

async function buildBaseDiffPayload(
	repoPath: string,
	relativeFilePath: string,
	side: "left" | "right",
) {
	// Base is stage 1, Local is 2, Remote is 3
	const targetStage = side === "left" ? GIT_STAGE_LOCAL : GIT_STAGE_REMOTE;
	const [base, target] = await Promise.all([
		getGitState(repoPath, relativeFilePath, GIT_STAGE_BASE),
		getGitState(repoPath, relativeFilePath, targetStage),
	]);

	const baseCommit = await getBaseCommitInfo(repoPath);

	const baseLines = splitLines(base);
	const targetLines = splitLines(target);

	// We only need a 2-way diff for this.
	// For left side (Base -> Local), a=Base, b=Local
	// For right side (Remote <- Base), a=Remote, b=Base
	const seqA = side === "left" ? baseLines : targetLines;
	const seqB = side === "left" ? targetLines : baseLines;

	const matcher = new MyersSequenceMatcher(null, seqA, seqB);
	const work = matcher.initialize();
	while (true) {
		const next = work.next();
		if (next.done) {
			break;
		}
	}

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
	buildDiffPayload,
	buildBaseDiffPayload,
	getGitState,
	GIT_STAGE_BASE,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
};
