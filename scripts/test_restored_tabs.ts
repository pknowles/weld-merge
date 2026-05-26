import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import Xvfb from "xvfb";

interface WorkspaceFixture {
	readonly rootPath: string;
	readonly workspacePath: string;
	readonly textConflictFiles: readonly [string, string];
	readonly submoduleRepositoryPaths: readonly [string, string];
}

interface DriverResult {
	readonly mode: string;
	readonly textTabCount: number;
	readonly submoduleTabCount: number;
	readonly tabCount: number;
	readonly tabs: readonly string[];
	readonly telemetry: WeldTelemetrySnapshot;
}

interface WeldTelemetrySnapshot {
	readonly treeRefreshes: number;
	readonly treeGetChildrenCalls: number;
	readonly refreshRepoCalls: number;
	readonly conflictStateChangedEvents: number;
	readonly repositoryStateChangedEvents: number;
	readonly refreshRepoReasons: Readonly<Record<string, number>>;
}

interface CodeLaunchOptions {
	readonly executablePath: string;
	readonly workspace: WorkspaceFixture;
	readonly userDataDir: string;
	readonly extensionsDir: string;
	readonly driverExtensionPath: string;
	readonly mode: "seed" | "assert";
	readonly resultPath: string;
}

const EXPECTED_TEXT_TAB_COUNT = 2;
const EXPECTED_SUBMODULE_TAB_COUNT = 2;
const EXPECTED_TAB_COUNT =
	EXPECTED_TEXT_TAB_COUNT + EXPECTED_SUBMODULE_TAB_COUNT;
const STARTUP_REFRESH_CEILING = 2;
const TREE_GET_CHILDREN_CEILING = 2;

