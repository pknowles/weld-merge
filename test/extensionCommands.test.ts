import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from "@jest/globals";
import { EventEmitter, TreeItemCollapsibleState, Uri } from "vscode";
import type {
	ApplyAutomergeAll,
	ApplyAutomergeSingle,
} from "../src/agentTools.ts";
import type { WeldExtensionApi } from "../src/extension.ts";
import { activate } from "../src/extension.ts";
import type { ConflictState } from "../src/gitUtils.ts";
import type {
	ConflictedItem,
	GitApiChange,
	GitApiRepository,
} from "../src/repoContext.ts";
import { GitStatus } from "../src/repoContext.ts";
import { GitFile } from "../src/treeView.ts";
import {
	mockVscodeFireDidSaveTextDocument,
	mockVscodeGetCommand,
	mockVscodeLogChannel,
	mockVscodeProgressReports,
	mockVscodeReset,
	mockVscodeSetActiveTextEditor,
	mockVscodeSetApplyEdit,
	mockVscodeSetConfiguration,
	mockVscodeSetExecuteCommand,
	mockVscodeSetInformationMessageResult,
	mockVscodeSetOpenTextDocument,
	mockVscodeSetWarningMessageResult,
	type WorkspaceEdit,
	window,
} from "./mockVscode.ts";

const mockGetGitApi = jest.fn<() => FakeGitApi>();
const mockCreateConflictedItem =
	jest.fn<
		(repository: GitApiRepository, change: GitApiChange) => ConflictedItem
	>();
const mockCreateConflictedItemFromUri =
	jest.fn<(repository: GitApiRepository, uri: Uri) => ConflictedItem>();
const mockConflictedItemFromUri =
	jest.fn<(uri: Uri) => Promise<ConflictedItem | null>>();
const mockNotifyRepositoryStateChanged =
	jest.fn<(repository: GitApiRepository) => void>();
const mockRegisterRepository =
	jest.fn<(api: FakeGitApi, repository: GitApiRepository) => void>();
const mockUnregisterRepository = jest.fn<(rootUri: Uri) => void>();
const mockExecGit = jest.fn<(args: string[], cwd: string) => Promise<string>>();
const mockExecGitWithInput =
	jest.fn<(args: string[], cwd: string, input: string) => Promise<string>>();
const mockGetUnresolvedReasons = jest.fn<(text: string) => string[]>();
const mockReadConflictState =
	jest.fn<
		(repository: GitApiRepository) => Promise<ConflictState | undefined>
	>();
const mockDescribeConflictStatusEvidence =
	jest.fn<(conflictedItem: ConflictedItem) => Promise<string>>();
const mockRequestRefreshFire = jest.fn<(uri: Uri) => void>();
const mockConflictStateChangedFire =
	jest.fn<(event: { repoUri: Uri; stateKey: string | undefined }) => void>();
const mockGetCurrentConflictStateKey =
	jest.fn<(repository: GitApiRepository) => Promise<string | undefined>>();
const mockRegisterMeldProvider =
	jest.fn<(context: unknown) => { dispose(): void }>();
const mockHandleDeleteModifyConflict =
	jest.fn<
		(
			conflictedItem: ConflictedItem,
			remainingStage: number,
		) => Promise<void>
	>();
const mockRegisterSubmoduleProvider =
	jest.fn<
		(
			context: unknown,
			conflictedFilesProvider: unknown,
		) => { dispose(): void }
	>();
const mockOpenSubmoduleProvider =
	jest.fn<(repository: GitApiRepository, uri: Uri) => Promise<void>>();
const mockRestoreSubmodule =
	jest.fn<(repository: GitApiRepository, uri: Uri) => Promise<void>>();
const mockBuildInitialConflictedState =
	jest.fn<
		(rootUri: Uri, stages: unknown, labels: unknown) => Promise<string>
	>();
const mockFetchConflictStages =
	jest.fn<(conflictedItem: ConflictedItem) => Promise<unknown>>();
const mockRegisterAgentTools =
	jest.fn<
		(
			context: unknown,
			applyAutomergeAll: ApplyAutomergeAll,
			applyAutomergeSingle: ApplyAutomergeSingle,
		) => void
	>();

jest.mock("../src/agentTools.ts", () => ({
	registerAgentTools: (
		context: unknown,
		applyAutomergeAll: ApplyAutomergeAll,
		applyAutomergeSingle: ApplyAutomergeSingle,
	) =>
		mockRegisterAgentTools(
			context,
			applyAutomergeAll,
			applyAutomergeSingle,
		),
}));

