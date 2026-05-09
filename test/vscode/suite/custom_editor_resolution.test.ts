import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "mocha";
import type { TextDocument, WebviewPanel } from "vscode";
import { extensions, Uri } from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { getGitApi, type RepoContext } from "../../../src/repoContext.ts";
import type { MeldCustomEditorProvider } from "../../../src/webview/meldWebviewPanel.ts";
import {
	makeBothAddedConflict,
	makeDeletedByThemConflict,
	makeDeletedByUsConflict,
	makeRepo,
	makeRepoFile,
	openRepoInGitExtension,
	runGit,
	waitForMergeChanges,
	waitForRepoClose,
} from "./helpers.ts";

interface CapturedInitArgs {
	repoContext: RepoContext;
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
	repoContext: RepoContext,
) => void;

// Resolved in the before() hook to the bundled class so that static fields
// (e.g. onConflictStateChanged) are the same instance as the running extension.
let MeldProviderClass: typeof MeldCustomEditorProvider;

before(async () => {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	const api = (await ext.activate()) as WeldExtensionApi;
	MeldProviderClass = api.meldCustomEditorProvider;
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
	)._initializeWebview = (_document, _webviewPanel, repoContext) => {
		sink.push({ repoContext });
	};
}

async function assertRepoContextResolution(
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
			const captured = await assertRepoContextResolution(
				repoPath,
				"src/deep/path/file.ts",
			);
			assert.equal(captured.length, 1);
			const first = captured[0];
			assert.ok(first);
			assert.equal(first.repoContext.rootUri.fsPath, repoPath);
			assert.equal(
				first.repoContext.uri.fsPath,
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
			const captured = await assertRepoContextResolution(
				worktreePath,
				"worktree-file.ts",
			);
			assert.equal(captured.length, 1);
			const first = captured[0];
			assert.ok(first);
			assert.equal(first.repoContext.rootUri.fsPath, worktreePath);
			assert.equal(
				first.repoContext.uri.fsPath,
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

describe("MeldCustomEditorProvider.resolveCustomTextEditor — conflict type routing", () => {
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
		await provider.resolveCustomTextEditor(
			makeDocument(Uri.file(join(repoPath, fileName))),
			panel as unknown as WebviewPanel,
			{} as never,
		);
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
			assert.equal(captured.length, 1);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});