function runGit(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createMixedConflictRepo(parentPath: string, name: string): string {
	const fixtureRoot = path.join(parentPath, name);
	const subSourcePath = path.join(fixtureRoot, "subsrc");
	const repoPath = path.join(fixtureRoot, "parent");
	mkdirSync(subSourcePath, { recursive: true });
	mkdirSync(repoPath, { recursive: true });
	runGit(["init", "-b", "main"], subSourcePath);
	runGit(["config", "user.name", "Weld Test"], subSourcePath);
	runGit(["config", "user.email", "weld-test@example.com"], subSourcePath);
	writeFileSync(path.join(subSourcePath, "file.txt"), "base\n");
	runGit(["add", "file.txt"], subSourcePath);
	runGit(["commit", "-m", "base"], subSourcePath);
	const base = runGitWithOutput(["rev-parse", "HEAD"], subSourcePath);
	runGit(["checkout", "-b", "other"], subSourcePath);
	writeFileSync(path.join(subSourcePath, "file.txt"), "remote\n");
	runGit(["commit", "-am", "remote"], subSourcePath);
	const remote = runGitWithOutput(["rev-parse", "HEAD"], subSourcePath);
	runGit(["checkout", "main"], subSourcePath);
	writeFileSync(path.join(subSourcePath, "file.txt"), "local\n");
	runGit(["commit", "-am", "local"], subSourcePath);
	const local = runGitWithOutput(["rev-parse", "HEAD"], subSourcePath);

	runGit(["init", "-b", "main"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	writeFileSync(path.join(repoPath, "tracked.txt"), "base\n");
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
	runGit(["checkout", base], path.join(repoPath, "sub"));
	runGit(["add", "--", "tracked.txt", "sub", ".gitmodules"], repoPath);
	runGit(["commit", "-m", "base"], repoPath);
	runGit(["checkout", "-b", "other"], repoPath);
	writeFileSync(path.join(repoPath, "tracked.txt"), "remote\n");
	runGit(["checkout", remote], path.join(repoPath, "sub"));
	runGit(["add", "--", "tracked.txt", "sub"], repoPath);
	runGit(["commit", "-m", "remote"], repoPath);
	runGit(["checkout", "main"], repoPath);
	writeFileSync(path.join(repoPath, "tracked.txt"), "local\n");
	runGit(["checkout", local], path.join(repoPath, "sub"));
	runGit(["add", "--", "tracked.txt", "sub"], repoPath);
	runGit(["commit", "-m", "local"], repoPath);
	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// Git exits non-zero for the expected text and submodule conflicts.
	}
	return repoPath;
}

function runGitWithOutput(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createWorkspace(): WorkspaceFixture {
	const rootPath = mkdtempSync(
		path.join(tmpdir(), "weld-restore-tabs-workspace-"),
	);
	const repoA = createMixedConflictRepo(rootPath, "repo-a");
	const repoB = createMixedConflictRepo(rootPath, "repo-b");
	const workspacePath = path.join(rootPath, "launch.code-workspace");
	writeFileSync(
		workspacePath,
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
		rootPath,
		workspacePath,
		textConflictFiles: [
			path.join(repoA, "tracked.txt"),
			path.join(repoB, "tracked.txt"),
		],
		submoduleRepositoryPaths: [repoA, repoB],
	};
}

function createDriverExtension(parentPath: string): string {
	const extensionPath = path.join(parentPath, "driver-extension");
	mkdirSync(extensionPath);
	writeFileSync(
		path.join(extensionPath, "package.json"),
		JSON.stringify(
			{
				name: "weld-restore-tabs-driver",
				publisher: "weld-test",
				version: "0.0.0",
				engines: { vscode: "^1.105.0" },
				activationEvents: ["onStartupFinished"],
				main: "./extension.js",
			},
			null,
			2,
		),
	);
	writeFileSync(
		path.join(extensionPath, "extension.js"),
		`
const fs = require("node:fs");
const vscode = require("vscode");

const mode = process.env.WELD_RESTORE_TABS_MODE;
const resultPath = process.env.WELD_RESTORE_TABS_RESULT;
const textFiles = JSON.parse(process.env.WELD_RESTORE_TEXT_FILES || "[]");
const submoduleRepositoryPaths = JSON.parse(process.env.WELD_RESTORE_SUBMODULE_REPOSITORIES || "[]");
const editorViewTypes = new Set(["weld.mergeEditor", "weld.submoduleConflict"]);

function customTabs() {
	return vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) =>
			tab.input instanceof vscode.TabInputCustom &&
			editorViewTypes.has(tab.input.viewType)
		);
}

function submoduleUri(repoPath) {
	return vscode.Uri.from({
		scheme: "weld-submodule-conflict",
		path: "/sub.weld-submodule-conflict",
		query: new URLSearchParams({
			repositoryRoot: vscode.Uri.file(repoPath).toString(),
			submodulePath: "sub",
		}).toString(),
	});
}

function result() {
	const telemetry = vscode.extensions.getExtension("pknowles.meld-auto-merge")?.exports?.getTelemetrySnapshot?.();
	const tabs = customTabs();
	if (!telemetry) {
		throw new Error("Weld telemetry snapshot is not available.");
	}
	return {
		mode,
		textTabCount: tabs.filter((tab) => tab.input.viewType === "weld.mergeEditor").length,
		submoduleTabCount: tabs.filter((tab) => tab.input.viewType === "weld.submoduleConflict").length,
		tabCount: tabs.length,
		tabs: tabs.map((tab) => tab.input.uri.toString()),
		telemetry,
	};
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabs(count) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (customTabs().length === count) {
			return;
		}
		await delay(100);
	}
	throw new Error("Expected " + count + " custom tabs, got " + customTabs().length);
}

async function activate() {
	await vscode.extensions.getExtension("pknowles.meld-auto-merge")?.activate();
	if (mode === "seed") {
		await Promise.all([
			...textFiles.map((file) =>
				vscode.commands.executeCommand(
					"vscode.openWith",
					vscode.Uri.file(file),
					"weld.mergeEditor"
				)
			),
			...submoduleRepositoryPaths.map((repoPath) =>
				vscode.commands.executeCommand(
					"vscode.openWith",
					submoduleUri(repoPath),
					"weld.submoduleConflict"
				)
			),
		]);
		await waitForTabs(textFiles.length + submoduleRepositoryPaths.length);
		await delay(2000);
	} else if (mode === "assert") {
		// The assertion launch must not open files itself. Seeing the tabs here
		// proves VS Code restored the real custom editors from the fixed profile.
		await waitForTabs(textFiles.length + submoduleRepositoryPaths.length);
		await delay(500);
	} else {
		throw new Error("Unknown mode: " + mode);
	}
	fs.writeFileSync(resultPath, JSON.stringify(result(), null, 2));
	setTimeout(() => {
		vscode.commands.executeCommand("workbench.action.closeWindow");
	}, 0);
}

exports.activate = activate;
`,
	);
	return extensionPath;
}

function runCode(options: CodeLaunchOptions): Promise<void> {
	const args = [
		options.workspace.workspacePath,
		"--no-sandbox",
		"--disable-gpu-sandbox",
		"--disable-updates",
		"--disable-workspace-trust",
		"--skip-welcome",
		"--skip-release-notes",
		`--user-data-dir=${options.userDataDir}`,
		`--extensions-dir=${options.extensionsDir}`,
		`--extensionDevelopmentPath=${process.cwd()}`,
		`--extensionDevelopmentPath=${options.driverExtensionPath}`,
	];
	return new Promise((resolve, reject) => {
		const child = spawn(options.executablePath, args, {
			env: createCodeEnvironment(options),
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`VS Code ${options.mode} exited with ${code ?? signal ?? "unknown"}`,
				),
			);
		});
	});
}

function createCodeEnvironment(options: CodeLaunchOptions): NodeJS.ProcessEnv {
	// biome-ignore lint/style/noProcessEnv: subprocess launch must inherit the caller's VS Code test environment.
	const env: NodeJS.ProcessEnv = { ...process.env };
	setEnvironmentValue(env, "ELECTRON_RUN_AS_NODE", undefined);
	setEnvironmentValue(
		env,
		"WELD_RESTORE_TEXT_FILES",
		JSON.stringify(options.workspace.textConflictFiles),
	);
	setEnvironmentValue(
		env,
		"WELD_RESTORE_SUBMODULE_REPOSITORIES",
		JSON.stringify(options.workspace.submoduleRepositoryPaths),
	);
	setEnvironmentValue(env, "WELD_RESTORE_TABS_MODE", options.mode);
	setEnvironmentValue(env, "WELD_RESTORE_TABS_RESULT", options.resultPath);
	return env;
}

function setEnvironmentValue(
	env: NodeJS.ProcessEnv,
	name: string,
	value: string | undefined,
): void {
	env[name] = value;
}

function assertDriverResult(result: DriverResult, mode: string): void {
	if (result.mode !== mode) {
		throw new Error(`Expected ${mode} result, got ${result.mode}.`);
	}
	if (result.textTabCount !== EXPECTED_TEXT_TAB_COUNT) {
		throw new Error(
			`${mode}: expected ${EXPECTED_TEXT_TAB_COUNT} Weld text tabs, got ${result.textTabCount}.`,
		);
	}
	if (result.submoduleTabCount !== EXPECTED_SUBMODULE_TAB_COUNT) {
		throw new Error(
			`${mode}: expected ${EXPECTED_SUBMODULE_TAB_COUNT} Weld submodule tabs, got ${result.submoduleTabCount}.`,
		);
	}
	if (result.tabCount !== EXPECTED_TAB_COUNT) {
		throw new Error(
			`${mode}: expected ${EXPECTED_TAB_COUNT} Weld tabs, got ${result.tabCount}.`,
		);
	}
	assertTelemetry(result.telemetry, mode);
}

function assertTelemetry(telemetry: WeldTelemetrySnapshot, mode: string): void {
	assertAtMost(
		telemetry.treeRefreshes,
		STARTUP_REFRESH_CEILING,
		`${mode}: treeRefreshes`,
	);
	assertAtMost(
		telemetry.refreshRepoCalls,
		STARTUP_REFRESH_CEILING,
		`${mode}: refreshRepoCalls`,
	);
	assertAtMost(
		telemetry.repositoryStateChangedEvents,
		STARTUP_REFRESH_CEILING,
		`${mode}: repositoryStateChangedEvents`,
	);
	assertAtMost(
		telemetry.conflictStateChangedEvents,
		STARTUP_REFRESH_CEILING,
		`${mode}: conflictStateChangedEvents`,
	);
	assertAtMost(
		telemetry.treeGetChildrenCalls,
		TREE_GET_CHILDREN_CEILING,
		`${mode}: treeGetChildrenCalls`,
	);
}

function assertAtMost(actual: number, ceiling: number, label: string): void {
	if (actual > ceiling) {
		throw new Error(`${label}: expected <= ${ceiling}, got ${actual}.`);
	}
}

async function main(): Promise<void> {
	const executablePath = await downloadAndUnzipVSCode();
	const rootPath = mkdtempSync(path.join(tmpdir(), "weld-restore-tabs-"));
	const workspace = createWorkspace();
	const userDataDir = path.join(rootPath, "user-data");
	const extensionsDir = path.join(rootPath, "extensions");
	const driverExtensionPath = createDriverExtension(rootPath);
	const seedResult = path.join(rootPath, "seed.json");
	const assertResult = path.join(rootPath, "assert.json");
	const xvfb =
		process.platform === "linux" ? new Xvfb({ silent: true }) : null;
	try {
		if (xvfb) {
			xvfb.startSync();
		}
		await runCode({
			executablePath,
			workspace,
			userDataDir,
			extensionsDir,
			driverExtensionPath,
			mode: "seed",
			resultPath: seedResult,
		});
		await runCode({
			executablePath,
			workspace,
			userDataDir,
			extensionsDir,
			driverExtensionPath,
			mode: "assert",
			resultPath: assertResult,
		});
		const seed = JSON.parse(
			readFileSync(seedResult, "utf8"),
		) as DriverResult;
		const assertion = JSON.parse(
			readFileSync(assertResult, "utf8"),
		) as DriverResult;
		process.stdout.write(
			`restored tab startup telemetry:\n${JSON.stringify({ seed, assertion }, null, 2)}\n`,
		);
		assertDriverResult(seed, "seed");
		assertDriverResult(assertion, "assert");
	} finally {
		if (xvfb) {
			xvfb.stopSync();
		}
		rmSync(rootPath, { recursive: true, force: true });
		rmSync(workspace.rootPath, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	const details =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${details}\n`);
	process.exitCode = 1;
});
