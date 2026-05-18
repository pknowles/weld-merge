import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "mocha";
import sinon from "sinon";
import type { TextDocument, WebviewPanel } from "vscode";
import { commands, EventEmitter, extensions, Uri, window } from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import {
	type ConflictedItem,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	type GitApiRepository,
	type GitConflictStage,
	GitStatus,
	getGitApi,
} from "../../../src/repoContext.ts";
import type { MeldCustomEditorProvider } from "../../../src/webview/meldWebviewPanel.ts";
import {
	getConflictedItem,
	lsFilesStages,
	makeBothAddedConflict,
	makeConflict,
	makeDeletedByThemConflict,
	makeDeletedByUsConflict,
	makeRepo,
	makeRepoFile,
	openRepoInGitExtension,
	runGit,
	waitForMergeChanges,
	waitForRepoClose,
	withConflictRepo,
	workingTreeContent,
} from "./helpers.ts";

interface CapturedInitArgs {
	conflictedItem: ConflictedItem;
}

interface FakeWebview {
	html: string;
	options: {
		enableScripts?: boolean;
		localResourceRoots?: Uri[];
	};
}

interface FakePanel {
	webview: FakeWebview;
}

type InitializeWebviewFn = (
	document: TextDocument,
	webviewPanel: WebviewPanel,
	conflictedItem: ConflictedItem,
) => void;

// Resolved in the before() hook to the bundled class so that static fields
// (e.g. onConflictStateChanged) are the same instance as the running extension.
let MeldProviderClass: typeof MeldCustomEditorProvider;
let restoreConflictedFileFn: WeldExtensionApi["restoreConflictedFile"];

const BOTH_SIDES_DELETED_REGEX = /both sides deleted/;
const LOCAL_DELETED_REGEX = /Local deleted/;
const REMOTE_MODIFIED_REGEX = /Remote modified/;
const REMOTE_DELETED_REGEX = /Remote deleted/;
const LOCAL_MODIFIED_REGEX = /Local modified/;
const CHECKOUT_FAILED_UNEXPECTEDLY_REGEX = /checkout -m failed unexpectedly/;
const BASE_TO_LOCAL_TITLE_REGEX = /Base ↔ Local/;
const GIT_STAGE_BASE = 1;

before(async () => {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	const api = (await ext.activate()) as WeldExtensionApi;
	MeldProviderClass = api.meldCustomEditorProvider;
	restoreConflictedFileFn = api.restoreConflictedFile;
});

function makeFakePanel(): FakePanel {
	return {
		webview: {
			html: "",
			options: {},
		},
	};
}

function makeDocument(uri: Uri): TextDocument {
	return { uri } as TextDocument;
}

async function resolveEditorHtml(documentUri: Uri): Promise<string> {
	const provider = new MeldProviderClass(Uri.file("/tmp"));
	const panel = makeFakePanel();
	await provider.resolveCustomTextEditor(
		makeDocument(documentUri),
		panel as unknown as WebviewPanel,
		{} as never,
	);
	return panel.webview.html;
}

function stubInitializeWebview(
	provider: MeldCustomEditorProvider,
	sink: CapturedInitArgs[],
): void {
	// These tests care about the repo root and relative path chosen by
	// resolveCustomTextEditor(). Intercepting the final private call lets the
	// test assert exactly what would be passed into the real webview bootstrap
	// without depending on unrelated webview HTML/setup details.
	(
		provider as unknown as { _initializeWebview: InitializeWebviewFn }
	)._initializeWebview = (_document, _webviewPanel, conflictedItem) => {
		sink.push({ conflictedItem });
	};
}

async function assertConflictedItemResolution(
	repoPath: string,
	relativeFilePath: string,
): Promise<CapturedInitArgs[]> {
	await openRepoInGitExtension(repoPath);
	const provider = new MeldProviderClass(Uri.file("/tmp"));
	const panel = makeFakePanel();
	const captured: CapturedInitArgs[] = [];
	stubInitializeWebview(provider, captured);
	const fileUri = await makeRepoFile(repoPath, relativeFilePath);
	await provider.resolveCustomTextEditor(
		makeDocument(fileUri),
		panel as unknown as WebviewPanel,
		{} as never,
	);
	return captured;
}