jest.mock("../src/repoContext.ts", () => ({
	...Object.fromEntries([
		["GIT_STAGE_LOCAL", 2],
		["GIT_STAGE_REMOTE", 3],
		[
			"GitStatus",
			Object.fromEntries([
				["BOTH_MODIFIED", 18],
				["DELETED_BY_US", 14],
				["DELETED_BY_THEM", 15],
				["BOTH_DELETED", 17],
			]),
		],
	]),
	getGitApi: () => mockGetGitApi(),
	isSupportedScheme: (uri: Uri) =>
		uri.scheme === "file" || uri.scheme === "vscode-remote",
	createConflictedItem: (
		repository: GitApiRepository,
		change: GitApiChange,
	) => mockCreateConflictedItem(repository, change),
	createConflictedItemFromUri: (repository: GitApiRepository, uri: Uri) =>
		mockCreateConflictedItemFromUri(repository, uri),
	conflictedItemFromUri: (uri: Uri) => mockConflictedItemFromUri(uri),
	notifyRepositoryStateChanged: (repository: GitApiRepository) =>
		mockNotifyRepositoryStateChanged(repository),
	registerRepository: (api: FakeGitApi, repository: GitApiRepository) =>
		mockRegisterRepository(api, repository),
	unregisterRepository: (rootUri: Uri) => mockUnregisterRepository(rootUri),
}));

jest.mock("../src/gitUtils.ts", () => {
	const actual =
		jest.requireActual<typeof import("../src/gitUtils.ts")>(
			"../src/gitUtils.ts",
		);
	return {
		...actual,
		describeConflictStatusEvidence: (conflictedItem: ConflictedItem) =>
			mockDescribeConflictStatusEvidence(conflictedItem),
		execGit: (args: string[], cwd: string) => mockExecGit(args, cwd),
		execGitWithInput: (args: string[], cwd: string, input: string) =>
			mockExecGitWithInput(args, cwd, input),
		getUnresolvedReasons: (text: string) => mockGetUnresolvedReasons(text),
		readConflictState: (repository: GitApiRepository) =>
			mockReadConflictState(repository),
	};
});

jest.mock("../src/conflictSnapshot.ts", () => ({
	fetchConflictStages: (conflictedItem: ConflictedItem) =>
		mockFetchConflictStages(conflictedItem),
}));

jest.mock("../src/webview/meldWebviewPanel.ts", () =>
	Object.fromEntries([
		[
			"MeldCustomEditorProvider",
			{
				viewType: "weld.meld",
				register: (context: unknown) =>
					mockRegisterMeldProvider(context),
				onRequestRefresh: {
					fire: (uri: Uri) => mockRequestRefreshFire(uri),
				},
				onConflictStateChanged: {
					fire: (event: {
						repoUri: Uri;
						stateKey: string | undefined;
					}) => mockConflictStateChangedFire(event),
				},
				getCurrentConflictStateKey: (repository: GitApiRepository) =>
					mockGetCurrentConflictStateKey(repository),
				handleDeleteModifyConflict: (
					conflictedItem: ConflictedItem,
					remainingStage: number,
				) =>
					mockHandleDeleteModifyConflict(
						conflictedItem,
						remainingStage,
					),
				setInitialConflictContent: jest.fn(),
			},
		],
	]),
);

jest.mock("../src/webview/submoduleConflictEditor.ts", () =>
	Object.fromEntries([
		[
			"SubmoduleConflictEditorProvider",
			{
				register: (
					context: unknown,
					conflictedFilesProvider: unknown,
				) =>
					mockRegisterSubmoduleProvider(
						context,
						conflictedFilesProvider,
					),
				open: (repository: GitApiRepository, uri: Uri) =>
					mockOpenSubmoduleProvider(repository, uri),
			},
		],
	]),
);

jest.mock("../src/submoduleConflict.ts", () =>
	Object.fromEntries([
		[
			"SubmoduleConflict",
			{
				restore: (repository: GitApiRepository, uri: Uri) =>
					mockRestoreSubmodule(repository, uri),
			},
		],
	]),
);

jest.mock("../src/webview/diffPayload.ts", () => ({
	buildInitialConflictedState: (
		rootUri: Uri,
		stages: unknown,
		labels: unknown,
	) => mockBuildInitialConflictedState(rootUri, stages, labels),
}));

interface FakeGitApi {
	git: { path: string };
	state: "initialized";
	repositories: GitApiRepository[];
	onDidChangeState: (listener: (state: "initialized") => void) => {
		dispose(): void;
	};
	onDidOpenRepository: (listener: (repo: GitApiRepository) => void) => {
		dispose(): void;
	};
	onDidCloseRepository: (listener: (repo: GitApiRepository) => void) => {
		dispose(): void;
	};
	getRepository(uri: Uri): GitApiRepository | null;
	getRepositoryRoot(uri: Uri): Promise<Uri | null>;
	openRepository(uri: Uri): Promise<GitApiRepository | null>;
	toGitUri(uri: Uri, ref: string): Uri;
	openEmitter: EventEmitter<GitApiRepository>;
	closeEmitter: EventEmitter<GitApiRepository>;
}

interface FakeRepo extends GitApiRepository {
	changeEmitter: EventEmitter<void>;
	showMock: jest.MockedFunction<
		(ref: string, path: string) => Promise<string>
	>;
	addMock: jest.MockedFunction<(paths: string[]) => Promise<void>>;
}

class TestGitFile extends GitFile {
	constructor(contextValue: string, conflictedItem: ConflictedItem) {
		super({
			label: conflictedItem.uri.fsPath,
			collapsibleState: TreeItemCollapsibleState.None,
			conflictedItem,
			commandId: "meld-auto-merge.openMeldDiff",
		});
		this.contextValue = contextValue;
	}
}

function disposable(): { dispose(): void } {
	return { dispose: () => undefined };
}

