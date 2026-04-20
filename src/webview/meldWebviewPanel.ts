import { basename, relative } from "node:path";
import {
	type CancellationToken,
	type ConfigurationChangeEvent,
	type CustomTextEditorProvider,
	commands,
	Disposable,
	EventEmitter,
	type ExtensionContext,
	env,
	extensions,
	Range,
	type TextDocument,
	type TextDocumentContentChangeEvent,
	type TextDocumentContentProvider,
	Uri,
	type Webview,
	type WebviewPanel,
	WorkspaceEdit,
	window,
	workspace,
} from "vscode";
import { getUnresolvedReasons, readConflictState } from "../gitUtils.ts";
import {
	type ConflictLabels,
	extractConflictLabels,
} from "./conflictLabels.ts";
import {
	buildBaseDiffPayload,
	buildDiffPayload,
	buildInitialConflictedState,
	fetchConflictStages,
} from "./diffPayload.ts";
import {
	classifyDocumentChange,
	type EditState,
	processContentChanged,
} from "./editorSync.ts";
import {
	clearInitialConflictContent as clearInitialConflictStoreEntry,
	getInitialConflictContent,
	INITIAL_CONFLICT_SCHEME,
	setInitialConflictContent as setInitialConflictStoreEntry,
} from "./initialConflictContentStore.ts";
import {
	assertReadyMessageIsFirst,
	type ReadyState,
} from "./readyStateGuard.ts";
import type {
	BaseDiffPayload,
	MonacoContentChange,
	WebviewPayload,
} from "./ui/types.ts";

const DEFAULT_DEBOUNCE_DELAY = 300;

interface ConflictStateChangeEvent {
	repoPath: string;
	stateKey: string | undefined;
}

interface ContentChangedMessage {
	command: "contentChanged";
	changes: MonacoContentChange[];
	lastExternalChangeVersion: number;
}

interface SaveMessage {
	command: "save";
	lastExternalChangeVersion: number;
}

interface RequestBaseDiffMessage {
	command: "requestBaseDiff";
	side: "left" | "right";
}

interface CopyHashMessage {
	command: "copyHash";
	hash: string;
}

interface ReadClipboardMessage {
	command: "readClipboard";
	requestId: number;
}

interface WriteClipboardMessage {
	command: "writeClipboard";
	text: string;
}

interface ShowDiffMessage {
	command: "showDiff";
	paneIndex: number;
}

interface ReadyMessage {
	command: "ready";
}

interface CompleteMergeMessage {
	command: "completeMerge";
}

type WebviewMessage =
	| ContentChangedMessage
	| RequestBaseDiffMessage
	| CopyHashMessage
	| ReadClipboardMessage
	| WriteClipboardMessage
	| ShowDiffMessage
	| ReadyMessage
	| CompleteMergeMessage
	| SaveMessage;

/**
 * Custom text editor provider for the Weld 3-way merge view.
 */
export class MeldCustomEditorProvider implements CustomTextEditorProvider {
	static readonly viewType = "weld.mergeEditor";
	static readonly onRequestRefresh = new EventEmitter<Uri>();
	static readonly onConflictStateChanged =
		new EventEmitter<ConflictStateChangeEvent>();

	private readonly extensionUri: Uri;

	constructor(extensionUri: Uri) {
		this.extensionUri = extensionUri;
	}

	static setInitialConflictContent(documentUri: Uri, content: string): Uri {
		const key = setInitialConflictStoreEntry(
			documentUri.toString(),
			content,
		);
		return Uri.parse(`${INITIAL_CONFLICT_SCHEME}:${key}`);
	}

	static clearInitialConflictContent(documentUri: Uri): void {
		clearInitialConflictStoreEntry(documentUri.toString());
	}

	static getCurrentConflictStateKey(repoPath: string): string | undefined {
		const state = readConflictState(repoPath);
		if (!state) {
			return;
		}
		return `${state.operation}:${state.otherRef}`;
	}

	private static _createInitialConflictContentProvider(): TextDocumentContentProvider {
		return {
			provideTextDocumentContent: (uri: Uri) => {
				const key = uri.path.startsWith("/")
					? uri.path.slice(1)
					: uri.path;
				return getInitialConflictContent(key);
			},
		};
	}

