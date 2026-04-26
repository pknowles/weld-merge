import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, it } from "mocha";
import type { TextDocument, WebviewPanel } from "vscode";
import { Uri } from "vscode";
import { MeldCustomEditorProvider } from "../../../src/webview/meldWebviewPanel.ts";
import {
	makeRepo,
	makeRepoFile,
	openRepoInGitExtension,
	runGit,
} from "./helpers.ts";

interface CapturedInitArgs {
	repoPath: string;
	relativeFilePath: string;
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
	repoPath: string,
	relativeFilePath: string,
) => void;

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
	)._initializeWebview = (
		_document,
		_webviewPanel,
		repoPath,
		relativeFilePath,
	) => {
		sink.push({ repoPath, relativeFilePath });
	};
}

describe("MeldCustomEditorProvider.resolveCustomTextEditor", () => {
	it("shows unsupported-scheme message for non-file URIs", async () => {
		const provider = new MeldCustomEditorProvider(Uri.file("/tmp"));
		const panel = makeFakePanel();
		const document = makeDocument(Uri.parse("untitled:weld"));

		await provider.resolveCustomTextEditor(
			document,
			panel as unknown as WebviewPanel,
			{} as never,
		);

		assert.equal(
			panel.webview.html,
			"<p>Cannot open: Weld only supports local files.</p>",
		);
	});

	it("shows not-a-git-repository message for files outside repositories", async () => {
		const provider = new MeldCustomEditorProvider(Uri.file("/tmp"));
		const panel = makeFakePanel();
		const document = makeDocument(
			Uri.file(`/tmp/weld-outside-${Date.now()}.txt`),
		);

		await provider.resolveCustomTextEditor(
			document,
			panel as unknown as WebviewPanel,
			{} as never,
		);

		assert.equal(
			panel.webview.html,
			"<p>Cannot open: file is not in a git repository.</p>",
		);
	});

	it("resolves repo and relative path for a subdirectory file", async () => {
		const repoPath = await makeRepo("weld-vscode-editor-subdir-");
		try {
			await openRepoInGitExtension(repoPath);
			const provider = new MeldCustomEditorProvider(Uri.file("/tmp"));
			const panel = makeFakePanel();
			const captured: CapturedInitArgs[] = [];
			stubInitializeWebview(provider, captured);
			const fileUri = await makeRepoFile(
				repoPath,
				"src/deep/path/file.ts",
			);
			await provider.resolveCustomTextEditor(
				makeDocument(fileUri),
				panel as unknown as WebviewPanel,
				{} as never,
			);
			assert.equal(
				captured.length,
				1,
				`_initializeWebview should be called once; got HTML: ${panel.webview.html}`,
			);
			const first = captured[0];
			assert.ok(first);
			assert.equal(first.repoPath, repoPath);
			assert.equal(first.relativeFilePath, "src/deep/path/file.ts");
		} finally {
			await rm(repoPath, { recursive: true, force: true });
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
			await openRepoInGitExtension(worktreePath);
			const provider = new MeldCustomEditorProvider(Uri.file("/tmp"));
			const panel = makeFakePanel();
			const captured: CapturedInitArgs[] = [];
			stubInitializeWebview(provider, captured);
			const fileUri = await makeRepoFile(
				worktreePath,
				"worktree-file.ts",
			);
			await provider.resolveCustomTextEditor(
				makeDocument(fileUri),
				panel as unknown as WebviewPanel,
				{} as never,
			);
			assert.equal(
				captured.length,
				1,
				`_initializeWebview should be called once; got HTML: ${panel.webview.html}`,
			);
			const first = captured[0];
			assert.ok(first);
			assert.equal(first.repoPath, worktreePath);
			assert.equal(first.relativeFilePath, "worktree-file.ts");
		} finally {
			await rm(repoPath, { recursive: true, force: true });
			await rm(worktreePath, { recursive: true, force: true });
		}
	});
});