function makeChange(uri: Uri): GitApiChange {
	return { uri, status: GitStatus.BOTH_MODIFIED };
}

function makeRepo(rootPath: string, mergePaths: string[] = []): FakeRepo {
	const rootUri = Uri.file(rootPath);
	const changeEmitter = new EventEmitter<void>();
	const showMock = jest.fn<(ref: string, path: string) => Promise<string>>();
	const addMock = jest.fn<(paths: string[]) => Promise<void>>();
	const repo: FakeRepo = {
		rootUri,
		state: {
			mergeChanges: mergePaths.map((path) =>
				makeChange(Uri.joinPath(rootUri, path)),
			),
			onDidChange: changeEmitter.event,
		},
		status: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		show: showMock,
		showMock,
		getCommit: jest.fn<() => never>(),
		getMergeBase: jest
			.fn<(ref1: string, ref2: string) => Promise<string>>()
			.mockResolvedValue("merge-base"),
		add: addMock,
		addMock,
		changeEmitter,
	};
	showMock.mockImplementation((ref) => {
		if (ref === ":1") {
			return Promise.resolve("base\n");
		}
		if (ref === ":2") {
			return Promise.resolve("local\n");
		}
		if (ref === ":3") {
			return Promise.resolve("remote\n");
		}
		return Promise.reject(new Error(`unexpected ref ${ref}`));
	});
	addMock.mockResolvedValue(undefined);
	return repo;
}

function makeConflictedItem(
	repository: GitApiRepository,
	uri: Uri,
	status: ConflictedItem["conflictStatus"] = () =>
		Promise.resolve({ kind: "bothModified" }),
): ConflictedItem {
	return {
		repository,
		rootUri: repository.rootUri,
		uri,
		mergeChange: makeChange(uri),
		conflictStatus: status,
	};
}

function makeGitApi(repositories: GitApiRepository[] = []): FakeGitApi {
	const openEmitter = new EventEmitter<GitApiRepository>();
	const closeEmitter = new EventEmitter<GitApiRepository>();
	return {
		git: { path: "git" },
		state: "initialized",
		repositories,
		onDidChangeState: () => disposable(),
		onDidOpenRepository: openEmitter.event,
		onDidCloseRepository: closeEmitter.event,
		getRepository: (uri: Uri) =>
			repositories.find((repo) =>
				uri.fsPath.startsWith(repo.rootUri.fsPath),
			) ?? null,
		getRepositoryRoot: (uri: Uri) =>
			Promise.resolve(
				repositories.find((repo) =>
					uri.fsPath.startsWith(repo.rootUri.fsPath),
				)?.rootUri ?? null,
			),
		openRepository: () => Promise.resolve(null),
		toGitUri: (uri: Uri) => uri,
		openEmitter,
		closeEmitter,
	};
}

function installGitApi(api: FakeGitApi): void {
	mockGetGitApi.mockReturnValue(api);
}

function activateWeld(config: ReadonlyMap<string, unknown> = new Map()) {
	mockVscodeSetConfiguration(new Map(config));
	const context = { subscriptions: [] as Array<{ dispose(): void }> };
	const api = activate(
		context as unknown as Parameters<typeof activate>[0],
	) as WeldExtensionApi;
	return { api, context };
}

function registered(command: string): (...args: unknown[]) => Promise<unknown> {
	return async (...args: unknown[]) =>
		await Promise.resolve(mockVscodeGetCommand(command)(...args));
}

function documentFor(uri: unknown, text: string, isUntitled = false) {
	return {
		uri,
		isUntitled,
		getText: () => text,
		positionAt: (offset: number) => ({ offset }),
		save: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
	};
}

async function flushTimers(): Promise<void> {
	await jest.runOnlyPendingTimersAsync();
}

beforeEach(() => {
	jest.useRealTimers();
	mockVscodeReset();
	jest.clearAllMocks();
	jest.spyOn(window, "showInformationMessage");
	jest.spyOn(window, "showWarningMessage");
	jest.spyOn(window, "showErrorMessage");
	jest.spyOn(window, "showTextDocument");
	mockRegisterMeldProvider.mockReturnValue(disposable());
	mockRegisterSubmoduleProvider.mockReturnValue(disposable());
	mockGetCurrentConflictStateKey.mockResolvedValue(undefined);
	mockGetUnresolvedReasons.mockReturnValue([]);
	mockReadConflictState.mockResolvedValue({
		operation: "merge",
		otherRef: "MERGE_HEAD",
	});
	mockCreateConflictedItem.mockImplementation(
		(repository: GitApiRepository, change: GitApiChange) =>
			makeConflictedItem(repository, change.uri),
	);
	mockCreateConflictedItemFromUri.mockImplementation(
		(repository: GitApiRepository, uri: Uri) =>
			makeConflictedItem(repository, uri),
	);
	mockConflictedItemFromUri.mockResolvedValue(null);
	mockExecGit.mockResolvedValue("");
	mockExecGitWithInput.mockResolvedValue("");
	mockDescribeConflictStatusEvidence.mockResolvedValue("status evidence");
	mockFetchConflictStages.mockResolvedValue({
		base: "base\n",
		local: "local\n",
		remote: "remote\n",
	});
	mockBuildInitialConflictedState.mockResolvedValue("reconstructed\n");
});