	static register(context: ExtensionContext): Disposable {
		const provider = new MeldCustomEditorProvider(context.extensionUri);
		const editorRegistration = window.registerCustomEditorProvider(
			MeldCustomEditorProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
			},
		);
		const contentProviderRegistration =
			workspace.registerTextDocumentContentProvider(
				INITIAL_CONFLICT_SCHEME,
				MeldCustomEditorProvider._createInitialConflictContentProvider(),
			);
		return Disposable.from(editorRegistration, contentProviderRegistration);
	}

	resolveCustomTextEditor(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		_token: CancellationToken,
	): Promise<void> {
		if (document.uri.scheme !== "file") {
			webviewPanel.webview.html =
				"<p>Cannot open: Weld only supports local files.</p>";
			return Promise.resolve();
		}

		const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			webviewPanel.webview.html = "<p>File is not in a workspace.</p>";
			return Promise.resolve();
		}

		const repoPath = workspaceFolder.uri.fsPath;
		const relativeFilePath = relative(
			repoPath,
			document.uri.fsPath,
		).replace(/\\/g, "/");

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [Uri.joinPath(this.extensionUri, "out")],
		};

		// Listener attached BEFORE setting html so "ready" is never missed
		// regardless of how fast the webview boots (especially over SSH).
		this._initializeWebview(
			document,
			webviewPanel,
			repoPath,
			relativeFilePath,
		);
		return Promise.resolve();
	}

	private _initializeWebview(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		repoPath: string,
		relativeFilePath: string,
	): void {
		const config = this._getWebviewConfig();

		// Phase 1 (before webview is ready): Setup per-editor sync state.
		const editState: EditState = {
			editQueue: Promise.resolve(),
			lastExternalChangeVersion: document.version,
			versionBeforeEdit: undefined,
		};
		const disposables: Disposable[] = [];

		const readyState: ReadyState = {
			snapshot: null,
			handled: false,
			handling: false,
		};

		const messageListener = webviewPanel.webview.onDidReceiveMessage(
			async (msg: WebviewMessage) => {
				if (msg.command === "ready") {
					await this._handleReadyMessage(
						readyState,
						{
							document,
							webviewPanel,
							repoPath,
							relativeFilePath,
							editState,
							disposables,
						},
						config,
					);
					return;
				}

				if (!readyState.snapshot) {
					// Non-ready messages before the snapshot is computed are dropped.
					return;
				}

				await this._handleMessage(msg, {
					document,
					webviewPanel,
					repoPath,
					relativeFilePath,
					editState,
				});
			},
		);
		disposables.push(messageListener);

		webviewPanel.onDidDispose(() => {
			MeldCustomEditorProvider.clearInitialConflictContent(document.uri);
			for (const d of disposables) {
				d.dispose();
			}
		});

		// Html is set after the listener is registered.
		webviewPanel.webview.html = this._getHtmlForWebview(
			webviewPanel.webview,
		);
	}

	private async _handleReadyMessage(
		readyState: ReadyState,
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			repoPath: string;
			relativeFilePath: string;
			editState: EditState;
			disposables: Disposable[];
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
	): Promise<void> {
		assertReadyMessageIsFirst(readyState, ctx.document.uri.toString());

		readyState.handling = true;
		try {
			const snapshot = await this._loadInitialSnapshot(ctx, config);
			if (!snapshot) {
				return;
			}
			readyState.snapshot = snapshot;
			readyState.handled = true;
			// Phase 2: setup listeners and send initial snapshot.
			// All of this is synchronous — no other code can interleave.
			this._setupPerEditorListeners({
				document: ctx.document,
				webviewPanel: ctx.webviewPanel,
				repoPath: ctx.repoPath,
				relativeFilePath: ctx.relativeFilePath,
				readyState,
				editState: ctx.editState,
				disposables: ctx.disposables,
			});
		} finally {
			readyState.handling = false;
		}
	}

	private async _applyAutoMergedContent(
		document: TextDocument,
		mergedContent: string | undefined,
	): Promise<void> {
		const docText = document.getText();
		if (mergedContent === undefined || mergedContent === docText) {
			return;
		}

		const edit = new WorkspaceEdit();
		const fullRange = new Range(
			document.positionAt(0),
			document.positionAt(docText.length),
		);
		edit.replace(document.uri, fullRange, mergedContent);
		await workspace.applyEdit(edit);
	}

	private async _loadInitialSnapshot(
		ctx: {
			document: TextDocument;
			repoPath: string;
			relativeFilePath: string;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
	): Promise<WebviewPayload["data"] | null> {
		const docText = ctx.document.getText();
		const stages = await fetchConflictStages(
			ctx.repoPath,
			ctx.relativeFilePath,
		);
		// Labels come from file markers, because git does not persist label text
		// in .git metadata and we need byte-exact reconstruction for the check.
		const labels = extractConflictLabels(docText);
		if (!labels) {
			this._warnAutoMergeSkipped(
				ctx.document,
				"could not read conflict labels from the current file text",
			);
			return this._snapshotFromCurrentDocument(
				ctx,
				config,
				stages,
				docText,
			);
		}

		const initialGitState = await this._tryBuildInitialConflictText(
			ctx,
			stages,
			labels,
		);
		if (initialGitState === undefined) {
			return this._snapshotFromCurrentDocument(
				ctx,
				config,
				stages,
				docText,
			);
		}
		if (docText === initialGitState) {
			return this._snapshotFromAutoMerge(ctx, config, stages);
		}

		const modAction = await this._checkAndPromptModification(
			ctx.document,
			initialGitState,
		);
		if (modAction === "cancel") {
			return null;
		}
		if (modAction === "keep") {
			return this._snapshotFromCurrentDocument(
				ctx,
				config,
				stages,
				docText,
			);
		}
		return this._snapshotFromAutoMerge(ctx, config, stages);
	}

	private async _tryBuildInitialConflictText(
		ctx: {
			document: TextDocument;
			repoPath: string;
		},
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
		labels: ConflictLabels,
	): Promise<string | undefined> {
		try {
			return await buildInitialConflictedState(
				ctx.repoPath,
				stages,
				labels,
			);
		} catch {
			this._warnAutoMergeSkipped(
				ctx.document,
				"failed to reconstruct git's initial conflict text",
			);
			return;
		}
	}

	private async _snapshotFromCurrentDocument(
		ctx: {
			repoPath: string;
			relativeFilePath: string;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
		docText: string,
	): Promise<WebviewPayload["data"]> {
		// Keep path: never rewrite the buffer; render and diff exactly what exists.
		const snapshot = await buildDiffPayload(
			ctx.repoPath,
			ctx.relativeFilePath,
			{
				stages,
				workingContent: docText,
			},
		);
		snapshot.config = config;
		return snapshot;
	}

	private async _snapshotFromAutoMerge(
		ctx: {
			document: TextDocument;
			repoPath: string;
			relativeFilePath: string;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
	): Promise<WebviewPayload["data"]> {
		// Replace path: compute merged middle content, then apply it in-memory only.
		const snapshot = await buildDiffPayload(
			ctx.repoPath,
			ctx.relativeFilePath,
			{
				stages,
			},
		);
		snapshot.config = config;
		await this._applyAutoMergedContent(
			ctx.document,
			snapshot.files[1]?.content,
		);
		return snapshot;
	}

	private async _checkAndPromptModification(
		document: TextDocument,
		initialGitState: string,
	): Promise<"replace" | "keep" | "cancel"> {
		const result = await window.showWarningMessage(
			"This file has been modified since the conflict was generated. Continuing will replace your changes with the auto-merged result.",
			{ modal: true },
			"Continue (Replace)",
			"Open Existing",
			"Compare",
		);
		if (result === "Compare") {
			const initialConflictUri =
				MeldCustomEditorProvider.setInitialConflictContent(
					document.uri,
					initialGitState,
				);
			await commands.executeCommand("workbench.action.closeActiveEditor");
			await commands.executeCommand(
				"vscode.diff",
				initialConflictUri,
				document.uri,
				"Original Conflict vs Current",
			);
			return "cancel";
		}
		if (result === "Open Existing") {
			return "keep";
		}
		if (result === "Continue (Replace)") {
			return "replace";
		}
		await commands.executeCommand("workbench.action.closeActiveEditor");
		return "cancel";
	}

	private _warnAutoMergeSkipped(
		document: TextDocument,
		reason: string,
	): void {
		const filePath = workspace.asRelativePath(document.uri, false);
		window.showWarningMessage(
			`Weld: auto-merge skipped - ${reason}. Expected conflict markers like "<<<<<<< HEAD", "||||||| merged common ancestors", "=======", and ">>>>>>> remote" in ${filePath}.`,
		);
	}

	private _getWebviewConfig() {
		const config = workspace.getConfiguration("weld");
		return {
			debounceDelay:
				config.get<number>("mergeEditor.debounceDelay") ??
				DEFAULT_DEBOUNCE_DELAY,
			syntaxHighlighting:
				config.get<boolean>("mergeEditor.syntaxHighlighting") ?? true,
			baseCompareHighlighting:
				config.get<boolean>("mergeEditor.baseCompareHighlighting") ??
				false,
			smoothScrolling:
				config.get<boolean>("mergeEditor.smoothScrolling") ?? true,
		};
	}

	private async _handleMessage(
		msg: WebviewMessage,
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			repoPath: string;
			relativeFilePath: string;
			editState: EditState;
		},
	): Promise<void> {
		switch (msg.command) {
			case "ready":
				// Handled in the outer listener closure.
				break;
			case "contentChanged": {
				ctx.editState.editQueue = processContentChanged({
					changes: msg.changes,
					msgVersion: msg.lastExternalChangeVersion,
					editState: ctx.editState,
					currentDocumentVersion: ctx.document.version,
					applyEdit: async (changes) => {
						const edit = new WorkspaceEdit();
						for (const change of changes) {
							const vsRange = new Range(
								change.range.startLineNumber - 1,
								change.range.startColumn - 1,
								change.range.endLineNumber - 1,
								change.range.endColumn - 1,
							);
							edit.replace(
								ctx.document.uri,
								vsRange,
								change.text,
							);
						}
						await workspace.applyEdit(edit);
					},
					postFullSync: () => {
						ctx.webviewPanel.webview.postMessage({
							command: "fullSync",
							content: ctx.document.getText(),
							lastExternalChangeVersion:
								ctx.editState.lastExternalChangeVersion,
						});
					},
				});
				break;
			}
			case "save":
				ctx.editState.editQueue = ctx.editState.editQueue.then(
					async () => {
						await ctx.document.save();
					},
				);
				break;
			case "copyHash":
				await env.clipboard.writeText(msg.hash);
				window.showInformationMessage(`Copied hash: ${msg.hash}`);
				break;
			case "readClipboard":
				await this._handleReadClipboard(
					ctx.webviewPanel,
					msg.requestId,
				);
				break;
			case "writeClipboard":
				await env.clipboard.writeText(msg.text);
				break;
			case "showDiff":
				await this._handleShowDiff(ctx.document, msg.paneIndex);
				break;
			case "requestBaseDiff":
				await this._handleRequestBaseDiff(ctx, msg);
				break;
			case "completeMerge":
				await this._handleCompleteMerge(ctx.document, ctx.webviewPanel);
				break;
			default:
				break;
		}
	}

	private _setupPerEditorListeners(ctx: {
		document: TextDocument;
		webviewPanel: WebviewPanel;
		repoPath: string;
		relativeFilePath: string;
		readyState: {
			snapshot: WebviewPayload["data"] | null;
			handled: boolean;
			handling: boolean;
		};
		editState: EditState;
		disposables: Disposable[];
	}): void {
		// Phase 2: inside the ready message handler.
		// All of this is synchronous — no other code can interleave.
		// This guarantees the content we send matches exactly what the listener tracks.

		const changeDocumentSubscription = workspace.onDidChangeTextDocument(
			(e) => this._handleTrackedDocumentChange(ctx, e),
		);

		const changeConfigurationSubscription =
			workspace.onDidChangeConfiguration((e) => {
				this._handleConfigChange(e, ctx.webviewPanel);
			});

		const refreshSubscription =
			MeldCustomEditorProvider.onRequestRefresh.event(async (uri) => {
				if (uri.toString() !== ctx.document.uri.toString()) {
					return;
				}
				const snapshot = await this._loadInitialSnapshot(
					{
						document: ctx.document,
						repoPath: ctx.repoPath,
						relativeFilePath: ctx.relativeFilePath,
					},
					this._getWebviewConfig(),
				);
				if (!snapshot) {
					return;
				}
				ctx.readyState.snapshot = snapshot;
				this._postCurrentLoadDiff(
					snapshot,
					ctx.document,
					ctx.webviewPanel,
					ctx.editState,
				);
			});

		const closeDocumentSubscription = workspace.onDidCloseTextDocument(
			(closedDocument) => {
				if (
					closedDocument.uri.toString() ===
					ctx.document.uri.toString()
				) {
					MeldCustomEditorProvider.clearInitialConflictContent(
						ctx.document.uri,
					);
				}
			},
		);

		const conflictStateSubscription =
			MeldCustomEditorProvider.onConflictStateChanged.event(
				async (event) => {
					if (event.repoPath !== ctx.repoPath) {
						return;
					}
					if (event.stateKey === undefined) {
						ctx.webviewPanel.webview.postMessage({
							command: "conflictStateLost",
						});
						return;
					}
					const snapshot = await this._loadInitialSnapshot(
						{
							document: ctx.document,
							repoPath: ctx.repoPath,
							relativeFilePath: ctx.relativeFilePath,
						},
						this._getWebviewConfig(),
					);
					if (!snapshot) {
						return;
					}
					ctx.readyState.snapshot = snapshot;
					this._postCurrentLoadDiff(
						snapshot,
						ctx.document,
						ctx.webviewPanel,
						ctx.editState,
					);
				},
			);

		ctx.disposables.push(
			changeDocumentSubscription,
			changeConfigurationSubscription,
			refreshSubscription,
			closeDocumentSubscription,
			conflictStateSubscription,
		);

		const currentSnapshot = ctx.readyState.snapshot;
		if (!currentSnapshot) {
			throw new Error(
				`Expected initial snapshot for ${ctx.document.uri.toString()} before listener setup.`,
			);
		}
		this._postCurrentLoadDiff(
			currentSnapshot,
			ctx.document,
			ctx.webviewPanel,
			ctx.editState,
		);
	}

	private _handleTrackedDocumentChange(
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			editState: EditState;
		},
		e: {
			document: TextDocument;
			contentChanges: readonly TextDocumentContentChangeEvent[];
		},
	): void {
		if (e.document.uri.toString() !== ctx.document.uri.toString()) {
			return;
		}

		const action = classifyDocumentChange(
			e.document.version,
			ctx.editState,
		);

		if (action === "suppress") {
			// Our own echo — no ack needed, webview already applied optimistically.
			// Do NOT update lastExternalChangeVersion (Issue 11, 14).
			return;
		}

		// External change — update version and notify webview.
		ctx.editState.lastExternalChangeVersion = e.document.version;

		if (action === "fullSync") {
			ctx.webviewPanel.webview.postMessage({
				command: "fullSync",
				content: ctx.document.getText(),
				lastExternalChangeVersion:
					ctx.editState.lastExternalChangeVersion,
			});
			return;
		}

		ctx.webviewPanel.webview.postMessage({
			command: "externalEdit",
			changes: this._toMonacoChanges(e.contentChanges),
			lastExternalChangeVersion: ctx.editState.lastExternalChangeVersion,
		});
	}

	private _toMonacoChanges(
		contentChanges: readonly TextDocumentContentChangeEvent[],
	): MonacoContentChange[] {
		return contentChanges.map((change) => ({
			range: {
				startLineNumber: change.range.start.line + 1,
				startColumn: change.range.start.character + 1,
				endLineNumber: change.range.end.line + 1,
				endColumn: change.range.end.character + 1,
			},
			text: change.text,
		}));
	}

	private _postCurrentLoadDiff(
		snapshot: WebviewPayload["data"],
		document: TextDocument,
		webviewPanel: WebviewPanel,
		editState: EditState,
	): void {
		editState.lastExternalChangeVersion = document.version;
		if (snapshot.files[1]) {
			snapshot.files[1].content = document.getText();
		}
		const message: WebviewPayload = {
			command: "loadDiff",
			lastExternalChangeVersion: editState.lastExternalChangeVersion,
			data: snapshot,
		};
		webviewPanel.webview.postMessage(message);
	}

	private _handleConfigChange(
		e: ConfigurationChangeEvent,
		webviewPanel: WebviewPanel,
	) {
		if (
			e.affectsConfiguration("weld.mergeEditor.debounceDelay") ||
			e.affectsConfiguration("weld.mergeEditor.syntaxHighlighting") ||
			e.affectsConfiguration(
				"weld.mergeEditor.baseCompareHighlighting",
			) ||
			e.affectsConfiguration("weld.mergeEditor.smoothScrolling")
		) {
			webviewPanel.webview.postMessage({
				command: "updateConfig",
				config: this._getWebviewConfig(),
			});
		}
	}

	private async _handleReadClipboard(
		webviewPanel: WebviewPanel,
		requestId: number,
	) {
		const text = await env.clipboard.readText();
		webviewPanel.webview.postMessage({
			command: "clipboardText",
			requestId,
			text,
		});
	}

	private async _handleRequestBaseDiff(
		ctx: {
			repoPath: string;
			relativeFilePath: string;
			webviewPanel: WebviewPanel;
		},
		msg: RequestBaseDiffMessage,
	) {
		const basePayload = (await buildBaseDiffPayload(
			ctx.repoPath,
			ctx.relativeFilePath,
			msg.side,
		)) as {
			command: string;
			data: BaseDiffPayload;
		};
		ctx.webviewPanel.webview.postMessage(basePayload);
	}

	private async _handleCompleteMerge(
		document: TextDocument,
		webviewPanel: WebviewPanel,
	) {
		const unresolvedReasons = getUnresolvedReasons(document.getText());
		if (unresolvedReasons.length > 0) {
			window.showErrorMessage(
				`Cannot complete merge: file contains ${unresolvedReasons.join(" and ")}.`,
			);
		} else {
			await document.save();
			const success = await commands.executeCommand(
				"meld-auto-merge.smartAdd",
				{ uri: document.uri },
			);
			if (success === true) {
				webviewPanel.dispose();
			}
		}
	}

	private async _handleShowDiff(
		document: TextDocument,
		paneIndex: number,
	): Promise<void> {
		if (document.uri.scheme !== "file") {
			window.showErrorMessage("Cannot open diff: not a local file.");
			return;
		}
		const gitExt = extensions.getExtension("vscode.git");
		if (!gitExt) {
			window.showErrorMessage("Git extension is not available.");
			return;
		}
		if (!gitExt.isActive) {
			await gitExt.activate();
		}
		const gitApi = gitExt.exports.getAPI(1);
		const baseUri = gitApi.toGitUri(document.uri, ":1");
		const targetUri = gitApi.toGitUri(
			document.uri,
			paneIndex === 0 || paneIndex === 1 ? ":2" : ":3",
		);
		const label = `${basename(document.uri.fsPath)} (Base ↔ ${paneIndex === 0 || paneIndex === 1 ? "Local" : "Remote"})`;
		try {
			await commands.executeCommand(
				"vscode.diff",
				baseUri,
				targetUri,
				label,
			);
		} catch (e) {
			const err = e instanceof Error ? e.message : String(e);
			window.showErrorMessage(`Failed to open diff: ${err}`);
		}
	}

	private _getHtmlForWebview(webview: Webview): string {
		const scriptUri = webview.asWebviewUri(
			Uri.joinPath(this.extensionUri, "out", "webview", "index.js"),
		);
		const cssUri = webview.asWebviewUri(
			Uri.joinPath(this.extensionUri, "out", "webview", "index.css"),
		);

		return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Weld Merge</title>
                <link rel="stylesheet" href="${cssUri}">
                <style>
                    body { padding: 0; margin: 0; background-color: #1e1e1e; }
                </style>
            </head>
            <body>
                <div id="root"></div>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
	}
}
