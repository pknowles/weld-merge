import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import Xvfb from "xvfb";
import { mkdtempUnderTestRootSync, runGit } from "../runGit.ts";

function createTestWorkspace(): string {
	const workspacePath = mkdtempUnderTestRootSync("weld-vscode-workspace-");
	runGit(["init"], workspacePath);
	runGit(["config", "user.name", "Weld Test"], workspacePath);
	runGit(["config", "user.email", "weld-test@example.com"], workspacePath);
	writeFileSync(path.join(workspacePath, "README.md"), "# Test Workspace\n");
	runGit(["add", "--", "README.md"], workspacePath);
	runGit(["commit", "-m", "init"], workspacePath);
	return workspacePath;
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

interface LaunchTelemetryWorkspace {
	rootPath: string;
	workspacePath: string;
}

function createLaunchTelemetryWorkspace(): LaunchTelemetryWorkspace {
	const workspaceRoot = mkdtempUnderTestRootSync(
		"weld-vscode-launch-telemetry-",
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
					"files.hotExit": "onExitAndWindowClose",
					"weld.launchTelemetry": true,
					"window.restoreWindows": "all",
					"workbench.editor.restoreViewState": true,
					"workbench.startupEditor": "none",
				},
			},
			null,
			2,
		),
	);
	return {
		rootPath: workspaceRoot,
		workspacePath: workspaceFile,
	};
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

	const userDataDir = mkdtempUnderTestRootSync("weld-vscode-test-");
	const launchTelemetryUserDataDir = mkdtempUnderTestRootSync(
		"weld-vscode-launch-telemetry-test-",
	);
	const launchTelemetryWorkspace = createLaunchTelemetryWorkspace();
	const workspacePath = createTestWorkspace();

	// Forces X11 regardless of the host session type: on a Wayland desktop,
	// Electron/Chromium's Ozone auto-detection can still pick the real Wayland
	// compositor over the DISPLAY xvfb just started, which would render the
	// test window on the actual desktop instead of the hidden virtual display
	// xvfb provides. --ozone-platform=x11 alone is not reliable enough to stop
	// this (confirmed by observing a real test window on the desktop with only
	// this flag set) — runTests() spawns VS Code with a full copy of this
	// process's own environment (@vscode/test-electron's innerRunTests does
	// `{...process.env, ...testRunnerEnv}`), so unless testRunnerEnv is passed
	// to explicitly override WAYLAND_DISPLAY/XDG_SESSION_TYPE for the spawned
	// process specifically, the child still inherits this driver's real
	// Wayland session, and Ozone's own auto-detection can still find and
	// prefer it over the CLI flag. Both layers together (clear the env vars
	// for the child, still pass the flag as an explicit fallback) is the fix;
	// neither alone has been reliable.
	const ozoneArgs =
		process.platform === "linux" ? ["--ozone-platform=x11"] : [];
	const linuxDisplayEnv = {
		// biome-ignore lint/style/useNamingConvention: env var names are dictated by X11/Wayland/Electron
		WAYLAND_DISPLAY: undefined,
		// biome-ignore lint/style/useNamingConvention: env var names are dictated by X11/Wayland/Electron
		XDG_SESSION_TYPE: "x11",
	};
	const testRunnerEnvArgs =
		process.platform === "linux"
			? { extensionTestsEnv: linuxDisplayEnv }
			: {};

	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath: launchTelemetryTestsPath,
			...testRunnerEnvArgs,
			launchArgs: [
				launchTelemetryWorkspace.workspacePath,
				`--user-data-dir=${launchTelemetryUserDataDir}`,
				"--disable-extensions",
				"--skip-welcome",
				"--skip-release-notes",
				...ozoneArgs,
			],
		});
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			...testRunnerEnvArgs,
			launchArgs: [
				workspacePath,
				`--user-data-dir=${userDataDir}`,
				"--disable-extensions",
				"--skip-welcome",
				"--skip-release-notes",
				...ozoneArgs,
			],
		});
	} finally {
		if (xvfb) {
			xvfb.stopSync();
		}
		rmSync(launchTelemetryUserDataDir, { recursive: true, force: true });
		rmSync(launchTelemetryWorkspace.rootPath, {
			recursive: true,
			force: true,
		});
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