afterEach(() => {
	jest.useRealTimers();
	mockVscodeReset();
});

describe("extension command activation and watchers", () => {
	it("records tree materialization and manages repository watchers", async () => {
		const supportedRepo = makeRepo("/work/supported", ["a.txt"]);
		const duplicateRepo = supportedRepo;
		const unsupportedRepo = makeRepo("/work/virtual", ["ignored.txt"]);
		Object.defineProperty(unsupportedRepo.rootUri, "scheme", {
			value: "git",
		});
		const api = makeGitApi([supportedRepo]);
		installGitApi(api);

		const { api: weldApi, context } = activateWeld(
			new Map([["weld.launchTelemetry", true]]),
		);
		await weldApi.conflictedFilesProvider.getChildren();
		api.openEmitter.fire(unsupportedRepo);
		api.openEmitter.fire(duplicateRepo);
		api.closeEmitter.fire(supportedRepo);
		mockVscodeFireDidSaveTextDocument({});
		for (const subscription of context.subscriptions) {
			subscription.dispose();
		}

		expect(weldApi.getTelemetrySnapshot().treeGetChildrenCalls).toBe(1);
		expect(mockRegisterRepository).toHaveBeenCalledTimes(1);
		expect(mockRegisterRepository).toHaveBeenCalledWith(api, supportedRepo);
		expect(mockUnregisterRepository).toHaveBeenCalledWith(
			supportedRepo.rootUri,
		);
		expect(mockRegisterRepository).not.toHaveBeenCalledWith(
			api,
			unsupportedRepo,
		);
	});

	it("focuses the conflict tree when the new-conflict notification action is selected", async () => {
		jest.useFakeTimers();
		const repo = makeRepo("/work/repo");
		const api = makeGitApi([repo]);
		installGitApi(api);
		mockVscodeSetInformationMessageResult("View Conflict List");
		const executeCommand = jest.fn<(...args: unknown[]) => Promise<void>>();
		executeCommand.mockResolvedValue(undefined);
		mockVscodeSetExecuteCommand(executeCommand);

		activateWeld();
		repo.changeEmitter.fire();
		await flushTimers();
		repo.state.mergeChanges = [makeChange(Uri.file("/work/repo/a.txt"))];
		repo.changeEmitter.fire();
		await flushTimers();

		expect(executeCommand).toHaveBeenCalledWith(
			"weldConflictedFiles.focus",
		);
	});
});

describe("extension open command routing", () => {
	it("routes open commands by target type and conflict kind", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		activateWeld();
		const executeCommand = jest.fn<(...args: unknown[]) => Promise<void>>();
		executeCommand.mockResolvedValue(undefined);
		mockVscodeSetExecuteCommand(executeCommand);
		const normalItem = makeConflictedItem(
			repo,
			Uri.file("/work/repo/a.txt"),
		);
		const deleteModifyItem = makeConflictedItem(
			repo,
			Uri.file("/work/repo/delete.txt"),
			() => Promise.resolve({ kind: "deleteModify", remainingStage: 2 }),
		);
		const bothDeletedItem = makeConflictedItem(
			repo,
			Uri.file("/work/repo/both-deleted.txt"),
			() => Promise.resolve({ kind: "bothDeleted" }),
		);
		const submoduleFile = new TestGitFile(
			"conflictedSubmodule",
			makeConflictedItem(repo, Uri.file("/work/repo/sub")),
		);
		mockConflictedItemFromUri.mockImplementation((uri: Uri) => {
			if (uri.fsPath.endsWith("delete.txt")) {
				return Promise.resolve(deleteModifyItem);
			}
			if (uri.fsPath.endsWith("both-deleted.txt")) {
				return Promise.resolve(bothDeletedItem);
			}
			return Promise.resolve(normalItem);
		});

		await registered("meld-auto-merge.openMergeEditor")({
			uri: Uri.file("/work/repo/a.txt"),
		});
		await registered("meld-auto-merge.openMeldDiff")(submoduleFile);
		await registered("meld-auto-merge.openMeldDiff")({
			uri: Uri.file("/work/repo/delete.txt"),
		});
		await registered("meld-auto-merge.openMeldDiff")({
			uri: Uri.file("/work/repo/both-deleted.txt"),
		});
		await registered("meld-auto-merge.openConflictedFile")(
			new TestGitFile("resolvedFile", normalItem),
		);
		await registered("meld-auto-merge.openConflictedFile")(
			new TestGitFile(
				"resolvedFile",
				makeConflictedItem(
					repo,
					Uri.from({ scheme: "git", path: "/x" }),
				),
			),
		);

		expect(executeCommand).toHaveBeenCalledWith(
			"git.openMergeEditor",
			normalItem.uri,
		);
		expect(mockOpenSubmoduleProvider).toHaveBeenCalledWith(
			repo,
			Uri.file("/work/repo/sub"),
		);
		expect(mockHandleDeleteModifyConflict).toHaveBeenCalledWith(
			deleteModifyItem,
			2,
		);
		expect(mockDescribeConflictStatusEvidence).toHaveBeenCalledWith(
			bothDeletedItem,
		);
		expect(mockVscodeLogChannel().errors).toContain("status evidence");
		expect(window.showTextDocument).toHaveBeenCalledWith(normalItem.uri);
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			'Cannot open conflicted file: unsupported URI scheme "git".',
		);
	});
});

