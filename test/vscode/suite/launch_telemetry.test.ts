import assert from "node:assert/strict";
import process from "node:process";
import { before, describe, it } from "mocha";
import sinon from "sinon";
import type { Disposable, WebviewPanel } from "vscode";
import { extensions, Uri } from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { initializeWeldLogChannel } from "../../../src/log.ts";
import type { GitApiRepository } from "../../../src/repoContext.ts";
import { getGitApi } from "../../../src/repoContext.ts";
import {
	type SubmoduleConflictIdentity,
	submoduleConflictUri,
} from "../../../src/submoduleConflict.ts";
import {
	cleanupTempFixture,
	makeSubmoduleConflictFixture,
	openRepoInGitExtension,
	type TempRepoFixture,
	waitForMergeChanges,
	waitForRepoClose,
} from "./helpers.ts";

interface CapturedMessage {
	command: string;
	message?: unknown;
	snapshot?: unknown;
}

interface FakePanel {
	webview: {
		html: string;
		options: {
			enableScripts?: boolean;
			localResourceRoots?: Uri[];
		};
		postMessage(message: unknown): Thenable<boolean>;
		onDidReceiveMessage(
			listener: (message: unknown) => unknown,
		): Disposable;
		asWebviewUri(uri: Uri): Uri;
		cspSource: string;
	};
	title: string;
	onDidDispose(listener: () => void): Disposable;
	dispose(): void;
	fireWebviewMessage(message: unknown): Promise<void>;
	nextMessage(command: string): Promise<CapturedMessage>;
	allMessages: CapturedMessage[];
}

interface StateCounter {
	readonly count: number;
	dispose(): void;
}

interface Telemetry {
	readonly conflictStateChanged: number;
	readonly refreshCallSites: string[];
	refreshCount(): number;
	getChildrenCount(): number;
	restore(): void;
}

const STATE_CHANGES_CEILING = 3;
const REFRESH_CEILING = 4;
const CONFLICT_STATE_CHANGED_CEILING = 4;
const SNAPSHOTS_PER_TAB = 1;
const QUIET_WINDOW_MS = 200;
const RACE_QUIET_WINDOW_MS = 1000;
const QUIET_TIMEOUT_MS = 10_000;
const STEADY_STATE_WINDOW_MS = 5000;

let weldApi: WeldExtensionApi;

before(async () => {
	initializeWeldLogChannel();
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	assert.ok(ext, "weld extension must be discoverable");
	weldApi = (await ext.activate()) as WeldExtensionApi;
});

function makeFakePanel(): FakePanel {
	const messages: CapturedMessage[] = [];
	const receiveListeners: Array<(message: unknown) => unknown> = [];
	const disposeListeners: Array<() => void> = [];
	const messageWaiters: Array<{
		command: string;
		resolve: (message: CapturedMessage) => void;
	}> = [];
	let html = "";

	return {
		webview: {
			get html(): string {
				return html;
			},
			set html(value: string) {
				html = value;
			},
			options: {},
			postMessage(message: unknown): Thenable<boolean> {
				const captured = message as CapturedMessage;
				messages.push(captured);
				const waiterIndex = messageWaiters.findIndex(
					(waiter) => waiter.command === captured.command,
				);
				if (waiterIndex !== -1) {
					const waiter = messageWaiters[waiterIndex];
					assert.ok(waiter, "message waiter must exist");
					messageWaiters.splice(waiterIndex, 1);
					waiter.resolve(captured);
				}
				return Promise.resolve(true);
			},
			onDidReceiveMessage(
				listener: (message: unknown) => unknown,
			): Disposable {
				receiveListeners.push(listener);
				return {
					dispose: () => {
						const index = receiveListeners.indexOf(listener);
						if (index !== -1) {
							receiveListeners.splice(index, 1);
						}
					},
				};
			},
			asWebviewUri(uri: Uri): Uri {
				return uri;
			},
			cspSource: "none",
		},
		title: "Test",
		onDidDispose(listener: () => void): Disposable {
			disposeListeners.push(listener);
			return {
				dispose: () => {
					const index = disposeListeners.indexOf(listener);
					if (index !== -1) {
						disposeListeners.splice(index, 1);
					}
				},
			};
		},
		dispose(): void {
			for (const listener of [...disposeListeners]) {
				listener();
			}
		},
		async fireWebviewMessage(message: unknown): Promise<void> {
			await Promise.all(
				receiveListeners.map((listener) => listener(message)),
			);
		},
		nextMessage(command: string): Promise<CapturedMessage> {
			const alreadyCaptured = messages.find(
				(message) => message.command === command,
			);
			if (alreadyCaptured) {
				return Promise.resolve(alreadyCaptured);
			}
			return new Promise((resolve) => {
				messageWaiters.push({ command, resolve });
			});
		},
		get allMessages(): CapturedMessage[] {
			return messages;
		},
	};
}

