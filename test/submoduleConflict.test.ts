import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CancellationToken,
	type CustomDocumentOpenContext,
	commands,
	extensions,
	Uri,
	type WebviewPanel,
	window,
} from "vscode";
import { initializeWeldLogChannel } from "../src/log.ts";
import type { GitApiRepository } from "../src/repoContext.ts";
import { GitStatus, notifyRepositoryReady } from "../src/repoContext.ts";
import {
	isActiveSubmoduleGitlinkConflict,
	isKnownSubmoduleConflictPath,
	parentRefForCommit,
	parseSubmoduleConflictUri,
	readCommitFiles,
	readSubmoduleCommit,
	SubmoduleConflict,
	searchSubmoduleCommits,
	submoduleConflictUri,
} from "../src/submoduleConflict.ts";
import type { ConflictedFilesProvider } from "../src/treeView.ts";
import { SubmoduleConflictEditorProvider } from "../src/webview/submoduleConflictEditor.ts";

interface SubmoduleRepoFixture {
	parentPath: string;
	submoduleUri: Uri;
	preBase: string | null;
	base: string;
	local: string;
	remote: string;
	cleanup(): void;
}

interface TextConflictRepoFixture {
	parentPath: string;
	fileUri: Uri;
	cleanup(): void;
}

interface RemovedSubmoduleRepoFixture {
	parentPath: string;
	submoduleUri: Uri;
	cleanup(): void;
}

interface CapturedWebview {
	html: string;
	options: unknown;
	onDidReceiveMessage(listener: (message: unknown) => Promise<void> | void): {
		dispose(): void;
	};
	postMessage(message: unknown): Promise<boolean>;
	asWebviewUri(uri: Uri): Uri;
}

interface CapturedPanel {
	title: string;
	webview: CapturedWebview;
	onDidDispose(listener: () => void): { dispose(): void };
}

interface MutableCommands {
	executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
}

interface MutableExtensions {
	getExtension(extensionId: string): unknown;
}

interface MutableWindow {
	showInformationMessage(message: string): Promise<unknown>;
}

