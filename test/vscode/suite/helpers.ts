import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Uri } from "vscode";
import type {
	ConflictedItem,
	GitApiRepository,
} from "../../../src/repoContext.ts";
import {
	createConflictedItemFromUri,
	getGitApi,
} from "../../../src/repoContext.ts";
import { runGit } from "../../runGit.ts";

const LS_FILES_STAGE_REGEX = /^\S+ \S+ (\d+)\t/;

interface TempRepoFixture {
	repoPath: string;
	cleanupPath: string;
}

function assertUnmergedPaths(repoPath: string, expectedPaths: string[]): void {
	const unmergedPaths = runGit(
		["diff", "--name-only", "--diff-filter=U"],
		repoPath,
	).split("\n");
	for (const expectedPath of expectedPaths) {
		if (!unmergedPaths.includes(expectedPath)) {
			throw new Error(
				`Expected ${expectedPath} to be unmerged in ${repoPath}; got ${unmergedPaths.join(", ")}`,
			);
		}
	}
}

async function makeRepoFixture(prefix: string): Promise<TempRepoFixture> {
	const repoPath = await mkdtemp(join(tmpdir(), prefix));
	runGit(["init"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	await writeFile(join(repoPath, "tracked.txt"), "base\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "init"], repoPath);
	return { repoPath, cleanupPath: repoPath };
}

async function makeRepo(prefix: string): Promise<string> {
	const fixture = await makeRepoFixture(prefix);
	return fixture.repoPath;
}

function assertSafeTempFixtureCleanupPath(cleanupPath: string): void {
	if (dirname(cleanupPath) !== tmpdir()) {
		throw new Error(
			`Refusing to remove test fixture outside temp root: ${cleanupPath}`,
		);
	}
	if (!basename(cleanupPath).startsWith("weld-")) {
		throw new Error(
			`Refusing to remove test fixture without weld-* prefix: ${cleanupPath}`,
		);
	}
}

async function cleanupTempFixture(fixture: TempRepoFixture): Promise<void> {
	assertSafeTempFixtureCleanupPath(fixture.cleanupPath);
	await rm(fixture.cleanupPath, { recursive: true, force: true });
}

async function makeSubmoduleConflictFixture(
	prefix: string,
): Promise<TempRepoFixture> {
	const repoPath = await makeSubmoduleConflictRepo(prefix);
	return { repoPath, cleanupPath: dirname(repoPath) };
}

async function makeSubmoduleConflictRepo(prefix: string): Promise<string> {
	const rootPath = await mkdtemp(join(tmpdir(), prefix));
	const subSourcePath = join(rootPath, "subsrc");
	const repoPath = join(rootPath, "parent");
	await mkdir(subSourcePath);
	await mkdir(repoPath);
	runGit(["init", "-b", "main"], subSourcePath);
	runGit(["config", "user.name", "Weld Test"], subSourcePath);
	runGit(["config", "user.email", "weld-test@example.com"], subSourcePath);
	await writeFile(join(subSourcePath, "file.txt"), "base\n");
	runGit(["add", "file.txt"], subSourcePath);
	runGit(["commit", "-m", "base"], subSourcePath);
	const base = runGit(["rev-parse", "HEAD"], subSourcePath);
	runGit(["checkout", "-b", "other"], subSourcePath);
	await writeFile(join(subSourcePath, "file.txt"), "remote\n");
	runGit(["commit", "-am", "remote"], subSourcePath);
	const remote = runGit(["rev-parse", "HEAD"], subSourcePath);
	runGit(["checkout", "main"], subSourcePath);
	await writeFile(join(subSourcePath, "file.txt"), "local\n");
	runGit(["commit", "-am", "local"], subSourcePath);
	const local = runGit(["rev-parse", "HEAD"], subSourcePath);

	runGit(["init", "-b", "main"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	runGit(
		[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			subSourcePath,
			"sub",
		],
		repoPath,
	);
	runGit(["checkout", base], join(repoPath, "sub"));
	runGit(["add", "sub", ".gitmodules"], repoPath);
	runGit(["commit", "-m", "add sub"], repoPath);
	runGit(["checkout", "-b", "other"], repoPath);
	runGit(["checkout", remote], join(repoPath, "sub"));
	runGit(["add", "sub"], repoPath);
	runGit(["commit", "-m", "remote sub"], repoPath);
	runGit(["checkout", "main"], repoPath);
	runGit(["checkout", local], join(repoPath, "sub"));
	runGit(["add", "sub"], repoPath);
	runGit(["commit", "-m", "local sub"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits non-zero for the expected submodule conflict.
	}
	assertUnmergedPaths(repoPath, ["sub"]);
	return repoPath;
}

async function makeSubmoduleAndTextConflictRepo(
	prefix: string,
): Promise<string> {
	const rootPath = await mkdtemp(join(tmpdir(), prefix));
	const subSourcePath = join(rootPath, "subsrc");
	const repoPath = join(rootPath, "parent");
	await mkdir(subSourcePath);
	await mkdir(repoPath);
	runGit(["init", "-q", "-b", "main"], subSourcePath);
	runGit(["config", "user.name", "Weld Test"], subSourcePath);
	runGit(["config", "user.email", "weld-test@example.com"], subSourcePath);
	await writeFile(join(subSourcePath, "file.txt"), "base\n");
	runGit(["add", "file.txt"], subSourcePath);
	runGit(["commit", "-q", "-m", "base"], subSourcePath);
	const base = runGit(["rev-parse", "HEAD"], subSourcePath);
	runGit(["checkout", "-q", "-b", "other"], subSourcePath);
	await writeFile(join(subSourcePath, "file.txt"), "remote\n");
	runGit(["commit", "-am", "remote", "-q"], subSourcePath);
	const remote = runGit(["rev-parse", "HEAD"], subSourcePath);
	runGit(["checkout", "-q", "main"], subSourcePath);
	await writeFile(join(subSourcePath, "file.txt"), "local\n");
	runGit(["commit", "-am", "local", "-q"], subSourcePath);
	const local = runGit(["rev-parse", "HEAD"], subSourcePath);

	runGit(["init", "-q", "-b", "main"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	runGit(
		[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			subSourcePath,
			"sub",
		],
		repoPath,
	);
	runGit(["checkout", "-q", base], join(repoPath, "sub"));
	await writeFile(join(repoPath, "tracked.txt"), "base\n");
	runGit(["add", "sub", ".gitmodules", "tracked.txt"], repoPath);
	runGit(["commit", "-q", "-m", "add sub and text"], repoPath);
	runGit(["checkout", "-q", "-b", "other"], repoPath);
	runGit(["checkout", "-q", remote], join(repoPath, "sub"));
	await writeFile(join(repoPath, "tracked.txt"), "remote\n");
	runGit(["add", "sub", "tracked.txt"], repoPath);
	runGit(["commit", "-q", "-m", "remote changes"], repoPath);
	runGit(["checkout", "-q", "main"], repoPath);
	runGit(["checkout", "-q", local], join(repoPath, "sub"));
	await writeFile(join(repoPath, "tracked.txt"), "local\n");
	runGit(["add", "sub", "tracked.txt"], repoPath);
	runGit(["commit", "-q", "-m", "local changes"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits non-zero for the expected combined conflict.
	}
	assertUnmergedPaths(repoPath, ["sub", "tracked.txt"]);
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
	assertUnmergedPaths(repoPath, ["tracked.txt"]);
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
	assertUnmergedPaths(repoPath, ["tracked.txt"]);
}

// Creates a delete/modify conflict where local deleted tracked.txt and remote
// modified it. Result: DELETED_BY_US — stage 2 absent, stage 3 present.
function makeDeletedByUsConflict(repoPath: string): void {
	runGit(["checkout", "-b", "other"], repoPath);
	writeFileSync(join(repoPath, "tracked.txt"), "remote modification\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "remote modifies"], repoPath);
	runGit(["checkout", "-"], repoPath);
	runGit(["rm", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "local deletes"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits 1 for a conflict — expected
	}
	assertUnmergedPaths(repoPath, ["tracked.txt"]);
}

// Creates a delete/modify conflict where remote deleted tracked.txt and local
// modified it. Result: DELETED_BY_THEM — stage 2 present, stage 3 absent.
function makeDeletedByThemConflict(repoPath: string): void {
	runGit(["checkout", "-b", "other"], repoPath);
	runGit(["rm", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "remote deletes"], repoPath);
	runGit(["checkout", "-"], repoPath);
	writeFileSync(join(repoPath, "tracked.txt"), "local modification\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "local modifies"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits 1 for a conflict — expected
	}
	assertUnmergedPaths(repoPath, ["tracked.txt"]);
}

// Creates a both-added conflict on conflict.txt (not present in the initial
// commit). Both branches add different content. Result: BOTH_ADDED — stage 1
// absent, stages 2 and 3 present.
function makeBothAddedConflict(repoPath: string): void {
	runGit(["checkout", "-b", "other"], repoPath);
	writeFileSync(join(repoPath, "conflict.txt"), "remote version\n");
	runGit(["add", "--", "conflict.txt"], repoPath);
	runGit(["commit", "-m", "remote adds conflict.txt"], repoPath);
	runGit(["checkout", "-"], repoPath);
	writeFileSync(join(repoPath, "conflict.txt"), "local version\n");
	runGit(["add", "--", "conflict.txt"], repoPath);
	runGit(["commit", "-m", "local adds conflict.txt"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits 1 for a conflict — expected
	}
	assertUnmergedPaths(repoPath, ["conflict.txt"]);
}

// Creates the raw index state Git reports as BOTH_DELETED. Normal merges usually
// auto-resolve this case, so write the unmerged index directly: remove the
// resolved stage-0 entry and leave only stage 1 for the original path.
function makeBothDeletedConflict(repoPath: string): void {
	const fileName = "tracked.txt";
	const blob = execFileSync(
		"git",
		["-C", repoPath, "hash-object", "-w", "--stdin"],
		{
			input: "base\n",
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		},
	).trim();
	execFileSync("git", ["-C", repoPath, "update-index", "--index-info"], {
		input: `0 0000000000000000000000000000000000000000 0\t${fileName}\n100644 ${blob} 1\t${fileName}\n`,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	assertUnmergedPaths(repoPath, [fileName]);
	if (
		runGit(["status", "--short", "--", fileName], repoPath) !==
		"DD tracked.txt"
	) {
		throw new Error(
			`Expected ${fileName} to be both-deleted in ${repoPath}`,
		);
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

// Creates a repo, sets up a conflict, opens it in the git extension, runs the
// test callback with the repo path and repository, then cleans up.
async function withConflictRepo(
	prefix: string,
	makeConflictFn: (repoPath: string) => void,
	testFn: (repoPath: string, repo: GitApiRepository) => Promise<void>,
): Promise<void> {
	const repoPath = await makeRepo(prefix);
	makeConflictFn(repoPath);
	await openRepoInGitExtension(repoPath);
	const repo = getGitApi().getRepository(Uri.file(repoPath));
	if (!repo) {
		throw new Error(`Expected git repository at ${repoPath}`);
	}
	await waitForMergeChanges(repo, 1);
	try {
		await testFn(repoPath, repo);
	} finally {
		const closePromise = waitForRepoClose(repoPath);
		await rm(repoPath, { recursive: true, force: true });
		await closePromise;
	}
}

// Builds a ConflictedItem for a file in an already-open repository.
function getConflictedItem(repoPath: string, fileName: string): ConflictedItem {
	const repo = getGitApi().getRepository(Uri.file(repoPath));
	if (!repo) {
		throw new Error(`Expected git repository at ${repoPath}`);
	}
	return createConflictedItemFromUri(
		repo,
		Uri.file(join(repoPath, fileName)),
	);
}

// Returns the set of index stage numbers present for a file (from git ls-files -u).
function lsFilesStages(repoPath: string, fileName: string): Set<number> {
	const output = runGit(
		["ls-files", "-u", "--", join(repoPath, fileName)],
		repoPath,
	);
	const stages = new Set<number>();
	for (const line of output.split("\n")) {
		const match = LS_FILES_STAGE_REGEX.exec(line);
		if (match) {
			stages.add(Number(match[1]));
		}
	}
	return stages;
}

// Returns working-tree file content, or null if the file does not exist.
function workingTreeContent(repoPath: string, fileName: string): string | null {
	try {
		return readFileSync(join(repoPath, fileName), "utf8");
	} catch {
		return null;
	}
}

export type { TempRepoFixture };
export {
	cleanupTempFixture,
	getConflictedItem,
	lsFilesStages,
	makeBothAddedConflict,
	makeBothDeletedConflict,
	makeConflict,
	makeDeletedByThemConflict,
	makeDeletedByUsConflict,
	makeRepo,
	makeRepoFile,
	makeRepoFixture,
	makeSecondConflict,
	makeSubmoduleAndTextConflictRepo,
	makeSubmoduleConflictFixture,
	makeSubmoduleConflictRepo,
	openRepoInGitExtension,
	waitForMergeChanges,
	waitForRepoClose,
	withConflictRepo,
	workingTreeContent,
};
