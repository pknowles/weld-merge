// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { basename } from "node:path";
import {
	type CancellationToken,
	type CustomDocument,
	type CustomDocumentOpenContext,
	type CustomReadonlyEditorProvider,
	commands,
	type Disposable,
	type ExtensionContext,
	Uri,
	type Webview,
	type WebviewPanel,
	window,
} from "vscode";
import { getWeldLogChannel } from "../log.ts";
import {
	EditorDisposedError,
	type GitApiRepository,
	getGitApi,
	onRepositoryStateChanged,
	readyRepositoryForRoot,
} from "../repoContext.ts";
import {
	changedFileUri,
	parentRefForCommit,
	parseSubmoduleConflictUri,
	readCommitFiles,
	readSubmoduleCommit,
	SubmoduleConflict,
	type SubmoduleConflictIdentity,
	SubmoduleConflictUnavailableError,
	searchSubmoduleCommits,
	submoduleConflictUri,
	submoduleUriFromIdentity,
} from "../submoduleConflict.ts";
import type { ConflictedFilesProvider } from "../treeView.ts";

interface SubmoduleConflictDocument extends CustomDocument {
	readonly identity: SubmoduleConflictIdentity;
}

interface ReadyMessage {
	command: "ready";
}

interface SearchCommitsMessage {
	command: "searchCommits";
	query: string;
}

interface LoadCommitFilesMessage {
	command: "loadCommitFiles";
	sha: string;
}

interface StageCommitMessage {
	command: "stageCommit";
	sha: string;
}

interface ShowFileDiffMessage {
	command: "showFileDiff";
	sha: string;
	filePath: string;
}

type SubmoduleWebviewMessage =
	| ReadyMessage
	| SearchCommitsMessage
	| LoadCommitFilesMessage
	| StageCommitMessage
	| ShowFileDiffMessage;

/**
 * The submodule resolver is a readonly custom editor keyed by a synthetic URI,
 * not a serializer-backed ad-hoc webview panel. The URI stores only identity
 * (repository root + repo-relative submodule path); every resolve/ready pass
 * rebuilds the conflict snapshot from the current Git state. That means a
 * restored VS Code tab shows the live conflict if it still exists, or an
 * explicit conflict-lost screen if the user resolved or aborted the merge.
 */