function runGit(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function expectUnmergedPaths(repoPath: string, paths: string[]): void {
	const unmergedPaths = runGit(
		["diff", "--name-only", "--diff-filter=U"],
		repoPath,
	).split("\n");
	expect(unmergedPaths).toEqual(expect.arrayContaining(paths));
}

function makeRepository(rootPath: string, submoduleUri: Uri): GitApiRepository {
	return {
		rootUri: Uri.file(rootPath),
		state: {
			mergeChanges: [
				{ uri: submoduleUri, status: GitStatus.BOTH_MODIFIED },
			],
			onDidChange: () => ({ dispose: () => undefined }),
		},
		show: () => Promise.reject(new Error("not used")),
		getCommit: () => Promise.reject(new Error("not used")),
		getMergeBase: (ref1: string, ref2: string) =>
			Promise.resolve(runGit(["merge-base", ref1, ref2], rootPath)),
		add: () => Promise.resolve(),
	};
}

function makeWebviewPanel(): {
	panel: WebviewPanel;
	messages: unknown[];
	receive(message: unknown): Promise<void>;
} {
	let listener: ((message: unknown) => Promise<void> | void) | null = null;
	const messages: unknown[] = [];
	const panel: CapturedPanel = {
		title: "",
		webview: {
			html: "",
			options: {},
			onDidReceiveMessage: (nextListener) => {
				listener = nextListener;
				return { dispose: () => undefined };
			},
			postMessage: (message) => {
				messages.push(message);
				return Promise.resolve(true);
			},
			asWebviewUri: (uri) => uri,
		},
		onDidDispose: () => ({ dispose: () => undefined }),
	};
	return {
		panel: panel as unknown as WebviewPanel,
		messages,
		receive: async (message: unknown) => {
			if (!listener) {
				throw new Error("Webview message listener was not registered.");
			}
			await listener(message);
		},
	};
}

function installGitApi(repository: GitApiRepository): () => void {
	const mutableExtensions = extensions as unknown as MutableExtensions;
	const originalGetExtension = mutableExtensions.getExtension;
	mutableExtensions.getExtension = () => ({
		exports: {
			getAPI: () => ({
				git: { path: "git" },
				repositories: [repository],
				onDidOpenRepository: () => ({ dispose: () => undefined }),
				onDidCloseRepository: () => ({ dispose: () => undefined }),
				getRepository: (uri: Uri) =>
					uri.toString() === repository.rootUri.toString()
						? repository
						: null,
				openRepository: () => Promise.resolve(repository),
				toGitUri: (uri: Uri, ref: string) =>
					Uri.from({
						scheme: "git",
						path: uri.path,
						query: new URLSearchParams({ ref }).toString(),
					}),
			}),
		},
	});
	return () => {
		mutableExtensions.getExtension = originalGetExtension;
	};
}

function makeSubmoduleConflictRepo(
	options: { preBaseCommit: boolean } = { preBaseCommit: false },
): SubmoduleRepoFixture {
	const root = mkdtempSync(join(tmpdir(), "weld-submodule-conflict-"));
	const subSource = join(root, "subsrc");
	const parentPath = join(root, "parent");
	runGit(["init", "-q", "-b", "main", subSource], root);
	runGit(["config", "user.name", "Weld Test"], subSource);
	runGit(["config", "user.email", "weld-test@example.com"], subSource);
	let preBase: string | null = null;
	if (options.preBaseCommit) {
		writeFileSync(join(subSource, "file.txt"), "pre-base\n");
		runGit(["add", "file.txt"], subSource);
		runGit(["commit", "-q", "-m", "pre-base"], subSource);
		preBase = runGit(["rev-parse", "HEAD"], subSource);
	}
	writeFileSync(join(subSource, "file.txt"), "base\n");
	runGit(["add", "file.txt"], subSource);
	runGit(["commit", "-q", "-m", "base"], subSource);
	const base = runGit(["rev-parse", "HEAD"], subSource);
	runGit(["checkout", "-q", "-b", "other"], subSource);
	writeFileSync(join(subSource, "file.txt"), "remote\n");
	runGit(["commit", "-am", "remote", "-q"], subSource);
	const remote = runGit(["rev-parse", "HEAD"], subSource);
	runGit(["checkout", "-q", "main"], subSource);
	writeFileSync(join(subSource, "file.txt"), "local\n");
	runGit(["commit", "-am", "local", "-q"], subSource);
	const local = runGit(["rev-parse", "HEAD"], subSource);

	runGit(["init", "-q", "-b", "main", parentPath], root);
	runGit(["config", "user.name", "Weld Test"], parentPath);
	runGit(["config", "user.email", "weld-test@example.com"], parentPath);
	runGit(
		[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			subSource,
			"sub",
		],
		parentPath,
	);
	runGit(["checkout", "-q", base], join(parentPath, "sub"));
	runGit(["add", "sub", ".gitmodules"], parentPath);
	runGit(["commit", "-q", "-m", "add sub"], parentPath);
	runGit(["checkout", "-q", "-b", "other"], parentPath);
	runGit(["checkout", "-q", remote], join(parentPath, "sub"));
	runGit(["add", "sub"], parentPath);
	runGit(["commit", "-q", "-m", "remote sub"], parentPath);
	runGit(["checkout", "-q", "main"], parentPath);
	runGit(["checkout", "-q", local], join(parentPath, "sub"));
	runGit(["add", "sub"], parentPath);
	runGit(["commit", "-q", "-m", "local sub"], parentPath);
	try {
		runGit(["merge", "other"], parentPath);
	} catch {
		// Git exits non-zero for the expected submodule conflict.
	}
	expectUnmergedPaths(parentPath, ["sub"]);
	return {
		parentPath,
		submoduleUri: Uri.file(join(parentPath, "sub")),
		preBase,
		base,
		local,
		remote,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function makeTextConflictRepo(): TextConflictRepoFixture {
	const parentPath = mkdtempSync(join(tmpdir(), "weld-text-conflict-"));
	runGit(["init", "-q", "-b", "main"], parentPath);
	runGit(["config", "user.name", "Weld Test"], parentPath);
	runGit(["config", "user.email", "weld-test@example.com"], parentPath);
	writeFileSync(join(parentPath, "file.txt"), "base\n");
	runGit(["add", "file.txt"], parentPath);
	runGit(["commit", "-q", "-m", "base"], parentPath);
	runGit(["checkout", "-q", "-b", "other"], parentPath);
	writeFileSync(join(parentPath, "file.txt"), "remote\n");
	runGit(["commit", "-am", "remote", "-q"], parentPath);
	runGit(["checkout", "-q", "main"], parentPath);
	writeFileSync(join(parentPath, "file.txt"), "local\n");
	runGit(["commit", "-am", "local", "-q"], parentPath);
	try {
		runGit(["merge", "other"], parentPath);
	} catch {
		// Git exits non-zero for the expected text conflict.
	}
	expectUnmergedPaths(parentPath, ["file.txt"]);
	return {
		parentPath,
		fileUri: Uri.file(join(parentPath, "file.txt")),
		cleanup: () => rmSync(parentPath, { recursive: true, force: true }),
	};
}

function makeRemovedSubmoduleDuringTextConflictRepo(): RemovedSubmoduleRepoFixture {
	const root = mkdtempSync(join(tmpdir(), "weld-removed-submodule-"));
	const subSource = join(root, "subsrc");
	const parentPath = join(root, "parent");
	runGit(["init", "-q", "-b", "main", subSource], root);
	runGit(["config", "user.name", "Weld Test"], subSource);
	runGit(["config", "user.email", "weld-test@example.com"], subSource);
	writeFileSync(join(subSource, "file.txt"), "base\n");
	runGit(["add", "file.txt"], subSource);
	runGit(["commit", "-q", "-m", "base"], subSource);

	runGit(["init", "-q", "-b", "main", parentPath], root);
	runGit(["config", "user.name", "Weld Test"], parentPath);
	runGit(["config", "user.email", "weld-test@example.com"], parentPath);
	runGit(
		[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			subSource,
			"sub",
		],
		parentPath,
	);
	writeFileSync(join(parentPath, "tracked.txt"), "base\n");
	runGit(["add", ".gitmodules", "sub", "tracked.txt"], parentPath);
	runGit(["commit", "-q", "-m", "base"], parentPath);

	runGit(["checkout", "-q", "-b", "other"], parentPath);
	runGit(["rm", "-q", "sub", ".gitmodules"], parentPath);
	writeFileSync(join(parentPath, "tracked.txt"), "remote\n");
	runGit(["add", "tracked.txt"], parentPath);
	runGit(["commit", "-q", "-m", "remote removes sub"], parentPath);

	runGit(["checkout", "-q", "main"], parentPath);
	runGit(["rm", "-q", "sub", ".gitmodules"], parentPath);
	writeFileSync(join(parentPath, "tracked.txt"), "local\n");
	runGit(["add", "tracked.txt"], parentPath);
	runGit(["commit", "-q", "-m", "local removes sub"], parentPath);
	try {
		runGit(["merge", "other"], parentPath);
	} catch {
		// Git exits non-zero for the expected text conflict.
	}
	expectUnmergedPaths(parentPath, ["tracked.txt"]);
	return {
		parentPath,
		submoduleUri: Uri.file(join(parentPath, "sub")),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("SubmoduleConflict identity and loading", () => {
	it("round-trips custom editor identity URIs", () => {
		const identity = {
			repositoryRoot: Uri.file("/tmp/example"),
			submodulePath: "libs/example",
		};
		expect(
			parseSubmoduleConflictUri(submoduleConflictUri(identity)),
		).toEqual(identity);
		expect(submoduleConflictUri(identity).path).toBe(
			"/example.weld-submodule-conflict",
		);
	});

	it("loads a live submodule conflict from Git API candidates", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			expect(conflict.shas).toEqual({
				base: fixture.base,
				local: fixture.local,
				remote: fixture.remote,
			});
		} finally {
			fixture.cleanup();
		}
	});
});

describe("SubmoduleConflict staging and restore", () => {
	it("stages a selected submodule commit", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			await conflict.stage(fixture.remote);
			expect(runGit(["rev-parse", ":sub"], fixture.parentPath)).toBe(
				fixture.remote,
			);
			expect(
				runGit(
					["diff", "--name-only", "--diff-filter=U"],
					fixture.parentPath,
				),
			).toBe("");
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects staging a SHA that is not a commit in the submodule", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			await expect(
				conflict.stage("ffffffffffffffffffffffffffffffffffffffff"),
			).rejects.toThrow("commit does not exist");
		} finally {
			fixture.cleanup();
		}
	});

	it("restores unmerged gitlink stages after a submodule conflict was resolved", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			await conflict.stage(fixture.remote);
			repository.state.mergeChanges = [
				{
					uri: fixture.submoduleUri,
					status: GitStatus.BOTH_MODIFIED,
				},
			];
			await SubmoduleConflict.restore(repository, fixture.submoduleUri);
			expect(runGit(["rev-parse", ":1:sub"], fixture.parentPath)).toBe(
				fixture.base,
			);
			expect(runGit(["rev-parse", ":2:sub"], fixture.parentPath)).toBe(
				fixture.local,
			);
			expect(runGit(["rev-parse", ":3:sub"], fixture.parentPath)).toBe(
				fixture.remote,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects restoring a path that neither side contains as a submodule", async () => {
		const fixture = makeRemovedSubmoduleDuringTextConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			await expect(
				SubmoduleConflict.restore(repository, fixture.submoduleUri),
			).rejects.toThrow("neither side has a submodule entry");
		} finally {
			fixture.cleanup();
		}
	});
});

