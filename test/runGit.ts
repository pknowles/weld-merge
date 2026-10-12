import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// One fixed root for every test fixture, computed the same way by every
// process independently — no IPC needed between a driver process (e.g.
// test/vscode/runTest.ts) and the VS Code child process it spawns, since
// every process derives the exact same path from this one fixed, unchanging
// name rather than agreeing on it at runtime (no env var, no random mkdtemp
// suffix at this level — only the per-fixture subdirectories below get a
// random suffix).
//
// Deliberately NOT under the project directory (e.g. a test-output/ dir),
// even though that convention already exists for benchmarking/coverage
// output and is already gitignored: a path gitignored by *this* repo gets
// skipped by VS Code's file watcher, which by default does not watch
// git-ignored paths. Several VS Code-host tests depend on the Git extension
// or VS Code itself noticing filesystem changes inside these fixtures (e.g.
// detecting a deleted .git directory, or an externally-changed file) — those
// tests silently hang/timeout if the fixture lives somewhere the watcher
// ignores. This was discovered the hard way: an earlier version of this file
// used <repo>/test-output/tmp/ and broke exactly one such test
// deterministically; moving back under the OS temp directory (outside any
// git repository, so nothing to ignore) fixed it immediately with no other
// change. If you're tempted to move this under the project directory again,
// don't — or if you must, first verify every test that deletes/externally
// modifies a fixture file and waits on a VS Code/Git-extension event still
// passes.
const TEST_TEMP_ROOT = join(tmpdir(), "weld-test");

export function getTestTempRoot(): string {
	mkdirSync(TEST_TEMP_ROOT, { recursive: true });
	return TEST_TEMP_ROOT;
}

// Synchronous variant for the plain-Node scripts (test/vscode/runTest.ts and
// friends) that build their workspace before any async test framework is
// running.
export function mkdtempUnderTestRootSync(prefix: string): string {
	return mkdtempSync(join(getTestTempRoot(), prefix));
}

export function mkdtempUnderTestRoot(prefix: string): Promise<string> {
	return mkdtemp(join(getTestTempRoot(), prefix));
}

export function assertSafeGitCwd(cwd: string): void {
	const absoluteCwd = resolve(cwd);
	const absoluteTempRoot = resolve(getTestTempRoot());
	const tempRelativePath = relative(absoluteTempRoot, absoluteCwd);
	if (
		tempRelativePath.length > 0 &&
		!tempRelativePath.startsWith("..") &&
		!isAbsolute(tempRelativePath)
	) {
		return;
	}

	throw new Error(
		`Refusing to run test Git command outside temp dir: ${cwd}`,
	);
}

export function runGit(args: string[], cwd: string): string {
	assertSafeGitCwd(cwd);
	return execFileSync("git", ["-C", cwd, ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