describe("extension active-editor command guards", () => {
	it("fails active-editor commands closed for absent, untitled, unsupported, and resolver-error targets", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		activateWeld();
		const executeCommand = jest.fn<(...args: unknown[]) => Promise<void>>();
		executeCommand.mockResolvedValue(undefined);
		mockVscodeSetExecuteCommand(executeCommand);

		await registered("meld-auto-merge.openMeldDiff")();
		mockVscodeSetActiveTextEditor({
			document: documentFor(
				Uri.file("/work/repo/untitled.txt"),
				"",
				true,
			),
		});
		await registered("meld-auto-merge.smartAdd")();
		mockVscodeSetActiveTextEditor({
			document: documentFor(Uri.from({ scheme: "git", path: "/x" }), ""),
		});
		await registered("meld-auto-merge.openMergeEditor")();
		mockVscodeSetActiveTextEditor({
			document: documentFor(Uri.file("/work/repo/a.txt"), ""),
		});
		mockConflictedItemFromUri.mockResolvedValue(null);
		await registered("meld-auto-merge.rerereForget")();
		mockConflictedItemFromUri.mockRejectedValue(new Error("resolver boom"));
		await registered("meld-auto-merge.checkoutConflicted")();

		expect(executeCommand).not.toHaveBeenCalled();
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			'Cannot run open merge editor: unsupported URI scheme "git".',
		);
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Cannot run rerere forget: file is not in a git repository.",
		);
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Cannot run checkout conflicted file: resolver boom",
		);
	});
});

describe("extension auto-merge commands", () => {
	it("auto-merges one file by reading all stages, applying a full document edit, and refreshing", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		const { api } = activateWeld();
		const refresh = jest.spyOn(api.conflictedFilesProvider, "refresh");
		const target = new TestGitFile(
			"conflictedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		// Real marker text, not arbitrary content: performAutoMerge now
		// refuses to overwrite a live document unless it is either the raw
		// pre-merge conflict text (this) or already the auto-merge result,
		// so extractConflictLabels must find real labels and
		// buildInitialConflictedState (mocked) must echo this exact text
		// back for the safety check to pass.
		const conflictText =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		const document = documentFor(target.uri, conflictText);
		mockVscodeSetOpenTextDocument(() => Promise.resolve(document));
		const edits: WorkspaceEdit[] = [];
		mockVscodeSetApplyEdit((edit) => {
			edits.push(edit);
			return Promise.resolve(true);
		});

		await registered("meld-auto-merge.autoMerge")(target);

		// Goes through fetchConflictStages rather than reading each stage
		// directly: a both-added conflict has no stage 1, and fetching it
		// unconditionally throws for that case (see the "no base stage"
		// regression test in initial_conflict_uri.test.ts).
		expect(mockFetchConflictStages).toHaveBeenCalledWith(
			target.conflictedItem,
		);
		expect(edits[0]?.replacements[0]).toMatchObject({
			uri: target.uri,
		});
		expect(edits[0]?.replacements[0]?.text).toContain("local");
		expect(refresh).toHaveBeenCalled();
		// base/local/remote differ on the same line with no shared content,
		// so the merge leaves it unresolved — never stage a file that still
		// has conflict markers in it.
		expect(repo.addMock).not.toHaveBeenCalled();
	});
});

describe("extension auto-merge staging", () => {
	it("stages the file once auto-merge fully resolves it", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		activateWeld();
		const target = new TestGitFile(
			"conflictedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		// Non-overlapping edits on different lines: base/local/remote here
		// let the 3-way merge fully resolve on its own, unlike the
		// same-line-conflict fixture used elsewhere in this file.
		mockFetchConflictStages.mockResolvedValue({
			base: "one\ntwo\nthree\n",
			local: "one changed\ntwo\nthree\n",
			remote: "one\ntwo\nthree changed\n",
		});
		const conflictText =
			"<<<<<<< HEAD\none changed\n=======\none\n>>>>>>> other\ntwo\n" +
			"<<<<<<< HEAD\nthree\n=======\nthree changed\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		mockVscodeSetOpenTextDocument(() =>
			Promise.resolve(documentFor(target.uri, conflictText)),
		);
		mockVscodeSetApplyEdit(() => Promise.resolve(true));

		await registered("meld-auto-merge.autoMerge")(target);

		expect(repo.addMock).toHaveBeenCalledWith([target.uri.fsPath]);
	});

	it("rejects when auto-merge cannot apply the edit and refuses submodule rows", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		activateWeld();
		const textTarget = new TestGitFile(
			"conflictedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		const submoduleTarget = new TestGitFile(
			"conflictedSubmodule",
			makeConflictedItem(repo, Uri.file("/work/repo/sub")),
		);
		// Real marker text so performAutoMerge's live-content safety check
		// passes and the failure under test — applyEdit rejecting — is what
		// actually triggers, not an unrelated WouldClobberEditError.
		const conflictText =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		mockVscodeSetOpenTextDocument(() =>
			Promise.resolve(documentFor(textTarget.uri, conflictText)),
		);
		mockVscodeSetApplyEdit(() => Promise.resolve(false));

		await expect(
			registered("meld-auto-merge.autoMerge")(textTarget),
		).rejects.toThrow("Failed to apply merged text");
		await registered("meld-auto-merge.autoMerge")(submoduleTarget);

		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Submodule conflicts cannot be auto-merged as text. Open the submodule resolver from the tree instead.",
		);
	});
});

