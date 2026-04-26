import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "mocha";
import { Uri } from "vscode";
import { resolveRepoContext } from "../../../src/repoContext.ts";
import {
	makeRepo,
	makeRepoFile,
	openRepoInGitExtension,
	runGit,
} from "./helpers.ts";

describe("repoContext.resolveRepoContext (VS Code host)", () => {
	it("returns null for unsupported URI schemes", async () => {
		const uri = Uri.parse("untitled:weld");
		const repoContext = await resolveRepoContext(uri);
		assert.equal(repoContext, null);
	});

	it("resolves subdirectory files from repository root", async () => {
		const repoPath = await makeRepo("weld-vscode-subdir-");
		try {
			await openRepoInGitExtension(repoPath);
			const fileUri = await makeRepoFile(repoPath, "src/nested/file.txt");
			const repoContext = await resolveRepoContext(fileUri);
			assert.ok(repoContext);
			assert.equal(repoContext.rootUri.fsPath, repoPath);
			assert.equal(repoContext.uri.toString(), fileUri.toString());
		} finally {
			await rm(repoPath, { recursive: true, force: true });
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
			const repoContext = await resolveRepoContext(fileUri);
			assert.ok(repoContext);
			assert.equal(repoContext.rootUri.fsPath, worktreePath);
			assert.equal(repoContext.uri.toString(), fileUri.toString());
		} finally {
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
		}
	});

	it("picks the correct repository when multiple are open", async () => {
		const repoPathA = await makeRepo("weld-vscode-multi-a-");
		const repoPathB = await makeRepo("weld-vscode-multi-b-");
		try {
			await openRepoInGitExtension(repoPathA);
			await openRepoInGitExtension(repoPathB);
			const fileUri = await makeRepoFile(repoPathB, "only-b.txt");
			const repoContext = await resolveRepoContext(fileUri);
			assert.ok(repoContext);
			assert.equal(repoContext.rootUri.fsPath, repoPathB);
			assert.equal(repoContext.uri.toString(), fileUri.toString());
		} finally {
			await rm(repoPathA, { recursive: true, force: true });
			await rm(repoPathB, { recursive: true, force: true });
		}
	});

	it("returns null for files outside tracked repositories", async () => {
		const repoPath = await makeRepo("weld-vscode-outside-");
		const outsidePath = join(repoPath, "..", `${Date.now()}-outside.txt`);
		try {
			await openRepoInGitExtension(repoPath);
			const outsideUri = Uri.file(outsidePath);
			const repoContext = await resolveRepoContext(outsideUri);
			assert.equal(repoContext, null);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});
