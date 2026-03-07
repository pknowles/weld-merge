// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import * as cp from "node:child_process";
import { getGitExecutable } from "./gitPath";

/**
 * Executes a git command and returns the stdout.
 */
export async function execGit(args: string[], cwd: string): Promise<string> {
	const cmd = await getGitExecutable();
	return new Promise((resolve, reject) => {
		cp.execFile(
			cmd,
			args,
			{ cwd, maxBuffer: 1024 * 1024 * 10 },
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
	} catch (_e) {
		return [];
	}
}