describe("SubmoduleConflict history", () => {
	it("builds an initial snapshot when the base submodule commit is a root commit", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			const snapshot = await conflict.buildSnapshot();
			expect(snapshot.base).toBe(fixture.base);
			expect(snapshot.local).toBe(fixture.local);
			expect(snapshot.remote).toBe(fixture.remote);
			expect(snapshot.commits.map((commit) => commit.hash)).toEqual(
				expect.arrayContaining([
					fixture.base,
					fixture.local,
					fixture.remote,
				]),
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("includes root-safe history context before the conflict base", async () => {
		const fixture = makeSubmoduleConflictRepo({ preBaseCommit: true });
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			const snapshot = await conflict.buildSnapshot();
			expect(fixture.preBase).not.toBeNull();
			expect(snapshot.commits.map((commit) => commit.hash)).toEqual(
				expect.arrayContaining([
					fixture.preBase,
					fixture.base,
					fixture.local,
					fixture.remote,
				]),
			);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("SubmoduleConflict history details", () => {
	it("keeps the initial snapshot in Git's topo-order", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			const snapshot = await conflict.buildSnapshot();
			const expectedOrder = runGit(
				[
					"log",
					"--topo-order",
					"--reverse",
					"--format=%H",
					fixture.local,
					fixture.remote,
					fixture.base,
				],
				join(fixture.parentPath, "sub"),
			).split("\n");
			expect(snapshot.commits.map((commit) => commit.hash)).toEqual(
				expectedOrder,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("reads files changed by root commits", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			await expect(
				readCommitFiles(conflict, fixture.base),
			).resolves.toEqual([{ status: "A", path: "file.txt" }]);
		} finally {
			fixture.cleanup();
		}
	});

	it("searches commits by SHA prefix and reads parent refs for diffs", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			const results = await searchSubmoduleCommits(
				conflict,
				fixture.remote.slice(0, 8),
			);
			expect(results.map((commit) => commit.hash)).toContain(
				fixture.remote,
			);
			const remoteCommit = await readSubmoduleCommit(
				conflict,
				fixture.remote,
			);
			expect(parentRefForCommit(remoteCommit)).toBe(fixture.base);
			await expect(
				readCommitFiles(conflict, fixture.remote),
			).resolves.toEqual([{ status: "M", path: "file.txt" }]);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("SubmoduleConflict classification", () => {
	it("does not classify active text conflicts as submodule conflicts", async () => {
		const fixture = makeTextConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.fileUri,
			);
			await expect(
				isActiveSubmoduleGitlinkConflict(repository, fixture.fileUri),
			).resolves.toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects loading active text conflicts as submodule conflicts", async () => {
		const fixture = makeTextConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.fileUri,
			);
			await expect(
				SubmoduleConflict.load(repository, fixture.fileUri),
			).rejects.toThrow("not a submodule conflict");
		} finally {
			fixture.cleanup();
		}
	});

	it("recognizes resolved submodule conflict paths even when staged to HEAD", async () => {
		const fixture = makeSubmoduleConflictRepo();
		try {
			const repository = makeRepository(
				fixture.parentPath,
				fixture.submoduleUri,
			);
			const conflict = await SubmoduleConflict.load(
				repository,
				fixture.submoduleUri,
			);
			await conflict.stage(fixture.local);
			repository.state.mergeChanges = [];
			await expect(
				isKnownSubmoduleConflictPath(repository, fixture.submoduleUri),
			).resolves.toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});

beforeAll(() => {
	initializeWeldLogChannel();
});

describe("SubmoduleConflictEditorProvider", () => {
	it("routes webview messages through live submodule conflict state", async () => {
		const fixture = makeSubmoduleConflictRepo();
		const repository = makeRepository(
			fixture.parentPath,
			fixture.submoduleUri,
		);
		const restoreGitApi = installGitApi(repository);
		const originalExecuteCommand = (commands as unknown as MutableCommands)
			.executeCommand;
		const originalShowInformationMessage = (
			window as unknown as MutableWindow
		).showInformationMessage;
		const executedCommands: unknown[][] = [];
		const infoMessages: string[] = [];
		(commands as unknown as MutableCommands).executeCommand = (
			command,
			...args
		) => {
			executedCommands.push([command, ...args]);
			return Promise.resolve(undefined);
		};
		(window as unknown as MutableWindow).showInformationMessage = (
			message,
		) => {
			infoMessages.push(message);
			return Promise.resolve(undefined);
		};
		try {
			const refresh = jest.fn();
			const provider = new SubmoduleConflictEditorProvider(
				Uri.file("/extension"),
				{ refresh } as unknown as ConflictedFilesProvider,
			);
			const document = provider.openCustomDocument(
				SubmoduleConflictEditorProvider.uriFor(
					repository,
					fixture.submoduleUri,
				),
				{} as CustomDocumentOpenContext,
				{} as CancellationToken,
			);
			const { panel, messages, receive } = makeWebviewPanel();
			provider.resolveCustomEditor(
				document,
				panel,
				{} as CancellationToken,
			);

			notifyRepositoryReady(repository);
			await receive({ command: "ready" });
			expect(messages).toContainEqual(
				expect.objectContaining({ command: "snapshot" }),
			);
			expect(panel.title).toBe("Resolve: sub");

			await receive({ command: "searchCommits", query: "remote" });
			expect(messages).toContainEqual(
				expect.objectContaining({ command: "searchResults" }),
			);

			await receive({
				command: "loadCommitFiles",
				sha: fixture.remote,
			});
			expect(messages).toContainEqual({
				command: "commitFiles",
				sha: fixture.remote,
				files: [{ status: "M", path: "file.txt" }],
			});

			await receive({
				command: "showFileDiff",
				sha: fixture.remote,
				filePath: "file.txt",
			});
			expect(executedCommands).toContainEqual([
				"vscode.diff",
				expect.objectContaining({ scheme: "git" }),
				expect.objectContaining({ scheme: "git" }),
				`file.txt (${fixture.remote.slice(0, 7)})`,
			]);

			await receive({ command: "stageCommit", sha: fixture.remote });
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(infoMessages).toEqual([
				`Staged submodule sub at ${fixture.remote.slice(0, 7)}`,
			]);
			expect(messages).toContainEqual({ command: "staged" });
		} finally {
			(commands as unknown as MutableCommands).executeCommand =
				originalExecuteCommand;
			(window as unknown as MutableWindow).showInformationMessage =
				originalShowInformationMessage;
			restoreGitApi();
			fixture.cleanup();
		}
	});
});

describe("SubmoduleConflictEditorProvider states", () => {
	it("reports conflict-lost snapshots without replacing operational errors", async () => {
		const fixture = makeSubmoduleConflictRepo();
		const repository = makeRepository(
			fixture.parentPath,
			fixture.submoduleUri,
		);
		const restoreGitApi = installGitApi(repository);
		try {
			const provider = new SubmoduleConflictEditorProvider(
				Uri.file("/extension"),
				{
					refresh: () => undefined,
				} as unknown as ConflictedFilesProvider,
			);
			const document = provider.openCustomDocument(
				SubmoduleConflictEditorProvider.uriFor(
					repository,
					fixture.submoduleUri,
				),
				{} as CustomDocumentOpenContext,
				{} as CancellationToken,
			);
			const { panel, messages, receive } = makeWebviewPanel();
			provider.resolveCustomEditor(
				document,
				panel,
				{} as CancellationToken,
			);

			repository.state.mergeChanges = [];
			notifyRepositoryReady(repository);
			await receive({ command: "ready" });
			expect(messages).toContainEqual({
				command: "conflictLost",
				message: "Submodule conflict is no longer active for sub.",
			});

			(repository.state as { mergeChanges: unknown }).mergeChanges =
				undefined;
			await receive({ command: "ready" });
			expect(messages).toContainEqual(
				expect.objectContaining({
					command: "error",
					message: expect.stringContaining("reading 'find'"),
				}),
			);
		} finally {
			restoreGitApi();
			fixture.cleanup();
		}
	});
});
