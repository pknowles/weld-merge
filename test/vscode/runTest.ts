import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import Xvfb from "xvfb";

function createTestWorkspace(): string {
	const workspacePath = mkdtempSync(
		path.join(tmpdir(), "weld-vscode-workspace-"),
	);
	execFileSync("git", ["init"], { cwd: workspacePath });
	execFileSync("git", ["config", "user.name", "Weld Test"], {
		cwd: workspacePath,
	});
	execFileSync("git", ["config", "user.email", "weld-test@example.com"], {
		cwd: workspacePath,
	});
	writeFileSync(path.join(workspacePath, "README.md"), "# Test Workspace\n");
	execFileSync("git", ["add", "--", "README.md"], { cwd: workspacePath });
	execFileSync("git", ["commit", "-m", "init"], { cwd: workspacePath });
	return workspacePath;
}

function runGit(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createConflictedRepo(parentPath: string, name: string): string {
	const repoPath = path.join(parentPath, name);
	mkdirSync(repoPath, { recursive: true });
	runGit(["init"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	writeFileSync(path.join(repoPath, "tracked.txt"), "base\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "init"], repoPath);
	runGit(["checkout", "-b", "other"], repoPath);
	writeFileSync(path.join(repoPath, "tracked.txt"), "remote\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "remote change"], repoPath);
	runGit(["checkout", "-"], repoPath);
	writeFileSync(path.join(repoPath, "tracked.txt"), "local\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "local change"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// Git exits non-zero for the expected merge conflict.
	}
	return repoPath;
}

function createLaunchTelemetryWorkspace(): string {
	const workspaceRoot = mkdtempSync(
		path.join(tmpdir(), "weld-vscode-launch-telemetry-"),
	);
	const repoA = createConflictedRepo(workspaceRoot, "repo-a");
	const repoB = createConflictedRepo(workspaceRoot, "repo-b");
	const workspaceFile = path.join(workspaceRoot, "launch.code-workspace");
	writeFileSync(
		workspaceFile,
		JSON.stringify(
			{
				folders: [{ path: repoA }, { path: repoB }],
				settings: {
					"weld.launchTelemetry": true,
				},
			},
			null,
			2,
		),
	);
	return workspaceRoot;
}

async function main(): Promise<void> {
	const currentFile = fileURLToPath(import.meta.url);
	const currentDir = path.dirname(currentFile);
	const require = createRequire(import.meta.url);
	const extensionDevelopmentPath = path.resolve(currentDir, "../..");
	const extensionTestsPath = path.resolve(currentDir, "suite/index.cjs");
	const launchTelemetryTestsPath = require.resolve(
		"./launchTelemetrySuite/index.cjs",
	);

	const xvfb =
		process.platform === "linux" ? new Xvfb({ silent: true }) : null;
	if (xvfb) {
		xvfb.startSync();
	}

	const userDataDir = mkdtempSync(path.join(tmpdir(), "weld-vscode-test-"));
	const launchTelemetryUserDataDir = mkdtempSync(
		path.join(tmpdir(), "weld-vscode-launch-telemetry-test-"),
	);
	const launchTelemetryWorkspaceRoot = createLaunchTelemetryWorkspace();
	const launchTelemetryWorkspacePath = path.join(
		launchTelemetryWorkspaceRoot,
		"launch.code-workspace",
	);
	const workspacePath = createTestWorkspace();

	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath: launchTelemetryTestsPath,
			launchArgs: [
				launchTelemetryWorkspacePath,
				`--user-data-dir=${launchTelemetryUserDataDir}`,
				"--disable-extensions",
				"--skip-welcome",
				"--skip-release-notes",
			],
		});
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				workspacePath,
				`--user-data-dir=${userDataDir}`,
				"--disable-extensions",
				"--skip-welcome",
				"--skip-release-notes",
			],
		});
	} finally {
		if (xvfb) {
			xvfb.stopSync();
		}
		rmSync(launchTelemetryUserDataDir, { recursive: true, force: true });
		rmSync(launchTelemetryWorkspaceRoot, { recursive: true, force: true });
		rmSync(userDataDir, { recursive: true, force: true });
		rmSync(workspacePath, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write("VS Code integration tests failed\n");
	const details =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${details}\n`);
	process.exitCode = 1;
});