function installTelemetry(api: WeldExtensionApi): Telemetry {
	const refreshCallSites: string[] = [];
	let conflictStateChanged = 0;
	const originalRefresh = api.conflictedFilesProvider.refresh.bind(
		api.conflictedFilesProvider,
	);
	const refreshStub = sinon
		.stub(api.conflictedFilesProvider, "refresh")
		.callsFake(() => {
			refreshCallSites.push(refreshCallSite());
			originalRefresh();
		});
	const getChildrenSpy = sinon.spy(
		api.conflictedFilesProvider,
		"getChildren",
	);
	const conflictStateDisposable =
		api.meldCustomEditorProvider.onConflictStateChanged.event(() => {
			conflictStateChanged += 1;
		});
	return {
		get conflictStateChanged(): number {
			return conflictStateChanged;
		},
		refreshCallSites,
		refreshCount: () => refreshStub.callCount,
		getChildrenCount: () => getChildrenSpy.callCount,
		restore: () => {
			conflictStateDisposable.dispose();
			getChildrenSpy.restore();
			refreshStub.restore();
		},
	};
}

function refreshCallSite(): string {
	const stack =
		new Error("Captured refresh() call site").stack?.split("\n").slice(2) ??
		[];
	return (
		stack.find(isProductionRefreshFrame) ??
		stack[0] ??
		"<missing stack>"
	).trim();
}

function isProductionRefreshFrame(line: string): boolean {
	return !(
		line.includes("launch_telemetry.test.ts") ||
		line.includes("node_modules/sinon") ||
		line.includes("node_modules/@sinonjs") ||
		line.includes("node:internal")
	);
}

function printRefreshBlame(
	label: string,
	refreshCallSites: readonly string[],
): void {
	const grouped = new Map<string, number>();
	for (const callSite of refreshCallSites) {
		grouped.set(callSite, (grouped.get(callSite) ?? 0) + 1);
	}
	const lines = [...grouped.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([callSite, count]) => `  ${count}x ${callSite}`)
		.join("\n");
	process.stdout.write(`${label}\n${lines || "  <no refresh calls>"}\n`);
}

function installStateCounter(repository: GitApiRepository): StateCounter {
	let count = 0;
	const subscription = repository.state.onDidChange(() => {
		count += 1;
	});
	return {
		get count(): number {
			return count;
		},
		dispose: () => subscription.dispose(),
	};
}

