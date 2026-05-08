import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Uri } from "vscode";
import type { GitApiRepository } from "../../../src/repoContext.ts";
import { getGitApi } from "../../../src/repoContext.ts";

function runGit(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
	}).trim();
}

async function makeRepo(prefix: string): Promise<string> {
	const repoPath = await mkdtemp(join(tmpdir(), prefix));
	runGit(["init"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	await writeFile(join(repoPath, "tracked.txt"), "base\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "init"], repoPath);
	return repoPath;
}

async function makeRepoFile(
	repoPath: string,
	relativePath: string,
): Promise<Uri> {
	const filePath = join(repoPath, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, "content\n");
	return Uri.file(filePath);
}

async function openRepoInGitExtension(repoPath: string): Promise<void> {
	const gitApi = await getGitApi();
	const opened = await gitApi.openRepository(Uri.file(repoPath));
	if (!opened) {
		throw new Error(
			`Expected Git extension to open repository at ${repoPath}`,
		);
	}
}

// Creates a merge conflict on tracked.txt in repoPath.
// After makeRepo(), tracked.txt = "base\n". This function:
//   - creates branch 'other', sets tracked.txt = "remote\n", commits
//   - switches back, sets tracked.txt = "local\n", commits
//   - runs `git merge other` which exits with code 1 (conflict expected)
// Result: stage 1 = "base\n", stage 2 = "local\n", stage 3 = "remote\n"
function makeConflict(repoPath: string): void {
	runGit(["checkout", "-b", "other"], repoPath);
	writeFileSync(join(repoPath, "tracked.txt"), "remote\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "remote change"], repoPath);
	runGit(["checkout", "-"], repoPath);
	writeFileSync(join(repoPath, "tracked.txt"), "local\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "local change"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits 1 for a conflict — expected
	}
}

// Creates a second conflict on the same repo after makeConflict + merge --abort.
// At that point HEAD = "local change" commit (tracked.txt = "local\n").
// This function:
//   - creates branch 'other2', sets tracked.txt = "remote2\n", commits
//   - switches back, sets tracked.txt = "local2\n", commits
//   - runs `git merge other2`
// Result: stage 1 = "local\n", stage 2 = "local2\n", stage 3 = "remote2\n"
function makeSecondConflict(repoPath: string): void {
	runGit(["checkout", "-b", "other2"], repoPath);
	writeFileSync(join(repoPath, "tracked.txt"), "remote2\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "remote2 change"], repoPath);
	runGit(["checkout", "-"], repoPath);
	writeFileSync(join(repoPath, "tracked.txt"), "local2\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "local2 change"], repoPath);
	try {
		runGit(["merge", "other2"], repoPath);
	} catch {
		// git exits 1 for a conflict — expected
	}
}

// Waits for the git extension to fire onDidCloseRepository for repoPath.
// Subscribe BEFORE deleting the repo directory so no events are missed.
// Returns immediately if the repo is not currently registered.
function waitForRepoClose(repoPath: string, timeoutMs = 10_000): Promise<void> {
	const gitApi = getGitApi();
	if (!gitApi.getRepository(Uri.file(repoPath))) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sub.dispose();
			reject(
				new Error(
					`Timeout waiting for repository to close: ${repoPath}`,
				),
			);
		}, timeoutMs);
		const sub = gitApi.onDidCloseRepository((closed) => {
			if (closed.rootUri.fsPath === repoPath) {
				clearTimeout(timer);
				sub.dispose();
				resolve();
			}
		});
	});
}

// Waits until repo.state.mergeChanges.length === expectedCount.
// Uses onDidChange events rather than polling; falls back to a timeout.
function waitForMergeChanges(
	repo: GitApiRepository,
	expectedCount: number,
	timeoutMs = 10_000,
): Promise<void> {
	if (repo.state.mergeChanges.length === expectedCount) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sub.dispose();
			reject(
				new Error(
					`Timeout: expected ${expectedCount} merge changes, got ${repo.state.mergeChanges.length}`,
				),
			);
		}, timeoutMs);
		const sub = repo.state.onDidChange(() => {
			if (repo.state.mergeChanges.length === expectedCount) {
				clearTimeout(timer);
				sub.dispose();
				resolve();
			}
		});
	});
}

export {
	makeConflict,
	makeRepo,
	makeRepoFile,
	makeSecondConflict,
	openRepoInGitExtension,
	runGit,
	waitForMergeChanges,
	waitForRepoClose,
};
