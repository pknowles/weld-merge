import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "mocha";
import sinon from "sinon";
import type { Disposable, TextDocument, WebviewPanel } from "vscode";
import { extensions, Uri, workspace } from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { initializeWeldLogChannel } from "../../../src/log.ts";
import {
	type GitApiRepository,
	getGitApi,
	notifyRepositoryStateChanged,
} from "../../../src/repoContext.ts";
import {
	type SubmoduleConflictIdentity,
	submoduleConflictUri,
} from "../../../src/submoduleConflict.ts";
import { ConflictedFilesProvider } from "../../../src/treeView.ts";
import type { MeldCustomEditorProvider } from "../../../src/webview/meldWebviewPanel.ts";
import { SubmoduleConflictEditorProvider } from "../../../src/webview/submoduleConflictEditor.ts";
import type { WebviewPayload } from "../../../src/webview/ui/types.ts";
import {
	cleanupTempFixture,
	makeConflict,
	makeRepoFixture,
	makeSubmoduleConflictFixture,
	openRepoInGitExtension,
	type TempRepoFixture,
} from "./helpers.ts";

interface CapturedMessage {
	command: string;
	data?: unknown;
	snapshot?: {
		base?: unknown;
		local?: unknown;
		remote?: unknown;
	};
	message?: unknown;
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
	nextHtmlChange(): Promise<string>;
	allMessages: CapturedMessage[];
}

type GitApi = ReturnType<typeof getGitApi>;
interface GitExtensionExports {
	getAPI(version: number): GitApi;
}

const SHA_REGEX = /^[0-9a-f]{40}$/u;
const WEBVIEW_ROOT_REGEX = /<div id="root"><\/div>/u;
const CANNOT_OPEN_REGEX = /Cannot open:/u;
const LOADING_REGEX = /Loading\.\.\./u;
const NO_SUBMODULE_SNAPSHOT_REGEX = /No submodule snapshot/u;
const GIT_REPOSITORY_UNAVAILABLE_REGEX = /Git repository is not available/u;
const NOT_IN_REPOSITORY_TEXT = "Cannot open: file is not in a git repository.";
const NOT_IN_REPOSITORY_REGEX = new RegExp(NOT_IN_REPOSITORY_TEXT, "u");

let MeldProviderClass: typeof MeldCustomEditorProvider;

