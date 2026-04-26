import { basename } from "node:path";
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
	type GitApiRepository,
	isSupportedScheme,
	type RepoContext,
	resolveRepoContext,
} from "../repoContext.ts";
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
	deleteInitialConflictContent,
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

/*
 * ============================================================================
 * EDITOR SYNCHRONIZATION ARCHITECTURE
 * ============================================================================
 *
 * This module implements bidirectional sync between VS Code's TextDocument and
 * the Monaco editor in our webview. The design follows these core principles:
 *
 * 1. TEXTDOCUMENT IS THE SOURCE OF TRUTH
 *    Monaco is a local cache that can be rebuilt from the TextDocument at any
 *    time. Edits flow: Monaco → TextDocument → persisted. If anything goes
 *    wrong, we send a "fullSync" to replace Monaco's content entirely.
 *
 * 2. OPTIMISTIC UPDATES WITH LAZY CORRECTION
 *    The webview applies edits immediately (optimistic) and sends them to us.
 *    If we detect the edit was based on stale content, we reject it and send
 *    fullSync. The webview doesn't wait for acknowledgment — it only receives
 *    correction when needed. This keeps typing responsive.
 *
 * 3. NO ACKNOWLEDGMENT MESSAGES
 *    The protocol is deliberately simple. The webview sends edits tagged with
 *    "lastExternalChangeVersion". We compare against our version to detect
 *    staleness. No explicit acks, no message IDs, no complex handshakes.
 *
 * 4. FIFO ORDERING THROUGH SHARED QUEUE
 *    The webview sends edits AND saves through the same postMessage channel.
 *    We process them through a serialized editQueue. This guarantees:
 *    - Type "abc" → Ctrl+S saves "abc", not partial content
 *    - Multiple rapid edits apply in order, not interleaved
 *
 * 5. ECHO SUPPRESSION VIA VERSION CHECK
 *    When we apply a webview edit, VS Code fires onDidChangeTextDocument.
 *    We must NOT forward this back (it's our own echo). We detect echoes by
 *    checking if the version incremented by exactly 1. If it jumped more,
 *    an external edit interleaved and we need fullSync.
 *
 * The protocol handles files of 100k+ lines by using incremental updates
 * (externalEdit) rather than full content (fullSync) whenever possible.
 * fullSync is only triggered on conflicts or staleness detection.
 *
 * See docs/editor_sync_implementation_plan.md for the full design rationale
 * and editorSync.ts for the pure sync logic implementation.
 * ============================================================================
 */

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

	// Store the original conflicted text for the Compare view and return the
	// URI to pass to `vscode.diff`. The URI is the document URI with the
	// scheme swapped to INITIAL_CONFLICT_SCHEME so the diff tab title still
	// shows the file name, and so the URI's canonical toString() form is
	// stable between store and lookup.
	static setInitialConflictContent(documentUri: Uri, content: string): Uri {
		const conflictUri = documentUri.with({
			scheme: INITIAL_CONFLICT_SCHEME,
		});
		setInitialConflictStoreEntry(conflictUri.toString(), content);
		return conflictUri;
	}

	static async getCurrentConflictStateKey(
		repository: GitApiRepository,
	): Promise<string | undefined> {
		const state = await readConflictState(repository);
		if (!state) {
			return;
		}
		return `${state.operation}:${state.otherRef}`;
	}

	private static _createInitialConflictContentProvider(): TextDocumentContentProvider {
		return {
			provideTextDocumentContent: (uri: Uri) =>
				getInitialConflictContent(uri.toString()),
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
		// Lifetime: the stored content must live as long as the diff document
		// that consumes it. The Compare flow disposes our custom editor
		// immediately after opening the diff, so the diff tab outlives the
		// panel. Free each entry when its own text document is closed.
		const closeSubscription = workspace.onDidCloseTextDocument((doc) => {
			if (doc.uri.scheme === INITIAL_CONFLICT_SCHEME) {
				deleteInitialConflictContent(doc.uri.toString());
			}
		});
		return Disposable.from(
			editorRegistration,
			contentProviderRegistration,
			closeSubscription,
		);
	}

	async resolveCustomTextEditor(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		_token: CancellationToken,
	): Promise<void> {
		if (!isSupportedScheme(document.uri)) {
			webviewPanel.webview.html = `<p>Cannot open: unsupported URI scheme "${document.uri.scheme}".</p>`;
			return;
		}

		const repoContext = await resolveRepoContext(document.uri);
		if (!repoContext) {
			webviewPanel.webview.html =
				"<p>Cannot open: file is not in a git repository.</p>";
			return;
		}

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [Uri.joinPath(this.extensionUri, "out")],
		};

		// Listener attached BEFORE setting html so "ready" is never missed
		// regardless of how fast the webview boots (especially over SSH).
		this._initializeWebview(document, webviewPanel, repoContext);
	}

	private _initializeWebview(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		repoContext: RepoContext,
	): void {
		const config = this._getWebviewConfig();

		// Phase 1 (before webview is ready): Setup per-editor sync state.
		// See editorSync.ts for detailed documentation of each field.
		// Key points:
		// - editQueue serializes all document mutations (edits + saves)
		// - lastExternalChangeVersion tracks when external changes occurred
		// - versionBeforeEdit enables echo suppression during applyEdit()
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
							repoContext,
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
					repoContext,
					editState,
				});
			},
		);
		disposables.push(messageListener);

		webviewPanel.onDidDispose(() => {
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
			repoContext: RepoContext;
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
				repoContext: ctx.repoContext,
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
			repoContext: RepoContext;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
	): Promise<WebviewPayload["data"] | null> {
		const docText = ctx.document.getText();
		const stages = await fetchConflictStages(
			ctx.repoContext.repository,
			ctx.repoContext.relativePath,
		);

		// TODO: consolidate this duplicate block with the rest below
		if (ctx.document.isDirty) {
			// Already dirty on init: likely a hot exit restore or the user just
			// edited this file in another tab. Either way, they have unsaved
			// changes they expect to keep. Skip the prompt and the auto-merge
			// overwrite.
			return this._snapshotFromCurrentDocument(
				ctx,
				config,
				stages,
				docText,
			);
		}

		// If the file is un-changed since the merge conflict was first created
		// we run auto-merge. We can only verify this by re-running git
		// merge-file -p. To get an identical result we need to know the labels
		// git uses for local/base/remote or write a diff to ignore them. Rather
		// than filter out labels when diffing, we extract them from existing
		// conflict markers. This is safer in case a user commits conflict
		// markers. It serves a double purpose in that if conflict markers are
		// missing, the user has most likely made changes already and we
		// silently load the current file state instead.
		const labels = extractConflictLabels(docText);
		if (!labels) {
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

	private _tryBuildInitialConflictText(
		ctx: {
			repoContext: RepoContext;
		},
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
		labels: ConflictLabels,
	): Promise<string> {
		return buildInitialConflictedState(
			ctx.repoContext.rootFsPath,
			stages,
			labels,
		);
	}

	private async _snapshotFromCurrentDocument(
		ctx: {
			repoContext: RepoContext;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
		docText: string,
	): Promise<WebviewPayload["data"]> {
		// Keep path: never rewrite the buffer; render and diff exactly what exists.
		const snapshot = await buildDiffPayload(
			ctx.repoContext,
			ctx.repoContext.relativePath,
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
			repoContext: RepoContext;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
	): Promise<WebviewPayload["data"]> {
		// Replace path: compute merged middle content, then apply it in-memory only.
		const snapshot = await buildDiffPayload(
			ctx.repoContext,
			ctx.repoContext.relativePath,
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
			repoContext: RepoContext;
			editState: EditState;
		},
	): Promise<void> {
		switch (msg.command) {
			case "ready":
				// Handled in the outer listener closure.
				break;
			case "contentChanged": {
				// Chain onto editQueue to serialize with other edits and saves.
				// The .then() callback is crucial: it ensures:
				// 1. Previous edits complete before this one starts
				// 2. ctx.document.version is read at EXECUTION time (after queue drains),
				//    not at CALL time (when message arrives). This matters because if
				//    multiple messages queue up, each needs the version AFTER the
				//    previous edit applied, not the version when the message arrived.
				ctx.editState.editQueue = ctx.editState.editQueue.then(() =>
					processContentChanged({
						changes: msg.changes,
						msgVersion: msg.lastExternalChangeVersion,
						editState: ctx.editState,
						// Read document.version HERE, inside the callback, so it reflects
						// any edits that completed earlier in the queue.
						currentDocumentVersion: ctx.document.version,
						applyEdit: async (changes) => {
							// Convert Monaco 1-based ranges to VS Code 0-based ranges.
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
							// This fires onDidChangeTextDocument during the await.
							// classifyDocumentChange will suppress it as our echo.
							await workspace.applyEdit(edit);
						},
						postFullSync: () => {
							// Called when the webview's message was stale (based on
							// outdated content). Send full document to resync.
							ctx.webviewPanel.webview.postMessage({
								command: "fullSync",
								content: ctx.document.getText(),
								lastExternalChangeVersion:
									ctx.editState.lastExternalChangeVersion,
							});
						},
					}),
				);
				break;
			}
			case "save":
				// Save goes through the same queue as edits. This ensures:
				// - Pending edits complete before save writes to disk
				// - User typing "abc" then Ctrl+S saves "abc", not partial content
				// The webview intercepts Ctrl+S and sends this message, ensuring
				// save is ordered with edits in the same FIFO channel.
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

	/**
	 * Sets up per-editor event listeners. Called from the "ready" message handler.
	 *
	 * IMPORTANT: This is Phase 2 of the bootstrap protocol. The sequence matters:
	 *
	 * Phase 1 (_initializeWebview, before webview ready):
	 * - Create editState with initial lastExternalChangeVersion
	 * - Apply initial auto-merge edit if needed (no listener yet, so echo is ignored)
	 *
	 * Phase 2 (this function, after webview sends "ready"):
	 * - Set up onDidChangeTextDocument listener
	 * - Read document.getText() for initial content
	 * - Record lastExternalChangeVersion = document.version
	 * - Send loadDiff to webview
	 *
	 * Why this order? The listener must be set up BEFORE we read the document content,
	 * and both must happen synchronously (no await between them). Otherwise:
	 * - If we read content, then await something, then set up listener: we might
	 *   miss changes that happened during the await.
	 * - If we set up listener, then await, then read: we might get stale content
	 *   that doesn't match what the listener will track.
	 *
	 * By doing everything synchronously, the content we send to the webview is
	 * guaranteed to match exactly what the listener will track going forward.
	 */
	private _setupPerEditorListeners(ctx: {
		document: TextDocument;
		webviewPanel: WebviewPanel;
		repoContext: RepoContext;
		readyState: {
			snapshot: WebviewPayload["data"] | null;
			handled: boolean;
			handling: boolean;
		};
		editState: EditState;
		disposables: Disposable[];
	}): void {
		// All of this is synchronous — no await, no other code can interleave.
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
						repoContext: ctx.repoContext,
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

		const conflictStateSubscription =
			MeldCustomEditorProvider.onConflictStateChanged.event(
				async (event) => {
					if (event.repoPath !== ctx.repoContext.rootFsPath) {
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
							repoContext: ctx.repoContext,
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

	/**
	 * Handles VS Code's onDidChangeTextDocument event for our tracked document.
	 *
	 * This is the core of extension→webview sync. Every document change flows
	 * through here, whether it's our own edit echo or an external change.
	 *
	 * The key insight: we must distinguish our own echoes from external edits.
	 * - Our echo: The webview sent an edit, we applied it, VS Code fired this event.
	 *   The webview already has this content — forwarding would cause cursor jumps.
	 * - External edit: Another extension, split editor, Find & Replace, etc.
	 *   The webview must receive this to stay in sync.
	 *
	 * We use versionBeforeEdit + version increment check (see classifyDocumentChange).
	 */
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
			// Our own echo from applyEdit(). The webview already has this change
			// (it sent it to us), so we must NOT forward it back.
			// Also: do NOT update lastExternalChangeVersion. Multiple webview edits
			// can be in-flight, all with the same lastExternalChangeVersion. Updating
			// here would make subsequent in-flight edits appear "stale".
			return;
		}

		// External change (or interleaved during our edit). Update the version
		// marker so we can detect stale webview messages going forward.
		ctx.editState.lastExternalChangeVersion = e.document.version;

		if (action === "fullSync") {
			// An external edit interleaved with our applyEdit(). We can't send
			// incremental changes because we don't know what the webview has.
			// Send full content to resync safely.
			ctx.webviewPanel.webview.postMessage({
				command: "fullSync",
				content: ctx.document.getText(),
				lastExternalChangeVersion:
					ctx.editState.lastExternalChangeVersion,
			});
			return;
		}

		// Pure external edit (we weren't mid-applyEdit). Send incremental changes.
		// For large files, this is much cheaper than fullSync.
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
			repoContext: RepoContext;
			webviewPanel: WebviewPanel;
		},
		msg: RequestBaseDiffMessage,
	) {
		const basePayload = (await buildBaseDiffPayload(
			ctx.repoContext,
			ctx.repoContext.relativePath,
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
		if (!isSupportedScheme(document.uri)) {
			window.showErrorMessage(
				`Cannot open diff: unsupported URI scheme "${document.uri.scheme}".`,
			);
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