class SubmoduleConflictEditorProvider
	implements CustomReadonlyEditorProvider<SubmoduleConflictDocument>
{
	static readonly viewType = "weld.submoduleConflict";

	private readonly extensionUri: Uri;
	private readonly conflictedFilesProvider: ConflictedFilesProvider;
	private readonly snapshotVersions = new WeakMap<WebviewPanel, number>();
	private readonly snapshotSignatures = new WeakMap<WebviewPanel, string>();

	constructor(
		extensionUri: Uri,
		conflictedFilesProvider: ConflictedFilesProvider,
	) {
		this.extensionUri = extensionUri;
		this.conflictedFilesProvider = conflictedFilesProvider;
	}

	static uriFor(repository: GitApiRepository, submoduleUri: Uri): Uri {
		const identity = {
			repositoryRoot: repository.rootUri,
			submodulePath: repositoryRelativePath(repository, submoduleUri),
		};
		return submoduleConflictUri(identity);
	}

	static open(
		repository: GitApiRepository,
		submoduleUri: Uri,
	): Thenable<unknown> {
		return commands.executeCommand(
			"vscode.openWith",
			SubmoduleConflictEditorProvider.uriFor(repository, submoduleUri),
			SubmoduleConflictEditorProvider.viewType,
		);
	}

	static register(
		context: ExtensionContext,
		conflictedFilesProvider: ConflictedFilesProvider,
	): Disposable {
		const provider = new SubmoduleConflictEditorProvider(
			context.extensionUri,
			conflictedFilesProvider,
		);
		return window.registerCustomEditorProvider(
			SubmoduleConflictEditorProvider.viewType,
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		);
	}

	openCustomDocument(
		uri: Uri,
		_openContext: CustomDocumentOpenContext,
		_token: CancellationToken,
	): SubmoduleConflictDocument {
		const identity = parseSubmoduleConflictUri(uri);
		return {
			uri,
			identity,
			dispose: () => undefined,
		};
	}

	resolveCustomEditor(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		_token: CancellationToken,
	): void {
		webviewPanel.title = `Resolve: ${document.identity.submodulePath}`;
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [Uri.joinPath(this.extensionUri, "out")],
		};
		const disposables: Disposable[] = [];
		// The webview asks for state as soon as its script is ready. Repository
		// acquisition below either yields a ReadyRepository with populated Git
		// state or rejects with a typed terminal error; the editor never handles a
		// half-ready repository or a nullable "maybe later" value.
		let webviewReady = false;
		disposables.push(
			webviewPanel.webview.onDidReceiveMessage(
				async (message: SubmoduleWebviewMessage) => {
					if (message.command === "ready") {
						webviewReady = true;
						await this.postCurrentSnapshot(
							document,
							webviewPanel,
							this.nextSnapshotVersion(webviewPanel),
						).catch((error: unknown) =>
							this.postError(webviewPanel, error),
						);
					} else {
						await this.handleMessage(
							document,
							webviewPanel,
							message,
						);
					}
				},
			),
			onRepositoryStateChanged((repo) => {
				if (
					repo.rootUri.toString() ===
						document.identity.repositoryRoot.toString() &&
					webviewReady
				) {
					this.postCurrentSnapshot(
						document,
						webviewPanel,
						this.nextSnapshotVersion(webviewPanel),
					).catch((error: unknown) =>
						this.postError(webviewPanel, error),
					);
				}
			}),
		);
		webviewPanel.onDidDispose(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});
		webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
	}

	private async handleMessage(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		message: SubmoduleWebviewMessage,
	): Promise<void> {
		try {
			switch (message.command) {
				case "searchCommits":
					await this.handleSearch(document, webviewPanel, message);
					break;
				case "loadCommitFiles":
					await this.handleLoadCommitFiles(
						document,
						webviewPanel,
						message,
					);
					break;
				case "stageCommit":
					await this.handleStage(document, webviewPanel, message);
					break;
				case "showFileDiff":
					await this.handleShowFileDiff(
						document,
						webviewPanel,
						message,
					);
					break;
				default:
					break;
			}
		} catch (error: unknown) {
			if (error instanceof EditorDisposedError) {
				return;
			}
			this.postError(webviewPanel, error);
		}
	}

	private async loadConflict(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
	): Promise<SubmoduleConflict> {
		const readyRepository = await readyRepositoryForRoot(
			document.identity.repositoryRoot,
			webviewPanel,
		);
		const repository = readyRepository.repository;
		const submoduleUri = submoduleUriFromIdentity(document.identity);
		return SubmoduleConflict.load(repository, submoduleUri);
	}

	private async postCurrentSnapshot(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		version: number,
	): Promise<void> {
		// Repository state events can arrive in bursts while Git refreshes.
		// Each snapshot is a fresh live read from disk, so stale reads must not
		// post after a newer read has already started.
		try {
			const conflict = await this.loadConflict(document, webviewPanel);
			const snapshot = await conflict.buildSnapshot();
			if (!this.isCurrentSnapshotVersion(webviewPanel, version)) {
				return;
			}
			const signature = snapshotSignature(snapshot);
			if (this.snapshotSignatures.get(webviewPanel) === signature) {
				return;
			}
			this.snapshotSignatures.set(webviewPanel, signature);
			await webviewPanel.webview.postMessage({
				command: "snapshot",
				snapshot,
			});
		} catch (error: unknown) {
			if (!this.isCurrentSnapshotVersion(webviewPanel, version)) {
				return;
			}
			if (error instanceof EditorDisposedError) {
				return;
			}
			if (!(error instanceof SubmoduleConflictUnavailableError)) {
				throw error;
			}
			await webviewPanel.webview.postMessage({
				command: "conflictLost",
				message: errorMessage(error),
			});
		}
	}

	private nextSnapshotVersion(webviewPanel: WebviewPanel): number {
		const next = (this.snapshotVersions.get(webviewPanel) ?? 0) + 1;
		this.snapshotVersions.set(webviewPanel, next);
		return next;
	}

	private isCurrentSnapshotVersion(
		webviewPanel: WebviewPanel,
		version: number,
	): boolean {
		return this.snapshotVersions.get(webviewPanel) === version;
	}

	private async handleSearch(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		message: SearchCommitsMessage,
	): Promise<void> {
		const conflict = await this.loadConflict(document, webviewPanel);
		await webviewPanel.webview.postMessage({
			command: "searchResults",
			commits: await searchSubmoduleCommits(conflict, message.query),
		});
	}

	private async handleLoadCommitFiles(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		message: LoadCommitFilesMessage,
	): Promise<void> {
		const conflict = await this.loadConflict(document, webviewPanel);
		await webviewPanel.webview.postMessage({
			command: "commitFiles",
			sha: message.sha,
			files: await readCommitFiles(conflict, message.sha),
		});
	}

	private async handleStage(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		message: StageCommitMessage,
	): Promise<void> {
		const conflict = await this.loadConflict(document, webviewPanel);
		await conflict.stage(message.sha);
		this.conflictedFilesProvider.refresh();
		window.showInformationMessage(
			`Staged submodule ${basename(conflict.repoRelativePath)} at ${message.sha.slice(0, 7)}`,
		);
		await webviewPanel.webview.postMessage({ command: "staged" });
	}

	private async handleShowFileDiff(
		document: SubmoduleConflictDocument,
		webviewPanel: WebviewPanel,
		message: ShowFileDiffMessage,
	): Promise<void> {
		const conflict = await this.loadConflict(document, webviewPanel);
		const gitApi = getGitApi();
		const fileUri = changedFileUri(conflict, message.filePath);
		const rightUri = gitApi.toGitUri(fileUri, message.sha);
		const commit = await readSubmoduleCommit(conflict, message.sha);
		const leftRef = parentRefForCommit(commit);
		const leftUri = gitApi.toGitUri(fileUri, leftRef);
		await commands.executeCommand(
			"vscode.diff",
			leftUri,
			rightUri,
			`${basename(message.filePath)} (${message.sha.slice(0, 7)})`,
		);
	}

	private postError(webviewPanel: WebviewPanel, error: unknown): void {
		const message = errorMessage(error);
		getWeldLogChannel().error(`Submodule conflict resolver: ${message}`);
		webviewPanel.webview.postMessage({
			command: "error",
			message,
		});
	}

	private getHtml(webview: Webview): string {
		const scriptUri = webview.asWebviewUri(
			Uri.joinPath(this.extensionUri, "out", "webview", "submodule.js"),
		);
		const cssUri = webview.asWebviewUri(
			Uri.joinPath(this.extensionUri, "out", "webview", "submodule.css"),
		);
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Weld Submodule Conflict</title>
				<link rel="stylesheet" href="${cssUri}">
				<style>
					body { padding: 0; margin: 0; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
					#root { height: 100vh; overflow: hidden; }
				</style>
			</head>
			<body>
				<div id="root"></div>
				<script src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

function snapshotSignature(
	snapshot: Awaited<ReturnType<SubmoduleConflict["buildSnapshot"]>>,
): string {
	return [
		snapshot.submodulePath,
		snapshot.base,
		snapshot.local,
		snapshot.remote,
		snapshot.selected,
	].join("\n");
}

function repositoryRelativePath(
	repository: GitApiRepository,
	submoduleUri: Uri,
): string {
	const root = repository.rootUri.fsPath;
	const full = submoduleUri.fsPath;
	if (full === root || !full.startsWith(`${root}/`)) {
		throw new Error(
			`${submoduleUri.toString()} is not inside ${repository.rootUri.toString()}.`,
		);
	}
	return full.slice(root.length + 1);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const messages: string[] = [];
		const seen = new Set<unknown>();
		let current: unknown = error;
		while (current instanceof Error && !seen.has(current)) {
			seen.add(current);
			messages.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
		}
		if (current !== undefined && !seen.has(current)) {
			messages.push(String(current));
		}
		return messages.join(" -> caused by: ");
	}
	return String(error);
}

export { SubmoduleConflictEditorProvider };
