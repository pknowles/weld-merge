// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { execFile } from "node:child_process";
import { getGitExecutable } from "./gitPath.ts";

const LINE_BREAK_REGEX = /\r?\n/;
const ONE_KILOBYTE = 1024;
const TEN_MEGABYTES = 10 * ONE_KILOBYTE * ONE_KILOBYTE;
const MAX_BUFFER_SIZE = TEN_MEGABYTES;

/**
 * Executes a git command and returns the stdout.
 */
export async function execGit(args: string[], cwd: string): Promise<string> {
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
export async function getConflictedFiles(repoPath: string): Promise<string[]> {
	try {
		const output = await execGit(
			["diff", "--name-only", "--diff-filter=U"],
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
export function getUnresolvedReasons(text: string): string[] {
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