describe("extension auto-merge-all command", () => {
	it("handles auto-merge-all empty and success flows", async () => {
		const emptyRepo = makeRepo("/work/empty");
		installGitApi(makeGitApi([emptyRepo]));
		const { api } = activateWeld();
		const refresh = jest.spyOn(api.conflictedFilesProvider, "refresh");
		await registered("meld-auto-merge.autoMergeAll")();
		expect(window.showInformationMessage).toHaveBeenCalledWith(
			"No unmerged files to auto-merge.",
		);

		const firstRepo = makeRepo("/work/one", ["a.txt"]);
		const secondRepo = makeRepo("/work/two", ["b.txt"]);
		installGitApi(makeGitApi([firstRepo, secondRepo]));
		// Real marker text so performAutoMerge's live-content safety check
		// passes for both files.
		const conflictText =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		mockVscodeSetOpenTextDocument((uri) =>
			Promise.resolve(documentFor(uri, conflictText)),
		);
		mockVscodeSetApplyEdit(() => Promise.resolve(true));
		await registered("meld-auto-merge.autoMergeAll")();
		expect(mockVscodeProgressReports()).toEqual([
			{ message: "Merging file:///work/one/a.txt..." },
			{ message: "Merging file:///work/two/b.txt..." },
		]);
		// base/local/remote all differ on the fixture's single line with no
		// shared content to reconcile, so both merges attempt but leave
		// <<<<<<< markers rather than fully resolving.
		expect(mockVscodeLogChannel().infos).toEqual([
			"Weld Auto-Merge All: merged 2 of 2 file(s), 0 fully resolved.",
		]);
		expect(window.showInformationMessage).toHaveBeenCalledWith(
			"Weld Auto-Merge All: Merged 2 of 2 file(s); 0 fully resolved, 2 still have unresolved conflicts left as <<<<<<< markers.",
		);
		expect(refresh).toHaveBeenCalled();
	});

	it("stops auto-merge-all on the first failure, reporting the successful count", async () => {
		const firstRepo = makeRepo("/work/one", ["a.txt"]);
		const secondRepo = makeRepo("/work/two", ["b.txt"]);
		installGitApi(makeGitApi([firstRepo, secondRepo]));
		activateWeld();
		const conflictText =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		mockVscodeSetOpenTextDocument((uri) =>
			Promise.resolve(documentFor(uri, conflictText)),
		);
		mockVscodeSetApplyEdit((edit) =>
			Promise.resolve(
				edit.replacements[0]?.uri.fsPath.endsWith("a.txt") === true,
			),
		);
		await expect(
			registered("meld-auto-merge.autoMergeAll")(),
		).rejects.toThrow(
			"Weld Auto-Merge All stopped at file:///work/two/b.txt after 1 successful merge(s)",
		);
		expect(mockVscodeLogChannel().infos).toEqual([
			"Weld Auto-Merge All: merged 1 of 2 file(s), 0 fully resolved.",
		]);
	});
});

describe("extension agent tool registration", () => {
	it("registers a weld_apply_automerge_all callback that reports each file's outcome", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		activateWeld();
		const conflictText =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		mockVscodeSetOpenTextDocument((uri) =>
			Promise.resolve(documentFor(uri, conflictText)),
		);
		mockVscodeSetApplyEdit(() => Promise.resolve(true));

		expect(mockRegisterAgentTools).toHaveBeenCalledTimes(1);
		const applyAutomergeAll = mockRegisterAgentTools.mock.calls[0]?.[1];
		expect(applyAutomergeAll).toBeDefined();

		// base/local/remote each change the same single line differently
		// (same fixture as the single-file test below), so the file is
		// merged but not fully resolved.
		const result = await applyAutomergeAll?.({});
		expect(result).toEqual({
			totalCount: 1,
			files: [
				{
					repositoryRoot: repo.rootUri.toString(),
					path: "a.txt",
					outcome: "merged",
					remainingConflicts: 1,
				},
			],
		});
	});

	it("registers a weld_apply_automerge callback that merges one located file and reports remaining conflicts", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		const { api } = activateWeld();
		const refresh = jest.spyOn(api.conflictedFilesProvider, "refresh");
		const conflictText =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\n";
		mockBuildInitialConflictedState.mockResolvedValue(conflictText);
		const document = documentFor(
			Uri.file("/work/repo/a.txt"),
			conflictText,
		);
		mockVscodeSetOpenTextDocument(() => Promise.resolve(document));
		mockVscodeSetApplyEdit(() => Promise.resolve(true));

		expect(mockRegisterAgentTools).toHaveBeenCalledTimes(1);
		const applyAutomergeSingle = mockRegisterAgentTools.mock.calls[0]?.[2];
		expect(applyAutomergeSingle).toBeDefined();

		const result = await applyAutomergeSingle?.({
			repositoryRoot: repo.rootUri.toString(),
			path: "a.txt",
		});

		// base/local/remote each change the same single line differently, so
		// Weld cannot auto-resolve the one conflicting hunk.
		expect(result).toEqual({ kind: "merged", remainingConflicts: 1 });
		expect(refresh).toHaveBeenCalled();
	});
});