before(async () => {
	initializeWeldLogChannel();
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	const api = (await ext.activate()) as WeldExtensionApi;
	MeldProviderClass = api.meldCustomEditorProvider;
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
	const htmlChangeWaiters: Array<(html: string) => void> = [];

	const panel: FakePanel = {
		webview: {
			get html(): string {
				return html;
			},
			set html(value: string) {
				html = value;
				for (const waiter of htmlChangeWaiters.splice(0)) {
					waiter(value);
				}
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
					if (!waiter) {
						throw new Error("Missing message waiter.");
					}
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
			for (const listener of disposeListeners) {
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
		nextHtmlChange(): Promise<string> {
			return new Promise((resolve) => {
				htmlChangeWaiters.push(resolve);
			});
		},
		get allMessages(): CapturedMessage[] {
			return messages;
		},
	};

	return panel;
}

function targetUriMatches(repoPath: string, uri: Uri): boolean {
	return uri.fsPath === repoPath || uri.fsPath.startsWith(`${repoPath}/`);
}

function gitExtensionExports(): GitExtensionExports {
	const gitExt = extensions.getExtension<GitExtensionExports>("vscode.git");
	assert.ok(gitExt, "Git extension must be available");
	return gitExt.exports;
}

async function nextMergeChanges(
	repository: GitApiRepository,
	expectedCount: number,
): Promise<void> {
	if (repository.state.mergeChanges.length === expectedCount) {
		return;
	}
	await new Promise<void>((resolve) => {
		const subscription = repository.state.onDidChange(() => {
			if (repository.state.mergeChanges.length === expectedCount) {
				subscription.dispose();
				resolve();
			}
		});
	});
}

async function nextRepoClose(repoPath: string): Promise<void> {
	const gitApi = getGitApi();
	if (!gitApi.getRepository(Uri.file(repoPath))) {
		return;
	}
	await new Promise<void>((resolve) => {
		const subscription = gitApi.onDidCloseRepository((repository) => {
			if (repository.rootUri.fsPath === repoPath) {
				subscription.dispose();
				resolve();
			}
		});
	});
}

async function openRepoWithMergeChanges(
	repoPath: string,
	expectedCount: number,
): Promise<GitApiRepository> {
	await openRepoInGitExtension(repoPath);
	const repository = getGitApi().getRepository(Uri.file(repoPath));
	assert.ok(repository, `Expected Git repository at ${repoPath}`);
	await nextMergeChanges(repository, expectedCount);
	return repository;
}

async function withRepositoryUnavailable(
	repoPath: string,
	expectedCount: number,
	runTest: (release: () => Promise<GitApiRepository>) => Promise<void>,
): Promise<void> {
	const gitExports = gitExtensionExports();
	const originalGetAPI = gitExports.getAPI.bind(gitExports);
	let released = false;
	const getAPIStub = sinon
		.stub(gitExports, "getAPI")
		.callsFake((version: number): GitApi => {
			const realApi = originalGetAPI(version);
			const originalGetRepository = realApi.getRepository.bind(realApi);
			realApi.getRepository = (uri: Uri): GitApiRepository | null => {
				if (!released && targetUriMatches(repoPath, uri)) {
					return null;
				}
				return originalGetRepository(uri);
			};
			const originalRepositories = realApi.repositories;
			Object.defineProperty(realApi, "repositories", {
				configurable: true,
				get: () =>
					released
						? originalRepositories
						: originalRepositories.filter(
								(repository) =>
									repository.rootUri.fsPath !== repoPath,
							),
			});
			return realApi;
		});
	try {
		await runTest(async () => {
			released = true;
			const repository = await openRepoWithMergeChanges(
				repoPath,
				expectedCount,
			);
			return repository;
		});
	} finally {
		getAPIStub.restore();
	}
}

async function withGitApiUninitialized(
	runTest: (release: () => void) => Promise<void>,
): Promise<void> {
	const gitExports = gitExtensionExports();
	const originalGetAPI = gitExports.getAPI.bind(gitExports);
	let released = false;
	const stateListeners: Array<(state: "initialized") => void> = [];

	const getAPIStub = sinon
		.stub(gitExports, "getAPI")
		.callsFake((version: number): GitApi => {
			const realApi = originalGetAPI(version);
			return new Proxy(realApi, {
				get(target, property, receiver) {
					if (property === "state") {
						return released ? "initialized" : "uninitialized";
					}
					if (property === "onDidChangeState") {
						return (listener: (state: "initialized") => void) => {
							stateListeners.push(listener);
							return {
								dispose: () => {
									const index =
										stateListeners.indexOf(listener);
									if (index !== -1) {
										stateListeners.splice(index, 1);
									}
								},
							};
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function"
						? value.bind(target)
						: value;
				},
			});
		});
	try {
		await runTest(() => {
			released = true;
			for (const listener of stateListeners.splice(0)) {
				listener("initialized");
			}
		});
	} finally {
		getAPIStub.restore();
	}
}

async function withEmptyMergeChanges(
	repoPath: string,
	runTest: (release: () => Promise<GitApiRepository>) => Promise<void>,
): Promise<void> {
	const realRepository = await openRepoWithMergeChanges(repoPath, 1);
	const gitExports = gitExtensionExports();
	const originalGetAPI = gitExports.getAPI.bind(gitExports);
	let released = false;

	const getAPIStub = sinon
		.stub(gitExports, "getAPI")
		.callsFake((version: number): GitApi => {
			const realApi = originalGetAPI(version);
			const originalGetRepository = realApi.getRepository.bind(realApi);
			const wrapperState = {
				onDidChange: realRepository.state.onDidChange,
			};
			Object.defineProperty(wrapperState, "mergeChanges", {
				configurable: true,
				get: () => (released ? realRepository.state.mergeChanges : []),
			});
			const wrapperRepository: GitApiRepository = {
				rootUri: realRepository.rootUri,
				state: wrapperState as GitApiRepository["state"],
				status: realRepository.status.bind(realRepository),
				show: realRepository.show.bind(realRepository),
				getCommit: realRepository.getCommit.bind(realRepository),
				getMergeBase: realRepository.getMergeBase.bind(realRepository),
				add: realRepository.add.bind(realRepository),
			};
			realApi.getRepository = (uri: Uri): GitApiRepository | null => {
				if (targetUriMatches(repoPath, uri)) {
					return wrapperRepository;
				}
				return originalGetRepository(uri);
			};
			const originalRepositories = realApi.repositories;
			Object.defineProperty(realApi, "repositories", {
				configurable: true,
				get: () =>
					originalRepositories.map((repository) =>
						repository.rootUri.fsPath === repoPath
							? wrapperRepository
							: repository,
					),
			});
			return realApi;
		});
	try {
		await runTest(() => {
			released = true;
			return Promise.resolve(realRepository);
		});
	} finally {
		getAPIStub.restore();
	}
}

function submoduleDocumentUri(repoPath: string): Uri {
	const identity: SubmoduleConflictIdentity = {
		repositoryRoot: Uri.file(repoPath),
		submodulePath: "sub",
	};
	return submoduleConflictUri(identity);
}

function createSubmoduleProvider(): SubmoduleConflictEditorProvider {
	return new SubmoduleConflictEditorProvider(
		Uri.file("/tmp"),
		new ConflictedFilesProvider(),
	);
}

function createSubmoduleDocument(
	provider: SubmoduleConflictEditorProvider,
	repoPath: string,
) {
	return provider.openCustomDocument(
		submoduleDocumentUri(repoPath),
		{} as never,
		{} as never,
	);
}

function assertNormalWebviewShell(
	panel: FakePanel,
	expectedScript: "index.js" | "submodule.js",
): void {
	assert.match(panel.webview.html, WEBVIEW_ROOT_REGEX);
	assert.match(panel.webview.html, new RegExp(expectedScript, "u"));
	assert.doesNotMatch(panel.webview.html, CANNOT_OPEN_REGEX);
	assert.doesNotMatch(panel.webview.html, NO_SUBMODULE_SNAPSHOT_REGEX);
	assert.doesNotMatch(panel.webview.html, GIT_REPOSITORY_UNAVAILABLE_REGEX);
}

function assertNoTerminalSubmoduleMessage(panel: FakePanel): void {
	const terminal = panel.allMessages.find(
		(message) =>
			message.command === "error" || message.command === "conflictLost",
	);
	assert.equal(
		terminal,
		undefined,
		`Unexpected terminal submodule message: ${JSON.stringify(terminal)}`,
	);
}

function assertSnapshotMessage(message: CapturedMessage): void {
	assert.equal(message.command, "snapshot");
	assert.match(String(message.snapshot?.base), SHA_REGEX);
	assert.match(String(message.snapshot?.local), SHA_REGEX);
	assert.match(String(message.snapshot?.remote), SHA_REGEX);
}

function asLoadDiff(message: CapturedMessage): WebviewPayload["data"] {
	return message.data as WebviewPayload["data"];
}

function resolveSubmoduleEditor(repoPath: string): {
	panel: FakePanel;
	provider: SubmoduleConflictEditorProvider;
} {
	const provider = createSubmoduleProvider();
	const document = createSubmoduleDocument(provider, repoPath);
	const panel = makeFakePanel();
	provider.resolveCustomEditor(
		document,
		panel as unknown as WebviewPanel,
		{} as never,
	);
	return { panel, provider };
}

async function cleanupRepoFixture(fixture: TempRepoFixture): Promise<void> {
	const closePromise = nextRepoClose(fixture.repoPath);
	await cleanupTempFixture(fixture);
	await closePromise;
}

describe("custom editor Git initialization race — submodule tabs", () => {
	it("keeps a restored submodule tab loading until an unavailable repository initializes", async () => {
		const fixture = await makeSubmoduleConflictFixture(
			"weld-initialization-submodule-repo-",
		);
		const { repoPath } = fixture;
		try {
			await withRepositoryUnavailable(repoPath, 1, async (release) => {
				const { panel } = resolveSubmoduleEditor(repoPath);
				const snapshotPromise = panel.nextMessage("snapshot");

				await panel.fireWebviewMessage({ command: "ready" });

				assertNoTerminalSubmoduleMessage(panel);
				assertNormalWebviewShell(panel, "submodule.js");

				const repo = await release();
				notifyRepositoryStateChanged(repo);
				assertSnapshotMessage(await snapshotPromise);
			});
		} finally {
			await cleanupRepoFixture(fixture);
		}
	});

	it("sends a snapshot when merge metadata initializes after a ready webview", async () => {
		const fixture = await makeSubmoduleConflictFixture(
			"weld-initialization-submodule-state-",
		);
		const { repoPath } = fixture;
		try {
			await withEmptyMergeChanges(repoPath, async (release) => {
				const { panel } = resolveSubmoduleEditor(repoPath);
				const snapshotPromise = panel.nextMessage("snapshot");

				await panel.fireWebviewMessage({ command: "ready" });

				assertNormalWebviewShell(panel, "submodule.js");

				const repo = await release();
				notifyRepositoryStateChanged(repo);
				assertSnapshotMessage(await snapshotPromise);
			});
		} finally {
			await cleanupRepoFixture(fixture);
		}
	});

	it("renders a restored submodule tab immediately when Git is already initialized", async () => {
		const fixture = await makeSubmoduleConflictFixture(
			"weld-initialization-submodule-initialized-",
		);
		const { repoPath } = fixture;
		try {
			await openRepoWithMergeChanges(repoPath, 1);
			const { panel } = resolveSubmoduleEditor(repoPath);
			const snapshotPromise = panel.nextMessage("snapshot");

			await panel.fireWebviewMessage({ command: "ready" });

			assertSnapshotMessage(await snapshotPromise);
			assertNoTerminalSubmoduleMessage(panel);
			assertNormalWebviewShell(panel, "submodule.js");
		} finally {
			await cleanupRepoFixture(fixture);
		}
	});
});

describe("custom editor Git initialization race — text conflict tabs", () => {
	it("keeps a restored text-conflict tab loading until the Git API initializes", async () => {
		const fixture = await makeRepoFixture("weld-initialization-file-repo-");
		const { repoPath } = fixture;
		try {
			makeConflict(repoPath);
			await openRepoWithMergeChanges(repoPath, 1);
			await withGitApiUninitialized(async (release) => {
				const fileUri = Uri.file(join(repoPath, "tracked.txt"));
				const document = await workspace.openTextDocument(fileUri);
				const panel = makeFakePanel();
				const provider = new MeldProviderClass(Uri.file("/tmp"));

				// resolveCustomTextEditor suspends inside repository acquisition
				// until the git repo becomes available — do not await yet.
				const resolvePromise = provider.resolveCustomTextEditor(
					document,
					panel as unknown as WebviewPanel,
					{} as never,
				);

				assert.match(
					panel.webview.html,
					LOADING_REGEX,
					"loading shell while git is initializing",
				);
				assert.doesNotMatch(
					panel.webview.html,
					NOT_IN_REPOSITORY_REGEX,
				);

				const htmlChangePromise = panel.nextHtmlChange();
				release();
				await htmlChangePromise;

				assert.doesNotMatch(
					panel.webview.html,
					NOT_IN_REPOSITORY_REGEX,
				);
				assertNormalWebviewShell(panel, "index.js");

				const loadDiffPromise = panel.nextMessage("loadDiff");
				await panel.fireWebviewMessage({ command: "ready" });

				const loadDiff = asLoadDiff(await loadDiffPromise);
				assert.equal(
					loadDiff.files[0]?.content,
					"local\n",
					"local pane",
				);
				assert.equal(
					loadDiff.files[2]?.content,
					"remote\n",
					"remote pane",
				);

				await resolvePromise;
			});
		} finally {
			await cleanupRepoFixture(fixture);
		}
	});

	it("renders a restored text-conflict tab immediately when Git is already initialized", async () => {
		const fixture = await makeRepoFixture(
			"weld-initialization-file-initialized-",
		);
		const { repoPath } = fixture;
		try {
			makeConflict(repoPath);
			await openRepoWithMergeChanges(repoPath, 1);
			const fileUri = Uri.file(join(repoPath, "tracked.txt"));
			const document: TextDocument =
				await workspace.openTextDocument(fileUri);
			const panel = makeFakePanel();
			const provider = new MeldProviderClass(Uri.file("/tmp"));
			const loadDiffPromise = panel.nextMessage("loadDiff");

			await provider.resolveCustomTextEditor(
				document,
				panel as unknown as WebviewPanel,
				{} as never,
			);
			await panel.fireWebviewMessage({ command: "ready" });

			const loadDiff = asLoadDiff(await loadDiffPromise);
			assert.equal(loadDiff.files[0]?.content, "local\n", "local pane");
			assert.equal(loadDiff.files[2]?.content, "remote\n", "remote pane");
			assertNormalWebviewShell(panel, "index.js");
		} finally {
			await cleanupRepoFixture(fixture);
		}
	});
});
