import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@jest/globals";
import { Uri } from "vscode";
import { getGitDirUri, readConflictState } from "../src/gitUtils.ts";
import type { GitApiRepository } from "../src/repoContext.ts";

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

function mockRepo(path: string): GitApiRepository {
	return {
		rootUri: Uri.file(path),
	} as GitApiRepository;
}

describe("gitUtils worktree-safe gitdir resolution", () => {
	it("resolves .git dir for a normal repository", async () => {
		const repoPath = await makeRepo("weld-gitdir-");
		try {
			const gitDirUri = await getGitDirUri(mockRepo(repoPath));
			const gitDir = gitDirUri.fsPath;
			expect(gitDir).toBe(join(repoPath, ".git"));
			await writeFile(join(gitDir, "MERGE_HEAD"), "deadbeef\n");
			await expect(
				readConflictState(mockRepo(repoPath)),
			).resolves.toMatchObject({
				operation: "merge",
				otherRef: "MERGE_HEAD",
			});
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});

	it("resolves linked worktree gitdir and detects conflict state", async () => {
		const repoPath = await makeRepo("weld-worktree-");
		const worktreePath = `${repoPath}-linked`;
		try {
			runGit(
				["worktree", "add", "-b", "linked-worktree", worktreePath],
				repoPath,
			);
			const gitDirUri = await getGitDirUri(mockRepo(worktreePath));
			const gitDir = gitDirUri.fsPath;
			expect(gitDir).not.toBe(join(worktreePath, ".git"));
			await writeFile(join(gitDir, "MERGE_HEAD"), "cafebabe\n");
			await expect(
				readConflictState(mockRepo(worktreePath)),
			).resolves.toMatchObject({
				operation: "merge",
				otherRef: "MERGE_HEAD",
			});
		} finally {
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
		}
	});
});