describe("extension checkout and rerere commands", () => {
	it("honors checkout confirmation and routes text/submodule success and failure", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		const { api } = activateWeld();
		const refresh = jest.spyOn(api.conflictedFilesProvider, "refresh");
		const textTarget = new TestGitFile(
			"conflictedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		const submoduleTarget = new TestGitFile(
			"resolvedSubmodule",
			makeConflictedItem(repo, Uri.file("/work/repo/sub")),
		);
		mockVscodeSetWarningMessageResult(undefined);
		await registered("meld-auto-merge.checkoutConflicted")(textTarget);
		expect(mockExecGit).not.toHaveBeenCalled();

		mockVscodeSetWarningMessageResult("Yes");
		mockExecGit.mockResolvedValueOnce("");
		await registered("meld-auto-merge.checkoutConflicted")(textTarget);
		expect(mockExecGit).toHaveBeenCalledWith(
			["checkout", "-m", "--", textTarget.uri.fsPath],
			repo.rootUri.fsPath,
		);
		expect(mockRequestRefreshFire).toHaveBeenCalledWith(textTarget.uri);
		expect(refresh).toHaveBeenCalled();

		mockRestoreSubmodule.mockResolvedValueOnce(undefined);
		await registered("meld-auto-merge.checkoutConflicted")(submoduleTarget);
		expect(mockRestoreSubmodule).toHaveBeenCalledWith(
			repo,
			submoduleTarget.uri,
		);
		expect(mockNotifyRepositoryStateChanged).toHaveBeenCalledWith(repo);

		mockRestoreSubmodule.mockRejectedValueOnce(
			new Error("submodule failed"),
		);
		await registered("meld-auto-merge.checkoutConflicted")(submoduleTarget);
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Submodule restore failed: submodule failed",
		);
	});

	it("runs rerere forget with confirmation, exact git args, refresh, and error reporting", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		const { api } = activateWeld();
		const refresh = jest.spyOn(api.conflictedFilesProvider, "refresh");
		const target = new TestGitFile(
			"conflictedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		mockVscodeSetWarningMessageResult(undefined);
		await registered("meld-auto-merge.rerereForget")(target);
		expect(mockExecGit).not.toHaveBeenCalled();

		mockVscodeSetWarningMessageResult("Yes");
		await registered("meld-auto-merge.rerereForget")(target);
		expect(mockExecGit).toHaveBeenCalledWith(
			["rerere", "forget", "--", target.uri.fsPath],
			repo.rootUri.fsPath,
		);
		expect(refresh).toHaveBeenCalled();

		mockExecGit.mockRejectedValueOnce(new Error("rerere failed"));
		await registered("meld-auto-merge.rerereForget")(target);
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Rerere forget failed: rerere failed",
		);
	});
});

describe("extension smart-add command", () => {
	it("rejects unresolved content, adds clean files, and reports stderr from git failures", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		const { api } = activateWeld();
		const refresh = jest.spyOn(api.conflictedFilesProvider, "refresh");
		const target = new TestGitFile(
			"resolvedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		mockVscodeSetOpenTextDocument(() =>
			Promise.resolve(documentFor(target.uri, "clean\n")),
		);
		mockGetUnresolvedReasons.mockReturnValueOnce([
			"merge conflict markers",
		]);
		expect(await registered("meld-auto-merge.smartAdd")(target)).toBe(
			false,
		);
		expect(repo.addMock).not.toHaveBeenCalled();
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Cannot add file: file contains merge conflict markers.",
		);

		mockGetUnresolvedReasons.mockReturnValue([]);
		expect(await registered("meld-auto-merge.smartAdd")(target)).toBe(true);
		expect(repo.addMock).toHaveBeenCalledWith([target.uri.fsPath]);
		expect(refresh).toHaveBeenCalled();

		const gitError = new Error("add failed", {
			cause: new Error("inner cause"),
		}) as Error & { stderr: string };
		gitError.stderr = "fatal: unresolved";
		repo.addMock.mockRejectedValueOnce(gitError);
		expect(await registered("meld-auto-merge.smartAdd")(target)).toBe(
			false,
		);
		expect(window.showErrorMessage).toHaveBeenCalledWith(
			"Git Add Failed: add failed -> caused by: inner cause \nfatal: unresolved",
		);
	});
});

