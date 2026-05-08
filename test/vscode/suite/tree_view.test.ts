import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "mocha";
import { Uri } from "vscode";
import { getGitApi } from "../../../src/repoContext.ts";
import { ConflictedFilesProvider, GitFile } from "../../../src/treeView.ts";
import {
	makeConflict,
	makeRepo,
	openRepoInGitExtension,
	runGit,
	waitForMergeChanges,
	waitForRepoClose,
} from "./helpers.ts";

/* Original prompt
Tree view tests
1. start vscode in a git repo, make a conflict, verify we detect it and show the conflicted file
2. start vscode in an empty folder, git init, make a conflict and verify we detect it and show the conflict
3. already have a conflict, start vscode
3.a. verify it's detected and files shown
4. same as 3., run git add and git commit, and verify our UI shows the conflict gone
5. same as 3., the same but using git merge --abort, verify gone
6. same as 3., the same, deleting the .git directory but leaving the file, verify gone
*/

// Returns the ConflictedFile items that belong to repoPath (contextValue
// "conflictedFile"). Filters out items from other repos that may be open in
// the same VS Code instance across concurrent test runs.
function conflictedItemsFor(
	children: Awaited<ReturnType<ConflictedFilesProvider["getChildren"]>>,
	repoPath: string,
): GitFile[] {
	return children.filter(
		(c): c is GitFile =>
			c.contextValue === "conflictedFile" &&
			c instanceof GitFile &&
			c.uri.fsPath.startsWith(repoPath),
	);
}

describe("ConflictedFilesProvider — conflict detection (VS Code host)", () => {
	it("detects a conflict created after the repo was opened", async () => {
		// Tree view test 1: start with a git repo already open, then create conflict.
		const repoPath = await makeRepo("weld-tv-post-open-");
		try {
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo, "expected repository to be registered");

			makeConflict(repoPath);
			await waitForMergeChanges(repo, 1);

			const children = await new ConflictedFilesProvider().getChildren();
			const conflicted = conflictedItemsFor(children, repoPath);

			assert.equal(conflicted.length, 1);
			assert.ok(conflicted[0]?.uri.fsPath.endsWith("tracked.txt"));
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("detects a conflict in a repo that was git-init'd while VS Code was running", async () => {
		// Tree view test 2: start with an empty directory, git init it, then make
		// a conflict. Simulates the user running `git init` in a folder that VS
		// Code was already watching.
		const dirPath = await mkdtemp(join(tmpdir(), "weld-tv-git-init-"));
		try {
			runGit(["init"], dirPath);
			runGit(["config", "user.name", "Weld Test"], dirPath);
			runGit(["config", "user.email", "weld-test@example.com"], dirPath);
			await writeFile(join(dirPath, "tracked.txt"), "base\n");
			runGit(["add", "--", "tracked.txt"], dirPath);
			runGit(["commit", "-m", "init"], dirPath);

			// Open in the git extension AFTER init (the extension "discovers" it)
			await openRepoInGitExtension(dirPath);
			const repo = getGitApi().getRepository(Uri.file(dirPath));
			assert.ok(repo, "expected repository to be registered");

			makeConflict(dirPath);
			await waitForMergeChanges(repo, 1);

			const children = await new ConflictedFilesProvider().getChildren();
			const conflicted = conflictedItemsFor(children, dirPath);

			assert.equal(conflicted.length, 1);
			assert.ok(conflicted[0]?.uri.fsPath.endsWith("tracked.txt"));
		} finally {
			const closePromise = waitForRepoClose(dirPath);
			await rm(dirPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("detects a pre-existing conflict when VS Code opens on a conflicted repo", async () => {
		// Tree view test 3 / 3.a: conflict exists before the extension tracks
		// the repository.
		const repoPath = await makeRepo("weld-tv-pre-existing-");
		try {
			makeConflict(repoPath); // conflict BEFORE openRepoInGitExtension
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const children = await new ConflictedFilesProvider().getChildren();
			const conflicted = conflictedItemsFor(children, repoPath);

			assert.equal(conflicted.length, 1);
			assert.ok(conflicted[0]?.uri.fsPath.endsWith("tracked.txt"));
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

describe("ConflictedFilesProvider — conflict resolution (VS Code host)", () => {
	it("removes the conflicted file from the tree after git add + git commit", async () => {
		// Tree view test 4: pre-existing conflict resolved via add + commit.
		const repoPath = await makeRepo("weld-tv-resolve-commit-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			// Resolve: write clean content, add, commit
			await writeFile(join(repoPath, "tracked.txt"), "resolved\n");
			runGit(["add", "--", "tracked.txt"], repoPath);
			runGit(["commit", "-m", "resolve merge"], repoPath);
			await waitForMergeChanges(repo, 0);

			const children = await new ConflictedFilesProvider().getChildren();
			assert.equal(
				conflictedItemsFor(children, repoPath).length,
				0,
				"expected no conflicted items after commit",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("removes the conflicted file from the tree after git merge --abort", async () => {
		// Tree view test 5: pre-existing conflict resolved via merge --abort.
		const repoPath = await makeRepo("weld-tv-abort-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			runGit(["merge", "--abort"], repoPath);
			await waitForMergeChanges(repo, 0);

			const children = await new ConflictedFilesProvider().getChildren();
			assert.equal(
				conflictedItemsFor(children, repoPath).length,
				0,
				"expected no conflicted items after merge --abort",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("removes the conflicted file from the tree after the .git directory is deleted", async () => {
		// Tree view test 6: delete .git while leaving the working file in place.
		// The git extension should close the repository, after which the tree
		// shows no items for it.
		const repoPath = await makeRepo("weld-tv-delete-git-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const closePromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								"Timeout waiting for repository to close after .git deletion",
							),
						),
					10_000,
				);
				const sub = getGitApi().onDidCloseRepository((closed) => {
					if (closed.rootUri.fsPath === repoPath) {
						clearTimeout(timer);
						sub.dispose();
						resolve();
					}
				});
			});

			await rm(join(repoPath, ".git"), { recursive: true, force: true });
			await closePromise;

			const children = await new ConflictedFilesProvider().getChildren();
			assert.equal(
				conflictedItemsFor(children, repoPath).length,
				0,
				"expected no conflicted items after .git deletion",
			);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});