function assertDeleteModifyConflictRestored(
	repoPath: string,
	fileName: string,
	expectedStatus: "DU" | "UD",
	expectedContent: string,
	expectedStages: Set<number>,
): void {
	assert.equal(workingTreeContent(repoPath, fileName), expectedContent);
	assert.deepEqual(lsFilesStages(repoPath, fileName), expectedStages);
	assert.equal(
		runGit(["status", "--short", "--", fileName], repoPath),
		`${expectedStatus} ${fileName}`,
	);
}

async function chooseDeleteModifyAction(
	repoPath: string,
	remainingStage: GitConflictStage,
	choice: "Keep File" | "Delete File" | undefined,
): Promise<void> {
	const ctx = getConflictedItem(repoPath, "tracked.txt");
	const stub = sinon
		.stub(window, "showWarningMessage")
		.resolves(choice as never);
	try {
		await MeldProviderClass.handleDeleteModifyConflict(ctx, remainingStage);
	} finally {
		stub.restore();
	}
}

function assertNoUnmergedStages(repoPath: string, fileName: string): void {
	assert.deepEqual(lsFilesStages(repoPath, fileName), new Set());
}

async function assertGitApiConflictShape(
	repoPath: string,
	fileName: string,
	expectedStatus: number,
	expectedStages: Set<number>,
): Promise<void> {
	const repo = getGitApi().getRepository(Uri.file(repoPath));
	assert.ok(repo);
	const fileUri = Uri.file(join(repoPath, fileName));
	const conflictChange = repo.state.mergeChanges.find(
		(change) => change.uri.toString() === fileUri.toString(),
	);
	assert.ok(conflictChange);
	assert.equal(conflictChange.status, expectedStatus);

	await Promise.all(
		[GIT_STAGE_BASE, GIT_STAGE_LOCAL, GIT_STAGE_REMOTE].map((stage) => {
			const stageContent = repo.show(`:${stage}`, fileUri.fsPath);
			return expectedStages.has(stage)
				? assert.doesNotReject(stageContent)
				: assert.rejects(stageContent);
		}),
	);
}

async function assertBothDeletedCustomEditorStatus(
	repoPath: string,
): Promise<void> {
	await openRepoInGitExtension(repoPath);
	const fileUri = Uri.file(join(repoPath, "tracked.txt"));
	const changeEmitter = new EventEmitter<void>();
	const repository: GitApiRepository = {
		rootUri: Uri.file(repoPath),
		state: {
			mergeChanges: [
				{
					uri: fileUri,
					status: GitStatus.BOTH_DELETED,
				},
			],
			onDidChange: changeEmitter.event,
		},
		show: () => Promise.reject(new Error("not used")),
		getCommit: () => Promise.reject(new Error("not used")),
		getMergeBase: () => Promise.reject(new Error("not used")),
		add: () => Promise.reject(new Error("not used")),
	};
	const provider = new MeldProviderClass(Uri.file("/tmp"));
	const panel = makeFakePanel();
	const captured: CapturedInitArgs[] = [];
	stubInitializeWebview(provider, captured);
	const errorStub = sinon.stub(window, "showErrorMessage");
	try {
		await withMockGitRepository(repository, () =>
			provider.resolveCustomTextEditor(
				makeDocument(fileUri),
				panel as unknown as WebviewPanel,
				{} as never,
			),
		);
	} finally {
		errorStub.restore();
	}
	assert.equal(captured.length, 0);
	assert.equal(
		panel.webview.html,
		"<p>Unexpected conflict state: both sides deleted this file.</p>",
	);
	assert.equal(errorStub.callCount, 1);
	assert.match(String(errorStub.firstCall.args[0]), BOTH_SIDES_DELETED_REGEX);
}

