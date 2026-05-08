import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "mocha";
import { Uri } from "vscode";
import { getGitDirUri, readConflictState } from "../../../src/gitUtils.ts";
import { getGitApi } from "../../../src/repoContext.ts";
import {
	makeRepo,
	openRepoInGitExtension,
	runGit,
	waitForRepoClose,
} from "./helpers.ts";

async function getRepository(repoPath: string) {
	const gitApi = await getGitApi();
	await openRepoInGitExtension(repoPath);
	const repository = gitApi.getRepository(Uri.file(repoPath));
	if (!repository) {
		throw new Error(`Expected repository for ${repoPath}`);
	}
	return repository;
}

describe("gitUtils gitdir resolution (VS Code host)", () => {
	it("resolves .git directory for a normal repository", async () => {
		const repoPath = await makeRepo("weld-vscode-gitdir-normal-");
		try {
			const repository = await getRepository(repoPath);
			const gitDir = await getGitDirUri(repository);
			assert.equal(gitDir.fsPath, join(repoPath, ".git"));
			// Intent: readConflictState() must inspect the resolved git dir, not make
			// assumptions about merge-state files living somewhere else.
			await writeFile(join(gitDir.fsPath, "MERGE_HEAD"), "deadbeef\n");
			const state = await readConflictState(repository);
			assert.ok(state);
			assert.equal(state.operation, "merge");
			assert.equal(state.otherRef, "MERGE_HEAD");
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("resolves linked worktree gitdir and detects conflict state", async () => {
		const repoPath = await makeRepo("weld-vscode-gitdir-worktree-main-");
		const worktreePath = `${repoPath}-linked`;
		try {
			runGit(
				["worktree", "add", "-b", "linked-worktree", worktreePath],
				repoPath,
			);
			const repository = await getRepository(worktreePath);
			const gitDir = await getGitDirUri(repository);
			// Regression guard: in a linked worktree, .git is a pointer file, not a
			// directory. The test proves we follow that indirection before checking
			// for MERGE_HEAD and similar state files.
			assert.notEqual(gitDir.fsPath, join(worktreePath, ".git"));
			await writeFile(join(gitDir.fsPath, "MERGE_HEAD"), "cafebabe\n");
			const state = await readConflictState(repository);
			assert.ok(state);
			assert.equal(state.operation, "merge");
			assert.equal(state.otherRef, "MERGE_HEAD");
		} finally {
			const closePromise = waitForRepoClose(worktreePath);
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("returns undefined conflict state when no git operation files exist", async () => {
		const repoPath = await makeRepo("weld-vscode-gitdir-clean-");
		try {
			const repository = await getRepository(repoPath);
			const state = await readConflictState(repository);
			assert.equal(state, undefined);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});
