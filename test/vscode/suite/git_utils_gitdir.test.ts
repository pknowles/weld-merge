import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "mocha";
import { getGitDir, readConflictState } from "../../../src/gitUtils.ts";
import { makeRepo, runGit } from "./helpers.ts";

describe("gitUtils gitdir resolution (VS Code host)", () => {
	it("resolves .git directory for a normal repository", async () => {
		const repoPath = await makeRepo("weld-vscode-gitdir-normal-");
		try {
			const gitDir = await getGitDir(repoPath);
			assert.equal(gitDir, join(repoPath, ".git"));
			// Intent: readConflictState() must inspect the resolved git dir, not make
			// assumptions about merge-state files living somewhere else.
			await writeFile(join(gitDir, "MERGE_HEAD"), "deadbeef\n");
			const state = await readConflictState(repoPath);
			assert.ok(state);
			assert.equal(state.operation, "merge");
			assert.equal(state.otherRef, "MERGE_HEAD");
		} finally {
			await rm(repoPath, { recursive: true, force: true });
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
			const gitDir = await getGitDir(worktreePath);
			// Regression guard: in a linked worktree, .git is a pointer file, not a
			// directory. The test proves we follow that indirection before checking
			// for MERGE_HEAD and similar state files.
			assert.notEqual(gitDir, join(worktreePath, ".git"));
			await writeFile(join(gitDir, "MERGE_HEAD"), "cafebabe\n");
			const state = await readConflictState(worktreePath);
			assert.ok(state);
			assert.equal(state.operation, "merge");
			assert.equal(state.otherRef, "MERGE_HEAD");
		} finally {
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
		}
	});

	it("returns undefined conflict state when no git operation files exist", async () => {
		const repoPath = await makeRepo("weld-vscode-gitdir-clean-");
		try {
			const state = await readConflictState(repoPath);
			assert.equal(state, undefined);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});