async function assertMisreportedBothDeletedCustomEditorStatus(
	repoPath: string,
): Promise<void> {
	await openRepoInGitExtension(repoPath);
	const fileUri = Uri.file(join(repoPath, "tracked.txt"));
	const changeEmitter = new EventEmitter<void>();
	const repository: GitApiRepository = {
		rootUri: Uri.file(repoPath),
		state: {
			mergeChanges: [
				{
					uri: fileUri,
					status: GitStatus.BOTH_DELETED,
				},
			],
			onDidChange: changeEmitter.event,
		},
		show: (ref: string) => Promise.resolve(`content for ${ref}`),
		getCommit: () => Promise.reject(new Error("not used")),
		getMergeBase: () => Promise.reject(new Error("not used")),
		add: () => Promise.reject(new Error("not used")),
	};
	const provider = new MeldProviderClass(Uri.file("/tmp"));
	const panel = makeFakePanel();
	const captured: CapturedInitArgs[] = [];
	stubInitializeWebview(provider, captured);
	const errorStub = sinon.stub(window, "showErrorMessage");
	try {
		await withMockGitRepository(repository, () =>
			provider.resolveCustomTextEditor(
				makeDocument(fileUri),
				panel as unknown as WebviewPanel,
				{} as never,
			),
		);
	} finally {
		errorStub.restore();
	}
	assert.equal(captured.length, 1);
	assert.equal(
		captured[0]?.conflictedItem.uri.toString(),
		fileUri.toString(),
	);
	assert.equal(errorStub.callCount, 0);
}

async function withMockGitRepository(
	repository: GitApiRepository,
	runTest: () => Promise<void>,
): Promise<void> {
	const gitExt = extensions.getExtension("vscode.git");
	assert.ok(gitExt, "Git extension must be available");
	const originalGetAPI = gitExt.exports.getAPI.bind(gitExt.exports);
	const getAPIStub = sinon
		.stub(gitExt.exports, "getAPI")
		.callsFake((...args: unknown[]) => {
			const realApi = originalGetAPI(args[0] as number);
			const originalGetRepository = realApi.getRepository.bind(realApi);
			realApi.getRepository = (uri: Uri) => {
				if (
					uri.toString() === repository.rootUri.toString() ||
					uri.fsPath.startsWith(`${repository.rootUri.fsPath}/`)
				) {
					return repository;
				}
				return originalGetRepository(uri);
			};
			return realApi;
		});
	try {
		await runTest();
	} finally {
		getAPIStub.restore();
	}
}

async function executeOpenMeldDiffAndCapture(
	repoPath: string,
	fileName: string,
): Promise<{
	openWithCalls: Array<readonly unknown[]>;
	warningCalls: Array<readonly unknown[]>;
}> {
	const openWithCalls: Array<readonly unknown[]> = [];
	const originalExecuteCommand = commands.executeCommand.bind(commands);
	const executeStub = sinon
		.stub(commands, "executeCommand")
		.callsFake((command: string, ...args: unknown[]) => {
			if (command === "vscode.openWith") {
				openWithCalls.push(args);
				return Promise.resolve(undefined);
			}
			return originalExecuteCommand(
				command,
				...args,
			) as Thenable<unknown>;
		});
	const warningStub = sinon
		.stub(window, "showWarningMessage")
		.resolves(undefined);
	try {
		await originalExecuteCommand("meld-auto-merge.openMeldDiff", {
			uri: Uri.file(join(repoPath, fileName)),
		});
		return {
			openWithCalls,
			warningCalls: warningStub.getCalls().map((call) => call.args),
		};
	} finally {
		executeStub.restore();
		warningStub.restore();
	}
}