describe("extension restore safety rails and remote smoke helper", () => {
	it("reports restoreConflictedFile safety failures with specific diagnostics", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		const { api } = activateWeld();
		const item = makeConflictedItem(repo, Uri.file("/outside.txt"));

		mockExecGit.mockImplementation((args) => {
			if (args[0] === "checkout") {
				return Promise.reject(
					new Error(
						"path 'outside.txt' does not have all necessary versions",
					),
				);
			}
			if (args[0] === "diff") {
				return Promise.resolve("D\toutside.txt\n");
			}
			return Promise.reject(
				new Error(`unexpected git call: ${args.join(" ")}`),
			);
		});
		mockReadConflictState.mockResolvedValueOnce({
			operation: "merge",
			otherRef: "MERGE_HEAD",
		});
		await expect(api.restoreConflictedFile(item)).rejects.toThrow(
			"invalid repository path",
		);
		expect(mockExecGit).toHaveBeenCalledTimes(2);
		expect(mockExecGit).toHaveBeenNthCalledWith(
			1,
			["checkout", "-m", "--", "/outside.txt"],
			"/work/repo",
		);
		expect(mockExecGit).toHaveBeenNthCalledWith(
			2,
			[
				"diff",
				"--name-status",
				"merge-base",
				"HEAD",
				"--",
				"/outside.txt",
			],
			"/work/repo",
		);

		mockExecGit.mockReset();
		mockExecGit.mockResolvedValue("");
		mockReadConflictState.mockReset();
		const inRepoItem = makeConflictedItem(
			repo,
			Uri.file("/work/repo/a.txt"),
		);
		mockExecGit
			.mockRejectedValueOnce(
				new Error("path 'a.txt' does not have all necessary versions"),
			)
			.mockResolvedValueOnce("D\ta.txt\n");
		mockReadConflictState.mockResolvedValueOnce(undefined);
		await expect(api.restoreConflictedFile(inRepoItem)).rejects.toThrow(
			"no active merge/cherry-pick/rebase state found",
		);

		mockExecGit.mockReset();
		mockExecGit.mockResolvedValue("");
		mockReadConflictState.mockReset();
		mockExecGit
			.mockRejectedValueOnce(
				new Error("path 'a.txt' does not have all necessary versions"),
			)
			.mockResolvedValueOnce("M\ta.txt\n")
			.mockResolvedValueOnce("M\ta.txt\n");
		mockReadConflictState.mockResolvedValueOnce({
			operation: "merge",
			otherRef: "MERGE_HEAD",
		});
		await expect(api.restoreConflictedFile(inRepoItem)).rejects.toThrow(
			"neither side appears to have deleted it",
		);

		mockExecGit.mockReset();
		mockExecGit.mockResolvedValue("");
		mockReadConflictState.mockReset();
		mockExecGit
			.mockRejectedValueOnce(
				new Error("path 'a.txt' does not have all necessary versions"),
			)
			.mockResolvedValueOnce("D\ta.txt\n")
			.mockResolvedValueOnce("");
		mockReadConflictState.mockResolvedValueOnce({
			operation: "merge",
			otherRef: "MERGE_HEAD",
		});
		await expect(api.restoreConflictedFile(inRepoItem)).rejects.toThrow(
			"merge-base has no tree entry",
		);
	});
});

describe("extension remote smoke helper command", () => {
	it("registers and validates the remote smoke helper command", async () => {
		const repo = makeRepo("/work/repo", ["a.txt"]);
		installGitApi(makeGitApi([repo]));
		mockVscodeSetConfiguration(new Map([["weld.remoteSmokeTest", true]]));
		const { api } = activateWeld(new Map([["weld.remoteSmokeTest", true]]));
		jest.spyOn(
			api.conflictedFilesProvider,
			"getChildren",
		).mockResolvedValue([]);
		await expect(
			registered("meld-auto-merge.test.openFirstConflictFromTree")(),
		).rejects.toThrow("could not find a conflicted tree item");

		const conflict = new TestGitFile(
			"conflictedFile",
			makeConflictedItem(repo, Uri.file("/work/repo/a.txt")),
		);
		conflict.command = {
			command: "meld-auto-merge.openMeldDiff",
			title: "Open",
			arguments: [conflict],
		};
		jest.spyOn(
			api.conflictedFilesProvider,
			"getChildren",
		).mockResolvedValue([conflict]);
		mockVscodeSetOpenTextDocument(() =>
			Promise.resolve(
				documentFor(
					conflict.uri,
					"<<<<<<< ours\nlocal\n=======\nremote\n>>>>>>> theirs\n",
				),
			),
		);
		const executeCommand = jest.fn<(...args: unknown[]) => Promise<void>>();
		executeCommand.mockResolvedValue(undefined);
		mockVscodeSetExecuteCommand(executeCommand);

		const result = await registered(
			"meld-auto-merge.test.openFirstConflictFromTree",
		)();

		expect(result).toEqual({
			uri: "file:///work/repo/a.txt",
			command: "meld-auto-merge.openMeldDiff",
			stages: {
				base: "base\n",
				local: "local\n",
				remote: "remote\n",
			},
			initialState: {
				workingContent:
					"<<<<<<< ours\nlocal\n=======\nremote\n>>>>>>> theirs\n",
				reconstructedContent: "reconstructed\n",
			},
		});
		expect(mockFetchConflictStages).toHaveBeenCalledWith(
			conflict.conflictedItem,
		);
		expect(mockBuildInitialConflictedState).toHaveBeenCalled();
		expect(executeCommand).toHaveBeenCalledWith(
			"meld-auto-merge.openMeldDiff",
			conflict,
		);
	});
});
