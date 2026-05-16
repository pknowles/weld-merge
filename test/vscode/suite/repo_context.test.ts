import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "mocha";
import { Uri } from "vscode";
import { conflictedItemFromUri } from "../../../src/repoContext.ts";
import {
	makeRepo,
	makeRepoFile,
	openRepoInGitExtension,
	runGit,
	waitForRepoClose,
} from "./helpers.ts";

describe("repoContext.conflictedItemFromUri (VS Code host)", () => {
	it("returns null for unsupported URI schemes", async () => {
		const uri = Uri.parse("untitled:weld");
		const conflictedItem = await conflictedItemFromUri(uri);
		assert.equal(conflictedItem, null);
	});

	it("resolves subdirectory files from repository root", async () => {
		const repoPath = await makeRepo("weld-vscode-subdir-");
		try {
			await openRepoInGitExtension(repoPath);
			const fileUri = await makeRepoFile(repoPath, "src/nested/file.txt");
			const conflictedItem = await conflictedItemFromUri(fileUri);
			assert.ok(conflictedItem);
			assert.equal(conflictedItem.rootUri.fsPath, repoPath);
			assert.equal(conflictedItem.uri.toString(), fileUri.toString());
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("resolves linked worktree files against the worktree root", async () => {
		const repoPath = await makeRepo("weld-vscode-worktree-main-");
		const worktreePath = `${repoPath}-worktree`;
		runGit(
			["worktree", "add", "-b", "linked-worktree", worktreePath],
			repoPath,
		);
		try {
			await openRepoInGitExtension(worktreePath);
			const fileUri = await makeRepoFile(
				worktreePath,
				"worktree-file.txt",
			);
			const conflictedItem = await conflictedItemFromUri(fileUri);
			assert.ok(conflictedItem);
			assert.equal(conflictedItem.rootUri.fsPath, worktreePath);
			assert.equal(conflictedItem.uri.toString(), fileUri.toString());
		} finally {
			const closePromise = waitForRepoClose(worktreePath);
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("picks the correct repository when multiple are open", async () => {
		const repoPathA = await makeRepo("weld-vscode-multi-a-");
		const repoPathB = await makeRepo("weld-vscode-multi-b-");
		try {
			await openRepoInGitExtension(repoPathA);
			await openRepoInGitExtension(repoPathB);
			const fileUri = await makeRepoFile(repoPathB, "only-b.txt");
			const conflictedItem = await conflictedItemFromUri(fileUri);
			assert.ok(conflictedItem);
			assert.equal(conflictedItem.rootUri.fsPath, repoPathB);
			assert.equal(conflictedItem.uri.toString(), fileUri.toString());
		} finally {
			const closeA = waitForRepoClose(repoPathA);
			const closeB = waitForRepoClose(repoPathB);
			await rm(repoPathA, { recursive: true, force: true });
			await rm(repoPathB, { recursive: true, force: true });
			await Promise.all([closeA, closeB]);
		}
	});

	it("returns null for files outside tracked repositories", async () => {
		const repoPath = await makeRepo("weld-vscode-outside-");
		const outsidePath = join(repoPath, "..", `${Date.now()}-outside.txt`);
		try {
			await openRepoInGitExtension(repoPath);
			const outsideUri = Uri.file(outsidePath);
			const conflictedItem = await conflictedItemFromUri(outsideUri);
			assert.equal(conflictedItem, null);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});