function waitForQuiet(
	getCount: () => number,
	quietWindowMs = QUIET_WINDOW_MS,
	timeoutMs = QUIET_TIMEOUT_MS,
): Promise<void> {
	const pollMs = 50;
	return new Promise((resolve, reject) => {
		let last = getCount();
		let quietFor = 0;
		let elapsed = 0;
		const interval = setInterval(() => {
			elapsed += pollMs;
			if (elapsed > timeoutMs) {
				clearInterval(interval);
				reject(
					new Error(
						`Extension never went quiet after ${timeoutMs} ms; last count: ${getCount()}`,
					),
				);
				return;
			}
			const current = getCount();
			quietFor = current === last ? quietFor + pollMs : 0;
			last = current;
			if (quietFor >= quietWindowMs) {
				clearInterval(interval);
				resolve();
			}
		}, pollMs);
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openFixtureRepository(
	fixture: TempRepoFixture,
): Promise<GitApiRepository> {
	await openRepoInGitExtension(fixture.repoPath);
	const repository = getGitApi().getRepository(Uri.file(fixture.repoPath));
	assert.ok(repository, `Expected Git repository at ${fixture.repoPath}`);
	return repository;
}

async function makeTwoSubmoduleFixtures(): Promise<
	[TempRepoFixture, TempRepoFixture]
> {
	const fixture1 = await makeSubmoduleConflictFixture("weld-launch-tel-1-");
	const fixture2 = await makeSubmoduleConflictFixture("weld-launch-tel-2-");
	return [fixture1, fixture2];
}

async function cleanupFixtures(fixtures: TempRepoFixture[]): Promise<void> {
	const closePromises = fixtures.map((fixture) =>
		waitForRepoClose(fixture.repoPath),
	);
	await Promise.all(fixtures.map((fixture) => cleanupTempFixture(fixture)));
	await Promise.all(closePromises);
}

async function openTwoRepos(
	fixtures: [TempRepoFixture, TempRepoFixture],
): Promise<[GitApiRepository, GitApiRepository]> {
	const repo1 = await openFixtureRepository(fixtures[0]);
	const repo2 = await openFixtureRepository(fixtures[1]);
	return [repo1, repo2];
}

async function waitForBothMergeChanges(
	repositories: [GitApiRepository, GitApiRepository],
): Promise<void> {
	await Promise.all([
		waitForMergeChanges(repositories[0], 1),
		waitForMergeChanges(repositories[1], 1),
	]);
}

async function settleLaunch(
	telemetry: Telemetry,
	repositories: [GitApiRepository, GitApiRepository],
): Promise<void> {
	await waitForBothMergeChanges(repositories);
	await waitForQuiet(() => telemetry.refreshCount());
}

function resolveBundledSubmoduleEditor(repoPath: string): FakePanel {
	const provider = new weldApi.submoduleConflictEditorProvider(
		Uri.file("/tmp"),
		weldApi.conflictedFilesProvider,
	);
	const document = provider.openCustomDocument(
		submoduleDocumentUri(repoPath),
		{} as never,
		{} as never,
	);
	const panel = makeFakePanel();
	provider.resolveCustomEditor(
		document,
		panel as unknown as WebviewPanel,
		{} as never,
	);
	return panel;
}

function submoduleDocumentUri(repoPath: string): Uri {
	const identity: SubmoduleConflictIdentity = {
		repositoryRoot: Uri.file(repoPath),
		submodulePath: "sub",
	};
	return submoduleConflictUri(identity);
}

function snapshotCount(panel: FakePanel): number {
	return panel.allMessages.filter((message) => message.command === "snapshot")
		.length;
}

function terminalCount(panel: FakePanel): number {
	return panel.allMessages.filter(
		(message) =>
			message.command === "conflictLost" || message.command === "error",
	).length;
}

async function openReadySubmodulePanels(
	fixtures: [TempRepoFixture, TempRepoFixture],
): Promise<[FakePanel, FakePanel]> {
	const panel1 = resolveBundledSubmoduleEditor(fixtures[0].repoPath);
	const panel2 = resolveBundledSubmoduleEditor(fixtures[1].repoPath);
	const snapshot1 = panel1.nextMessage("snapshot");
	const snapshot2 = panel2.nextMessage("snapshot");
	await Promise.all([
		panel1.fireWebviewMessage({ command: "ready" }),
		panel2.fireWebviewMessage({ command: "ready" }),
		snapshot1,
		snapshot2,
	]);
	return [panel1, panel2];
}

describe("runtime telemetry — two repositories", () => {
	it("keeps repository-open operation counts bounded and prints refresh blame", async () => {
		const fixtures = await makeTwoSubmoduleFixtures();
		const telemetry = installTelemetry(weldApi);
		const stateCounters: StateCounter[] = [];
		try {
			const repositories = await openTwoRepos(fixtures);
			stateCounters.push(
				installStateCounter(repositories[0]),
				installStateCounter(repositories[1]),
			);
			const [stateCounter1, stateCounter2] = stateCounters;
			assert.ok(stateCounter1, "repo 1 state counter must exist");
			assert.ok(stateCounter2, "repo 2 state counter must exist");
			await settleLaunch(telemetry, repositories);
			const refreshAtSettle = telemetry.refreshCount();
			const stateAtSettle = stateCounters.map((counter) => counter.count);
			await waitForQuiet(
				() =>
					telemetry.refreshCount() +
					stateCounter1.count +
					stateCounter2.count,
			);
			printRefreshBlame(
				"refresh() call sites during launch:",
				telemetry.refreshCallSites,
			);
			assertBoundedStateChanges(stateCounters);
			assert.ok(
				telemetry.refreshCount() <= REFRESH_CEILING,
				`expected <= ${REFRESH_CEILING} refreshes, got ${telemetry.refreshCount()}`,
			);
			process.stdout.write(
				`getChildren calls: ${telemetry.getChildrenCount()} (refresh calls: ${telemetry.refreshCount()})\n`,
			);
			assert.ok(
				telemetry.conflictStateChanged <=
					CONFLICT_STATE_CHANGED_CEILING,
				`expected <= ${CONFLICT_STATE_CHANGED_CEILING} conflict-state events, got ${telemetry.conflictStateChanged}`,
			);
			assert.equal(telemetry.refreshCount(), refreshAtSettle);
			assert.deepEqual(
				stateCounters.map((counter) => counter.count),
				stateAtSettle,
			);
		} finally {
			for (const counter of stateCounters) {
				counter.dispose();
			}
			telemetry.restore();
			await cleanupFixtures(fixtures);
		}
	});

	it("stays silent after launch settles", async () => {
		const fixtures = await makeTwoSubmoduleFixtures();
		const launchTelemetry = installTelemetry(weldApi);
		try {
			const repositories = await openTwoRepos(fixtures);
			await settleLaunch(launchTelemetry, repositories);
			launchTelemetry.restore();
			await assertSteadyStateSilence(repositories);
		} finally {
			await cleanupFixtures(fixtures);
		}
	});
});

describe("runtime telemetry — submodule tab startup", () => {
	it("opens restored submodule tabs without touching the tree", async () => {
		const fixtures = await makeTwoSubmoduleFixtures();
		const launchTelemetry = installTelemetry(weldApi);
		let telemetry: Telemetry | undefined;
		try {
			const repositories = await openTwoRepos(fixtures);
			await settleLaunch(launchTelemetry, repositories);
			launchTelemetry.restore();
			telemetry = installTelemetry(weldApi);
			const [panel1, panel2] = await openReadySubmodulePanels(fixtures);
			await waitForQuiet(() => telemetry?.refreshCount() ?? 0);
			assert.equal(telemetry.refreshCount(), 0);
			assert.equal(telemetry.getChildrenCount(), 0);
			assertSubmodulePanelHealthy(panel1);
			assertSubmodulePanelHealthy(panel2);
			panel1.dispose();
			panel2.dispose();
		} finally {
			telemetry?.restore();
			await cleanupFixtures(fixtures);
		}
	});

	it("posts one live snapshot per repository refresh signal", async () => {
		// Each panel receives its initial snapshot from the "ready" handshake
		// (SNAPSHOTS_PER_TAB = 1). A subsequent notifyRepositoryStateChanged call
		// must trigger exactly one additional snapshot per panel, proving that
		// editors respond to live state changes and that the startup path does
		// not suppress real refresh signals.
		const fixtures = await makeTwoSubmoduleFixtures();
		const launchTelemetry = installTelemetry(weldApi);
		try {
			const repositories = await openTwoRepos(fixtures);
			await settleLaunch(launchTelemetry, repositories);
			const [panel1, panel2] = await openReadySubmodulePanels(fixtures);
			weldApi.notifyRepositoryStateChanged(repositories[0]);
			weldApi.notifyRepositoryStateChanged(repositories[1]);
			await waitForQuiet(
				() =>
					snapshotCount(panel1) +
					snapshotCount(panel2) +
					launchTelemetry.refreshCount(),
				RACE_QUIET_WINDOW_MS,
			);
			assert.equal(
				snapshotCount(panel1),
				SNAPSHOTS_PER_TAB + 1,
				`panel1: expected ${SNAPSHOTS_PER_TAB + 1} snapshots (initial + refresh signal)`,
			);
			assert.equal(
				snapshotCount(panel2),
				SNAPSHOTS_PER_TAB + 1,
				`panel2: expected ${SNAPSHOTS_PER_TAB + 1} snapshots (initial + refresh signal)`,
			);
			assert.equal(
				terminalCount(panel1),
				0,
				"panel1: no terminal errors",
			);
			assert.equal(
				terminalCount(panel2),
				0,
				"panel2: no terminal errors",
			);
			panel1.dispose();
			panel2.dispose();
		} finally {
			launchTelemetry.restore();
			await cleanupFixtures(fixtures);
		}
	});
});

function assertBoundedStateChanges(stateCounters: StateCounter[]): void {
	for (const [index, counter] of stateCounters.entries()) {
		assert.ok(
			counter.count >= 1 && counter.count <= STATE_CHANGES_CEILING,
			`repo ${index + 1}: expected 1-${STATE_CHANGES_CEILING} state changes, got ${counter.count}`,
		);
	}
}

async function assertSteadyStateSilence(
	repositories: [GitApiRepository, GitApiRepository],
): Promise<void> {
	const telemetry = installTelemetry(weldApi);
	const stateCounters = repositories.map((repo) => installStateCounter(repo));
	try {
		await delay(STEADY_STATE_WINDOW_MS);
		printRefreshBlame(
			"refresh() call sites during steady state:",
			telemetry.refreshCallSites,
		);
		assert.equal(telemetry.refreshCount(), 0);
		assert.equal(telemetry.getChildrenCount(), 0);
		assert.equal(stateCounters[0]?.count, 0);
		assert.equal(stateCounters[1]?.count, 0);
		assert.equal(telemetry.conflictStateChanged, 0);
	} finally {
		for (const counter of stateCounters) {
			counter.dispose();
		}
		telemetry.restore();
	}
}

function assertSubmodulePanelHealthy(panel: FakePanel): void {
	assert.equal(
		snapshotCount(panel),
		SNAPSHOTS_PER_TAB,
		`expected ${SNAPSHOTS_PER_TAB} snapshot, got ${snapshotCount(panel)}`,
	);
	assert.equal(
		terminalCount(panel),
		0,
		`unexpected terminal messages: ${JSON.stringify(panel.allMessages)}`,
	);
}
