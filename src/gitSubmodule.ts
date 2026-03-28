// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { extensions, Uri } from "vscode";
import { execGit } from "./gitUtils.ts";

const UNMERGED_INFO_REGEX = /^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/;
const STRIP_WHITESPACE_REGEX = /\s+/;

function parseStage(
	shas: { base: string; local: string; remote: string },
	sha: string,
	stage: number,
) {
	if (stage === 1) {
		shas.base = sha;
	} else if (stage === 2) {
		shas.local = sha;
	} else if (stage === 3) {
		shas.remote = sha;
	}
}

function parseUnmergedLines(lines: string[]): {
	base: string;
	local: string;
	remote: string;
} {
	const shas = { base: "", local: "", remote: "" };
	for (const line of lines) {
		const match = line.match(UNMERGED_INFO_REGEX);
		if (match) {
			const sha = match[2];
			const stageStr = match[3];
			if (sha && stageStr) {
				parseStage(shas, sha, Number.parseInt(stageStr, 10));
			}
		}
	}
	return shas;
}

interface GitRepository {
	rootUri: Uri;
	log(options?: {
		maxEntries?: number;
		range?: string;
		grep?: string;
	}): Promise<GitCommit[]>;
	getCommit(ref: string): Promise<GitCommit>;
	diffBetween(ref1: string, ref2: string): Promise<unknown[]>;
}

interface GitAPI {
	repositories: GitRepository[];
	toGitUri(uri: Uri, ref: string): Uri;
}

interface GitCommit {
	hash: string;
	message: string;
	authorName?: string;
	authorEmail?: string;
	authorDate?: Date;
	committerName?: string;
	committerEmail?: string;
	committerDate?: Date;
	parents: string[];
}

/**
 * Gets the 3 staged SHAs for a conflicted submodule from the parent repository.
 */
export async function getStagedSubmoduleShas(
	repoPath: string,
	submodulePath: string,
): Promise<{ base: string; local: string; remote: string }> {
	try {
		const output = await execGit(
			["ls-files", "-u", "--stage", "--", submodulePath],
			repoPath,
		);
		const lines = output
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);

		const shas = parseUnmergedLines(lines);

		if (!(shas.local || shas.remote)) {
			throw new Error("Submodule not in conflicted state or not found.");
		}
		return shas;
	} catch (e: unknown) {
		const error = e as Error;
		throw new Error(
			`Failed to get staged submodule SHAs: ${error.message}`,
		);
	}
}

/**
 * Stages a specific commit for a submodule in the parent repository's index.
 */
export async function stageSubmoduleCommit(
	repoPath: string,
	submodulePath: string,
	sha: string,
): Promise<void> {
	try {
		// Then precisely set the SHA the user selected
		await execGit(
			["update-index", "--force-remove", submodulePath],
			repoPath,
		);
		await execGit(
			[
				"update-index",
				"--add",
				"--cacheinfo",
				"160000",
				sha,
				submodulePath,
			],
			repoPath,
		);
	} catch (e: unknown) {
		const error = e as Error;
		throw new Error(`Failed to stage submodule: ${error.message}`);
	}
}

/**
 * Finds the VSCode Git extension API.
 */
export async function getGitApi(): Promise<GitAPI | undefined> {
	const gitExtension = extensions.getExtension("vscode.git");
	if (!gitExtension) {
		return;
	}
	if (!gitExtension.isActive) {
		await gitExtension.activate();
	}
	return gitExtension.exports.getAPI(1);
}

/**
 * Finds the repository object for a given filesystem path.
 */
export function getRepoForPath(
	gitApi: GitAPI,
	fsPath: string,
): GitRepository | undefined {
	const uriStr = Uri.file(fsPath).toString();
	return gitApi.repositories.find((r) => r.rootUri.toString() === uriStr);
}

/**
 * Gets the list of files changed in a specific commit.
 */
export async function getCommitFiles(
	repoPath: string,
	sha: string,
): Promise<{ path: string; status: string }[]> {
	try {
		// git diff-tree --no-commit-id --name-status -r <sha>
		const output = await execGit(
			["diff-tree", "--no-commit-id", "--name-status", "-r", sha],
			repoPath,
		);
		return output
			.trim()
			.split("\n")
			.filter((l) => l.length > 0)
			.map((line) => {
				const [status, path] = line.split(STRIP_WHITESPACE_REGEX);
				return { path: path || "", status: status || "" };
			});
	} catch (e: unknown) {
		const error = e as Error;
		throw new Error(`Failed to get commit files: ${error.message}`);
	}
}

/**
 * Finds the common ancestor (merge-base) of two commits.
 */
export async function getMergeBase(
	repoPath: string,
	sha1: string,
	sha2: string,
): Promise<string> {
	try {
		const output = await execGit(["merge-base", sha1, sha2], repoPath);
		return output.trim();
	} catch (e: unknown) {
		const error = e as Error;
		throw new Error(`Failed to get merge base: ${error.message}`);
	}
}

/**
 * Restores a conflicted state for a submodule that was previously resolved.
 */
export async function restoreSubmoduleConflict(
	repoPath: string,
	submodulePath: string,
): Promise<void> {
	const getSha = async (name: string) => {
		try {
			const out = await execGit(
				["rev-parse", "--verify", name],
				repoPath,
			);
			return out.trim();
		} catch {
			return null;
		}
	};

	const localCommit = (await getSha("HEAD")) || "";
	const remoteCandidates = [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REBASE_HEAD",
		"REVERT_HEAD",
	];
	const remoteShas = await Promise.all(
		remoteCandidates.map((r) => getSha(r)),
	);
	const remoteCommit = remoteShas.find(Boolean) || "";

	if (!(localCommit && remoteCommit)) {
		throw new Error(
			"Could not find local (HEAD) and remote commits for conflict restoration.",
		);
	}

	const baseCommit = await getMergeBase(repoPath, localCommit, remoteCommit);

	const getSubmoduleSha = async (commit: string) => {
		try {
			const out = await execGit(
				["rev-parse", "--verify", `${commit}:${submodulePath}`],
				repoPath,
			);
			return out.trim();
		} catch {
			return null;
		}
	};

	const [baseSha, localSha, remoteSha] = await Promise.all([
		getSubmoduleSha(baseCommit),
		getSubmoduleSha(localCommit),
		getSubmoduleSha(remoteCommit),
	]);

	if (localSha === null && remoteSha === null) {
		throw new Error(
			`Could not find submodule entries in local or remote commits for ${submodulePath}`,
		);
	}

	// Prepare index info for git update-index
	let indexInfo = "";
	if (baseSha) {
		indexInfo += `160000 ${baseSha} 1\t${submodulePath}\n`;
	}
	if (localSha) {
		indexInfo += `160000 ${localSha} 2\t${submodulePath}\n`;
	}
	if (remoteSha) {
		indexInfo += `160000 ${remoteSha} 3\t${submodulePath}\n`;
	}

	try {
		// First remove the resolved entry from the index if it exists
		await execGit(
			["rm", "--cached", "--quiet", "--", submodulePath],
			repoPath,
		);
	} catch {
		// Ignore if it's already not there
	}

	// Unusually complicated: Unlike regular files, 'git checkout -m' fails for submodules.
	// We must manually reconstruct the 3-way conflict in the index by providing
	// the specific gitlink SHAs (mode 160000) for base (1), ours (2), and theirs (3)
	// stages using the low-level update-index command.
	await execGit(["update-index", "--index-info"], repoPath, indexInfo);
}
