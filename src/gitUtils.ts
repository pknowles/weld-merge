// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getGitExecutable } from "./gitPath.ts";

const LINE_BREAK_REGEX = /\r?\n/;
const ONE_KILOBYTE = 1024;
const TEN_MEGABYTES = 10 * ONE_KILOBYTE * ONE_KILOBYTE;
const MAX_BUFFER_SIZE = TEN_MEGABYTES;

type ConflictOperation =
	| "merge"
	| "cherry-pick"
	| "revert"
	| "rebase-merge"
	| "rebase-apply";

interface ConflictState {
	operation: ConflictOperation;
	otherRef: "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD";
}

const CONFLICT_STATE_FILES: Array<{
	operation: ConflictOperation;
	statePath: string;
	otherRef: ConflictState["otherRef"];
}> = [
	// Order matters: prefer merge/cherry-pick/revert heads before rebase
	// directory sentinels so we resolve to the most specific active operation.
	{ operation: "merge", statePath: "MERGE_HEAD", otherRef: "MERGE_HEAD" },
	{
		operation: "cherry-pick",
		statePath: "CHERRY_PICK_HEAD",
		otherRef: "CHERRY_PICK_HEAD",
	},
	{ operation: "revert", statePath: "REVERT_HEAD", otherRef: "REVERT_HEAD" },
	{
		operation: "rebase-merge",
		statePath: "rebase-merge",
		otherRef: "REBASE_HEAD",
	},
	{
		operation: "rebase-apply",
		statePath: "rebase-apply",
		otherRef: "REBASE_HEAD",
	},
];

const gitDirByRepoPath: Map<string, string> = new Map();

async function getGitDir(repoPath: string): Promise<string> {
	const cachedGitDir = gitDirByRepoPath.get(repoPath);
	if (cachedGitDir) {
		return cachedGitDir;
	}

	const rawGitDir = (
		await execGit(["rev-parse", "--git-dir"], repoPath)
	).trim();
	if (!rawGitDir) {
		throw new Error(`Could not resolve git dir for ${repoPath}.`);
	}

	const gitDir = isAbsolute(rawGitDir)
		? rawGitDir
		: resolve(repoPath, rawGitDir);
	gitDirByRepoPath.set(repoPath, gitDir);
	return gitDir;
}

async function readConflictState(
	repoPath: string,
): Promise<ConflictState | undefined> {
	const gitDir = await getGitDir(repoPath);
	for (const conflictState of CONFLICT_STATE_FILES) {
		if (existsSync(join(gitDir, conflictState.statePath))) {
			return {
				operation: conflictState.operation,
				otherRef: conflictState.otherRef,
			};
		}
	}
	return;
}

/**
 * Executes a git command and returns the stdout.
 */
async function execGit(args: string[], cwd: string): Promise<string> {
	const cmd = await getGitExecutable();
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ cwd, maxBuffer: MAX_BUFFER_SIZE },
			(err, stdout) => {
				if (err) {
					reject(err);
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

/**
 * Gets the list of currently conflicted files in a repository.
 */
async function getConflictedFiles(repoPath: string): Promise<string[]> {
	try {
		const output = await execGit(
			["diff", "--name-only", "--diff-filter=U", "--"],
			repoPath,
		);
		return output
			.trim()
			.split("\n")
			.filter((f) => f);
	} catch {
		return [];
	}
}

/**
 * Checks for unresolved merge conflict markers or (??) markers.
 */
function getUnresolvedReasons(text: string): string[] {
	const reasons: string[] = [];
	const lines = text.split(LINE_BREAK_REGEX);
	const conflictMarkers = ["<<<<<<<", "=======", ">>>>>>>", "|||||||"];

	let hasConflict = false;
	let hasQuestion = false;

	for (const line of lines) {
		if (!hasConflict && conflictMarkers.some((m) => line.startsWith(m))) {
			hasConflict = true;
			reasons.push("merge conflict markers");
		}
		if (!hasQuestion && line.startsWith("(??)")) {
			hasQuestion = true;
			reasons.push("(??) markers");
		}
		if (hasConflict && hasQuestion) {
			break;
		}
	}
	return reasons;
}

export {
	execGit,
	getConflictedFiles,
	getGitDir,
	getUnresolvedReasons,
	readConflictState,
};