describe("MeldCustomEditorProvider.resolveCustomTextEditor", () => {
	it("shows unsupported-scheme message for non-file URIs", async () => {
		assert.equal(
			await resolveEditorHtml(Uri.parse("untitled:weld")),
			'<p>Cannot open: unsupported URI scheme "untitled".</p>',
		);
	});

	it("does not reject vscode-remote URIs at the scheme gate", async () => {
		assert.equal(
			await resolveEditorHtml(
				Uri.parse(
					"vscode-remote://ssh-remote%2Bexample-host/home/example/repo/file.ts",
				),
			),
			"<p>Cannot open: file is not in a git repository.</p>",
		);
	});

	it("shows not-a-git-repository message for files outside repositories", async () => {
		assert.equal(
			await resolveEditorHtml(
				Uri.file(`/tmp/weld-outside-${Date.now()}.txt`),
			),
			"<p>Cannot open: file is not in a git repository.</p>",
		);
	});

	it("resolves repo and relative path for a subdirectory file", async () => {
		const repoPath = await makeRepo("weld-vscode-editor-subdir-");
		try {
			const captured = await assertConflictedItemResolution(
				repoPath,
				"src/deep/path/file.ts",
			);
			assert.equal(captured.length, 1);
			const first = captured[0];
			assert.ok(first);
			assert.equal(first.conflictedItem.rootUri.fsPath, repoPath);
			assert.equal(
				first.conflictedItem.uri.fsPath,
				`${repoPath}/src/deep/path/file.ts`,
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("resolves repo and relative path for a linked worktree file", async () => {
		const repoPath = await makeRepo("weld-vscode-editor-worktree-main-");
		const worktreePath = `${repoPath}-linked`;
		runGit(
			["worktree", "add", "-b", "editor-linked-worktree", worktreePath],
			repoPath,
		);
		try {
			const captured = await assertConflictedItemResolution(
				worktreePath,
				"worktree-file.ts",
			);
			assert.equal(captured.length, 1);
			const first = captured[0];
			assert.ok(first);
			assert.equal(first.conflictedItem.rootUri.fsPath, worktreePath);
			assert.equal(
				first.conflictedItem.uri.fsPath,
				`${worktreePath}/worktree-file.ts`,
			);
		} finally {
			const closePromise = waitForRepoClose(worktreePath);
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

// Group A: resolveCustomTextEditor safety net — conflict status handling.
describe("MeldCustomEditorProvider.resolveCustomTextEditor — conflict status handling", () => {
	async function resolveAndCapture(
		repoPath: string,
		fileName: string,
	): Promise<{ html: string; captured: CapturedInitArgs[] }> {
		await openRepoInGitExtension(repoPath);
		const repo = getGitApi().getRepository(Uri.file(repoPath));
		assert.ok(repo);
		await waitForMergeChanges(repo, 1);
		const provider = new MeldProviderClass(Uri.file("/tmp"));
		const panel = makeFakePanel();
		const captured: CapturedInitArgs[] = [];
		stubInitializeWebview(provider, captured);
		const warningStub = sinon
			.stub(window, "showWarningMessage")
			.resolves(undefined);
		try {
			await provider.resolveCustomTextEditor(
				makeDocument(Uri.file(join(repoPath, fileName))),
				panel as unknown as WebviewPanel,
				{} as never,
			);
		} finally {
			warningStub.restore();
		}
		return { html: panel.webview.html, captured };
	}

	it("shows delete/modify message and skips 3-way init when local deleted and remote modified", async () => {
		const repoPath = await makeRepo("weld-deleted-by-us-");
		try {
			makeDeletedByUsConflict(repoPath);
			const { html, captured } = await resolveAndCapture(
				repoPath,
				"tracked.txt",
			);
			await assertGitApiConflictShape(
				repoPath,
				"tracked.txt",
				GitStatus.DELETED_BY_US,
				new Set([GIT_STAGE_BASE, GIT_STAGE_REMOTE]),
			);
			assert.equal(captured.length, 0);
			assert.equal(
				html,
				"<p>Delete/modify conflict. Use the prompt above to resolve.</p>",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("shows delete/modify message and skips 3-way init when remote deleted and local modified", async () => {
		const repoPath = await makeRepo("weld-deleted-by-them-");
		try {
			makeDeletedByThemConflict(repoPath);
			const { html, captured } = await resolveAndCapture(
				repoPath,
				"tracked.txt",
			);
			await assertGitApiConflictShape(
				repoPath,
				"tracked.txt",
				GitStatus.DELETED_BY_THEM,
				new Set([GIT_STAGE_BASE, GIT_STAGE_LOCAL]),
			);
			assert.equal(captured.length, 0);
			assert.equal(
				html,
				"<p>Delete/modify conflict. Use the prompt above to resolve.</p>",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("proceeds to 3-way merge init for both-added conflicts", async () => {
		const repoPath = await makeRepo("weld-both-added-");
		try {
			makeBothAddedConflict(repoPath);
			const { captured } = await resolveAndCapture(
				repoPath,
				"conflict.txt",
			);
			await assertGitApiConflictShape(
				repoPath,
				"conflict.txt",
				GitStatus.BOTH_ADDED,
				new Set([GIT_STAGE_LOCAL, GIT_STAGE_REMOTE]),
			);
			assert.equal(captured.length, 1);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("shows error and skips 3-way init for both-deleted conflict", async () => {
		const repoPath = await makeRepo("weld-both-deleted-stub-");
		try {
			await assertBothDeletedCustomEditorStatus(repoPath);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

describe("MeldCustomEditorProvider.resolveCustomTextEditor — status/stage mismatch", () => {
	it("ignores bogus BOTH_DELETED status when all conflict stages are readable", async () => {
		const repoPath = await makeRepo("weld-both-deleted-bogus-");
		try {
			await assertMisreportedBothDeletedCustomEditorStatus(repoPath);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

// Group B: handleOpenMeldDiff — conflict status handling via command.
describe("handleOpenMeldDiff — conflict status handling", () => {
	it("calls handleDeleteModifyConflict and does not open editor for DELETED_BY_US", () =>
		withConflictRepo(
			"weld-cmd-deleted-by-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				await assertGitApiConflictShape(
					repoPath,
					"tracked.txt",
					GitStatus.DELETED_BY_US,
					new Set([GIT_STAGE_BASE, GIT_STAGE_REMOTE]),
				);
				const { openWithCalls, warningCalls } =
					await executeOpenMeldDiffAndCapture(
						repoPath,
						"tracked.txt",
					);
				assert.equal(openWithCalls.length, 0);
				assert.equal(warningCalls.length, 1);
				assert.match(String(warningCalls[0]?.[0]), LOCAL_DELETED_REGEX);
				assert.match(
					String(warningCalls[0]?.[0]),
					REMOTE_MODIFIED_REGEX,
				);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"DU",
					"remote modification\n",
					new Set([1, 3]),
				);
			},
		));

	it("calls handleDeleteModifyConflict and does not open editor for DELETED_BY_THEM", () =>
		withConflictRepo(
			"weld-cmd-deleted-by-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				await assertGitApiConflictShape(
					repoPath,
					"tracked.txt",
					GitStatus.DELETED_BY_THEM,
					new Set([GIT_STAGE_BASE, GIT_STAGE_LOCAL]),
				);
				const { openWithCalls, warningCalls } =
					await executeOpenMeldDiffAndCapture(
						repoPath,
						"tracked.txt",
					);
				assert.equal(openWithCalls.length, 0);
				assert.equal(warningCalls.length, 1);
				assert.match(
					String(warningCalls[0]?.[0]),
					REMOTE_DELETED_REGEX,
				);
				assert.match(
					String(warningCalls[0]?.[0]),
					LOCAL_MODIFIED_REGEX,
				);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"UD",
					"local modification\n",
					new Set([1, 2]),
				);
			},
		));

	it("opens editor with vscode.openWith for a normal conflict", () =>
		withConflictRepo(
			"weld-cmd-normal-",
			makeConflict,
			async (repoPath, _repo) => {
				await assertGitApiConflictShape(
					repoPath,
					"tracked.txt",
					GitStatus.BOTH_MODIFIED,
					new Set([
						GIT_STAGE_BASE,
						GIT_STAGE_LOCAL,
						GIT_STAGE_REMOTE,
					]),
				);
				const { openWithCalls, warningCalls } =
					await executeOpenMeldDiffAndCapture(
						repoPath,
						"tracked.txt",
					);
				assert.equal(warningCalls.length, 0);
				assert.equal(openWithCalls.length, 1);
				assert.equal(
					(openWithCalls[0]?.[0] as Uri | undefined)?.fsPath,
					join(repoPath, "tracked.txt"),
				);
				assert.equal(openWithCalls[0]?.[1], MeldProviderClass.viewType);
			},
		));
});

describe("MeldCustomEditorProvider.handleDeleteModifyConflict — Compare", () => {
	it("Compare opens VS Code diff once and leaves DELETED_BY_THEM unresolved", () =>
		withConflictRepo(
			"weld-dlg-compare-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const diffCalls: Array<readonly unknown[]> = [];
				const warningStub = sinon
					.stub(window, "showWarningMessage")
					.resolves("Compare" as never);
				const executeStub = sinon
					.stub(commands, "executeCommand")
					.callsFake((command: string, ...args: unknown[]) => {
						if (command === "vscode.diff") {
							diffCalls.push(args);
						}
						return Promise.resolve(undefined);
					});
				try {
					await MeldProviderClass.handleDeleteModifyConflict(ctx, 2);
				} finally {
					executeStub.restore();
					warningStub.restore();
				}
				assert.equal(warningStub.callCount, 1);
				assert.equal(diffCalls.length, 1);
				assert.equal(
					(diffCalls[0]?.[0] as Uri | undefined)?.scheme,
					"git",
				);
				assert.equal(
					(diffCalls[0]?.[1] as Uri | undefined)?.scheme,
					"git",
				);
				assert.match(
					String(diffCalls[0]?.[2]),
					BASE_TO_LOCAL_TITLE_REGEX,
				);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"UD",
					"local modification\n",
					new Set([1, 2]),
				);
			},
		));
});

// Group C: MeldCustomEditorProvider.handleDeleteModifyConflict — dialog choices.
// window.showWarningMessage must be stubbed to return a choice without user interaction.
describe("MeldCustomEditorProvider.handleDeleteModifyConflict — dialog choices", () => {
	it("Keep File stages the file for DELETED_BY_US (stage 3 present)", () =>
		withConflictRepo(
			"weld-dlg-keep-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				await chooseDeleteModifyAction(repoPath, 3, "Keep File");
				assertNoUnmergedStages(repoPath, "tracked.txt");
				assert.equal(
					workingTreeContent(repoPath, "tracked.txt"),
					"remote modification\n",
				);
			},
		));

	it("Delete File removes and stages the deletion for DELETED_BY_US", () =>
		withConflictRepo(
			"weld-dlg-delete-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				await chooseDeleteModifyAction(repoPath, 3, "Delete File");
				assertNoUnmergedStages(repoPath, "tracked.txt");
				assert.equal(workingTreeContent(repoPath, "tracked.txt"), null);
			},
		));

	it("dismissing dialog makes no changes for DELETED_BY_US", () =>
		withConflictRepo(
			"weld-dlg-dismiss-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				await chooseDeleteModifyAction(repoPath, 3, undefined);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"DU",
					"remote modification\n",
					new Set([1, 3]),
				);
			},
		));

	it("Keep File stages the file for DELETED_BY_THEM (stage 2 present)", () =>
		withConflictRepo(
			"weld-dlg-keep-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				await chooseDeleteModifyAction(repoPath, 2, "Keep File");
				assertNoUnmergedStages(repoPath, "tracked.txt");
				assert.equal(
					workingTreeContent(repoPath, "tracked.txt"),
					"local modification\n",
				);
			},
		));

	it("Delete File removes and stages the deletion for DELETED_BY_THEM", () =>
		withConflictRepo(
			"weld-dlg-delete-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				await chooseDeleteModifyAction(repoPath, 2, "Delete File");
				assertNoUnmergedStages(repoPath, "tracked.txt");
				assert.equal(workingTreeContent(repoPath, "tracked.txt"), null);
			},
		));

	it("dismissing dialog makes no changes for DELETED_BY_THEM", () =>
		withConflictRepo(
			"weld-dlg-dismiss-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				await chooseDeleteModifyAction(repoPath, 2, undefined);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"UD",
					"local modification\n",
					new Set([1, 2]),
				);
			},
		));
});

// Group D: restoreConflictedFile — index stage detection and checkout logic.
describe("restoreConflictedFile — stage detection", () => {
	it("does not use delete/modify fallback for unrelated checkout failures", async () => {
		const repoPath = await makeRepo("weld-restore-missing-path-");
		try {
			await openRepoInGitExtension(repoPath);
			const ctx = getConflictedItem(repoPath, "missing.txt");
			await assert.rejects(
				() => restoreConflictedFileFn(ctx),
				CHECKOUT_FAILED_UNEXPECTEDLY_REGEX,
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});

	it("restores from stage 3 when only stage 3 present (DELETED_BY_US)", () =>
		withConflictRepo(
			"weld-restore-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const stagesBefore = lsFilesStages(repoPath, "tracked.txt");
				assert.ok(!stagesBefore.has(2) && stagesBefore.has(3));
				await restoreConflictedFileFn(ctx);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"DU",
					"remote modification\n",
					new Set([1, 3]),
				);
			},
		));

	it("restores from stage 2 when only stage 2 present (DELETED_BY_THEM)", () =>
		withConflictRepo(
			"weld-restore-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const stagesBefore = lsFilesStages(repoPath, "tracked.txt");
				assert.ok(stagesBefore.has(2) && !stagesBefore.has(3));
				await restoreConflictedFileFn(ctx);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"UD",
					"local modification\n",
					new Set([1, 2]),
				);
			},
		));

	it("writes conflict markers when stages 2 and 3 are both present (normal conflict)", () =>
		withConflictRepo(
			"weld-restore-normal-",
			makeConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				await restoreConflictedFileFn(ctx);
				const content = workingTreeContent(repoPath, "tracked.txt");
				assert.ok(
					content?.includes("<<<<<<<"),
					`Expected conflict markers, got: ${content}`,
				);
			},
		));
});

// Group D (continued): restore after the delete/modify dialog has already staged
// a resolution. The unmerged index entries are gone at that point, so
// restoreConflictedFile must not fall back to `git checkout -m` (which requires
// all three stages and fails for delete/modify conflicts).
describe("restoreConflictedFile — after dialog resolution", () => {
	// DELETED_BY_THEM: remote deleted, local modified (stage 2 present, stage 3 absent).
	it("restores DELETED_BY_THEM conflict after Keep File choice", () =>
		withConflictRepo(
			"weld-restore-keep-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const stub = sinon
					.stub(window, "showWarningMessage")
					.resolves("Keep File" as never);
				try {
					await MeldProviderClass.handleDeleteModifyConflict(ctx, 2);
				} finally {
					stub.restore();
				}
				await restoreConflictedFileFn(ctx);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"UD",
					"local modification\n",
					new Set([1, 2]),
				);
			},
		));

	it("restores DELETED_BY_THEM conflict after Delete File choice", () =>
		withConflictRepo(
			"weld-restore-delete-them-",
			makeDeletedByThemConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const stub = sinon
					.stub(window, "showWarningMessage")
					.resolves("Delete File" as never);
				try {
					await MeldProviderClass.handleDeleteModifyConflict(ctx, 2);
				} finally {
					stub.restore();
				}
				await restoreConflictedFileFn(ctx);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"UD",
					"local modification\n",
					new Set([1, 2]),
				);
			},
		));

	// DELETED_BY_US: local deleted, remote modified (stage 2 absent, stage 3 present).
	it("restores DELETED_BY_US conflict after Keep File choice", () =>
		withConflictRepo(
			"weld-restore-keep-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const stub = sinon
					.stub(window, "showWarningMessage")
					.resolves("Keep File" as never);
				try {
					await MeldProviderClass.handleDeleteModifyConflict(ctx, 3);
				} finally {
					stub.restore();
				}
				await restoreConflictedFileFn(ctx);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"DU",
					"remote modification\n",
					new Set([1, 3]),
				);
			},
		));

	it("restores DELETED_BY_US conflict after Delete File choice", () =>
		withConflictRepo(
			"weld-restore-delete-us-",
			makeDeletedByUsConflict,
			async (repoPath, _repo) => {
				const ctx = getConflictedItem(repoPath, "tracked.txt");
				const stub = sinon
					.stub(window, "showWarningMessage")
					.resolves("Delete File" as never);
				try {
					await MeldProviderClass.handleDeleteModifyConflict(ctx, 3);
				} finally {
					stub.restore();
				}
				await restoreConflictedFileFn(ctx);
				assertDeleteModifyConflictRestored(
					repoPath,
					"tracked.txt",
					"DU",
					"remote modification\n",
					new Set([1, 3]),
				);
			},
		));
});
