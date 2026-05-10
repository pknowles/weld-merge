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
import {
	describeConflictStatusEvidence,
	getUnresolvedReasons,
	readConflictState,
} from "../gitUtils.ts";
import { getWeldLogChannel } from "../log.ts";
import {
	type ConflictedItem,
	conflictedItemFromUri,
	GIT_STAGE_LOCAL,
	type GitApiRepository,
	type GitConflictStage,
	getGitApi,
	isSupportedScheme,
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

interface ConflictStateChangeEvent {
	repoUri: Uri;
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

	private static _formatWebviewException(
		error: unknown,
		command: WebviewMessage["command"],
	): { title: string; message: string; details?: string | undefined } {
		const title =
			command === "ready"
				? "Error: exception during ready callback"
				: `Error: exception while handling '${command}'`;
		if (error instanceof Error) {
			const message =
				error.name === "Error"
					? error.message
					: `${error.name}: ${error.message}`;
			return {
				title,
				message,
				details: error.stack,
			};
		}
		return {
			title,
			message: String(error),
		};
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

		const repoContext = await conflictedItemFromUri(document.uri);
		if (!repoContext) {
			webviewPanel.webview.html =
				"<p>Cannot open: file is not in a git repository.</p>";
			return;
		}

		const conflictStatus = await repoContext.conflictStatus();
		if (conflictStatus.kind === "bothDeleted") {
			const diagnostic =
				await describeConflictStatusEvidence(repoContext);
			getWeldLogChannel().error(diagnostic);
			const choice = await window.showErrorMessage(
				`Unexpected conflict state for ${document.uri.fsPath}: both sides deleted this file. Git should have auto-resolved this. See the Weld output channel for status diagnostics.`,
				"Show Weld Output",
			);
			if (choice === "Show Weld Output") {
				getWeldLogChannel().show();
			}
			webviewPanel.webview.html =
				"<p>Unexpected conflict state: both sides deleted this file.</p>";
			return;
		}

		if (conflictStatus.kind === "deleteModify") {
			webviewPanel.webview.html =
				"<p>Delete/modify conflict. Use the prompt above to resolve.</p>";
			MeldCustomEditorProvider.handleDeleteModifyConflict(
				repoContext,
				conflictStatus.remainingStage,
			).catch((error: unknown) => {
				throw error;
			});
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

	static async handleDeleteModifyConflict(
		repoContext: ConflictedItem,
		remainingStage: GitConflictStage,
	): Promise<void> {
		const { uri, repository } = repoContext;
		const remainingLabel =
			remainingStage === GIT_STAGE_LOCAL ? "Local" : "Remote";
		const deletedLabel =
			remainingStage === GIT_STAGE_LOCAL ? "Remote" : "Local";
		const gitApi = getGitApi();
		const baseUri = gitApi.toGitUri(uri, ":1");
		const remainingUri = gitApi.toGitUri(uri, `:${remainingStage}`);
		const diffTitle = `${basename(uri.fsPath)} (Base ↔ ${remainingLabel})`;
		const choice = await window.showWarningMessage(
			`Delete/modify conflict: ${deletedLabel} deleted "${basename(uri.fsPath)}" but ${remainingLabel} modified it.`,
			{ modal: true },
			"Keep File",
			"Delete File",
			"Compare",
		);
		if (choice === "Compare") {
			try {
				await commands.executeCommand(
					"vscode.diff",
					baseUri,
					remainingUri,
					diffTitle,
				);
			} catch (e) {
				const err = e instanceof Error ? e.message : String(e);
				window.showErrorMessage(`Failed to open diff: ${err}`);
			}
			return;
		}
		if (choice === "Keep File") {
			await repository.add([uri.fsPath]);
		} else if (choice === "Delete File") {
			await workspace.fs.delete(uri);
			await repository.add([uri.fsPath]);
		}
	}

	private _initializeWebview(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		repoContext: ConflictedItem,
	): void {
		const config = this._getWebviewConfig();
		const stagesPromise = fetchConflictStages(repoContext).catch(
			(): Awaited<ReturnType<typeof fetchConflictStages>> => ({
				// When an 3-view editor tab is restored on next launch and there is
				// no conflict, we don't have the original merge context to show. We
				// choose to initialize the views as empty and keep the editor open
				// to remind the user what they were doing last and let them close
				// it manually.
				base: "",
				local: "",
				incoming: "",
			}),
		);

		// Per-editor sync state shared by all callbacks for this panel.
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
				try {
					if (msg.command === "ready") {
						await this._handleReadyMessage(
							readyState,
							{
								document,
								webviewPanel,
								repoContext,
								editState,
								disposables,
								stagesPromise,
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
				} catch (error) {
					await webviewPanel.webview.postMessage({
						command: "error",
						...MeldCustomEditorProvider._formatWebviewException(
							error,
							msg.command,
						),
					});
				}
			},
		);
		disposables.push(messageListener);
		this._maybeApplyAutoMerge(
			{
				document,
				repoContext,
			},
			stagesPromise,
		).catch((error: unknown) => {
			throw error;
		});

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
			repoContext: ConflictedItem;
			editState: EditState;
			disposables: Disposable[];
			stagesPromise: ReturnType<typeof fetchConflictStages>;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
	): Promise<void> {
		assertReadyMessageIsFirst(readyState, ctx.document.uri.toString());

		readyState.handling = true;
		try {
			const [stages, initialStateKey] = await Promise.all([
				ctx.stagesPromise,
				MeldCustomEditorProvider.getCurrentConflictStateKey(
					ctx.repoContext.repository,
				),
			]);
			const snapshot = await this._buildSnapshotFromCurrentDocument(
				{
					document: ctx.document,
					repoContext: ctx.repoContext,
				},
				config,
				stages,
			);
			readyState.snapshot = snapshot;
			readyState.handled = true;
			// Listener setup and the first loadDiff post run synchronously so the
			// webview content and tracked version boundary start in lockstep.
			this._setupPerEditorListeners(
				{
					document: ctx.document,
					webviewPanel: ctx.webviewPanel,
					repoContext: ctx.repoContext,
					readyState,
					editState: ctx.editState,
					disposables: ctx.disposables,
				},
				initialStateKey,
			);
		} finally {
			readyState.handling = false;
		}
	}

	private async _replaceDocumentContent(
		document: TextDocument,
		content: string | undefined,
	): Promise<void> {
		const docText = document.getText();
		if (content === undefined || content === docText) {
			return;
		}

		const edit = new WorkspaceEdit();
		const fullRange = new Range(
			document.positionAt(0),
			document.positionAt(docText.length),
		);
		edit.replace(document.uri, fullRange, content);
		await workspace.applyEdit(edit);
	}

	private async _buildSnapshotFromCurrentDocument(
		ctx: {
			document: TextDocument;
			repoContext: ConflictedItem;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
	): Promise<WebviewPayload["data"]> {
		const docText = ctx.document.getText();
		// Build the 3-pane payload against the exact working text currently in
		// the VS Code buffer; no document mutation is performed here.
		const snapshot = await buildDiffPayload(ctx.repoContext, {
			stages,
			workingContent: docText,
		});
		snapshot.config = config;
		return snapshot;
	}

	private _tryBuildInitialConflictText(
		ctx: {
			repoContext: ConflictedItem;
		},
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
		labels: ConflictLabels,
	): Promise<string> {
		return buildInitialConflictedState(
			ctx.repoContext.rootUri,
			stages,
			labels,
		);
	}

	private async _buildAutoMergedContent(
		ctx: {
			repoContext: ConflictedItem;
		},
		stages: Awaited<ReturnType<typeof fetchConflictStages>>,
	): Promise<string | undefined> {
		const snapshot = await buildDiffPayload(ctx.repoContext, {
			stages,
		});
		return snapshot.files[1]?.content;
	}

	/**
	 * Decides whether to apply auto-merge and, if so, replaces the document content.
	 *
	 * Auto-merge detection: We only auto-merge if the file matches what the user's
	 * current Git config recreates from the conflict stages. An exact match means
	 * the conflicted text is trivial to reproduce with Git, so it is safe to
	 * replace with our auto-merged buffer. A mismatch means either the user edited
	 * the file or their Git config changed; in both cases, preserve the file and
	 * ask before replacing it.
	 *
	 * We still extract labels from the document's conflict markers because Git
	 * does not persist the human-readable labels elsewhere, and those labels must
	 * match for the byte-for-byte comparison to be meaningful. If conflict markers
	 * are missing, the user has already resolved/edited the file manually.
	 *
	 * This runs concurrently with the "ready" handshake. The workspace.applyEdit
	 * it performs (if any) is handled correctly regardless of timing — see the
	 * docstring on _setupPerEditorListeners for the two interleavings.
	 */
	private async _maybeApplyAutoMerge(
		ctx: {
			document: TextDocument;
			repoContext: ConflictedItem;
		},
		stagesPromise: ReturnType<typeof fetchConflictStages>,
	): Promise<void> {
		const stages = await stagesPromise;
		const docText = ctx.document.getText();
		if (ctx.document.isDirty) {
			// Already dirty: likely a hot exit restore or the user edited in another
			// tab. They have unsaved changes they expect to keep — skip auto-merge.
			return;
		}

		// Extract conflict marker labels to verify the file is unchanged. If labels
		// are missing, the user has already resolved/edited the file manually.
		const labels = extractConflictLabels(docText);
		if (!labels) {
			return;
		}

		const initialGitState = await this._tryBuildInitialConflictText(
			{ repoContext: ctx.repoContext },
			stages,
			labels,
		);
		if (docText === initialGitState) {
			await this._replaceDocumentContent(
				ctx.document,
				await this._buildAutoMergedContent(
					{ repoContext: ctx.repoContext },
					stages,
				),
			);
			return;
		}

		const modAction = await this._checkAndPromptModification(
			ctx.document,
			initialGitState,
		);
		if (modAction !== "replace") {
			return;
		}
		await this._replaceDocumentContent(
			ctx.document,
			await this._buildAutoMergedContent(
				{ repoContext: ctx.repoContext },
				stages,
			),
		);
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
			syntaxHighlighting:
				config.get<boolean>("mergeEditor.syntaxHighlighting") ?? true,
			baseCompareHighlighting:
				config.get<boolean>("mergeEditor.baseCompareHighlighting") ??
				true,
			smoothScrolling:
				config.get<boolean>("mergeEditor.smoothScrolling") ?? true,
		};
	}

	private async _handleMessage(
		msg: WebviewMessage,
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			repoContext: ConflictedItem;
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
	 * Sets up per-editor event listeners and sends the initial loadDiff.
	 * Called from the "ready" message handler after awaiting async setup work.
	 *
	 * IMPORTANT: The listener registration and loadDiff post must be synchronous.
	 *
	 * Why this order matters:
	 * - The onDidChangeTextDocument listener must be set up BEFORE we read the
	 *   document content for loadDiff, and both must happen with no await between.
	 * - If we read content, then await, then set up listener: we might miss
	 *   changes that happened during the await.
	 * - If we set up listener, then await, then read: we might get stale content
	 *   that doesn't match what the listener will track.
	 *
	 * By doing everything synchronously, the content we send to the webview is
	 * guaranteed to match exactly what the listener will track going forward.
	 *
	 * Note: maybeApplyAutoMerge runs concurrently from _initializeWebview. Its
	 * workspace.applyEdit can resolve before or after this function runs:
	 * - Before "ready": no listener yet, so no externalEdit sent. The loadDiff
	 *   we post here reads document.getText() which already has merged content.
	 * - After "ready": the listener catches the change and posts externalEdit.
	 * Both interleavings are correct; the webview ends up with merged content.
	 */
	private _setupPerEditorListeners(
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			repoContext: ConflictedItem;
			readyState: {
				snapshot: WebviewPayload["data"] | null;
				handled: boolean;
				handling: boolean;
			};
			editState: EditState;
			disposables: Disposable[];
		},
		initialStateKey: string | undefined,
	): void {
		// All of this is synchronous — no await, no other code can interleave.
		// This guarantees the content we send matches exactly what the listener tracks.

		// Track the conflict stateKey so we only reload when it actually changes.
		// Without this, any git working-tree change (e.g. saving .vscode/settings.json)
		// would fire onConflictStateChanged and reset the base-compare panes.
		let lastStateKey: string | undefined = initialStateKey;

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
				await this._reloadSnapshotAndMaybeAutoMerge(
					{
						document: ctx.document,
						webviewPanel: ctx.webviewPanel,
						repoContext: ctx.repoContext,
						editState: ctx.editState,
						readyState: ctx.readyState,
					},
					this._getWebviewConfig(),
				);
			});

		const conflictStateSubscription =
			MeldCustomEditorProvider.onConflictStateChanged.event(
				async (event) => {
					if (
						event.repoUri.toString() !==
						ctx.repoContext.rootUri.toString()
					) {
						return;
					}
					if (event.stateKey === undefined) {
						lastStateKey = undefined;
						ctx.webviewPanel.webview.postMessage({
							command: "conflictStateLost",
						});
						return;
					}
					// Only reload when the conflict state actually changes (e.g. a
					// new MERGE_HEAD or operation type). Spurious git state notifications
					// from unrelated working-tree writes (e.g. .vscode/settings.json)
					// must not reset the base-compare panes.
					if (event.stateKey === lastStateKey) {
						return;
					}
					lastStateKey = event.stateKey;
					await this._reloadSnapshotAndMaybeAutoMerge(
						{
							document: ctx.document,
							webviewPanel: ctx.webviewPanel,
							repoContext: ctx.repoContext,
							editState: ctx.editState,
							readyState: ctx.readyState,
						},
						this._getWebviewConfig(),
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

	private async _reloadSnapshotAndMaybeAutoMerge(
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			repoContext: ConflictedItem;
			editState: EditState;
			readyState: ReadyState;
		},
		config: ReturnType<MeldCustomEditorProvider["_getWebviewConfig"]>,
	): Promise<void> {
		const stages = await fetchConflictStages(ctx.repoContext);
		const snapshot = await this._buildSnapshotFromCurrentDocument(
			{
				document: ctx.document,
				repoContext: ctx.repoContext,
			},
			config,
			stages,
		);
		ctx.readyState.snapshot = snapshot;
		this._postCurrentLoadDiff(
			snapshot,
			ctx.document,
			ctx.webviewPanel,
			ctx.editState,
		);
		this._maybeApplyAutoMerge(
			{
				document: ctx.document,
				repoContext: ctx.repoContext,
			},
			Promise.resolve(stages),
		).catch((error: unknown) => {
			throw error;
		});
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
			repoContext: ConflictedItem;
			webviewPanel: WebviewPanel;
		},
		msg: RequestBaseDiffMessage,
	) {
		const basePayload = (await buildBaseDiffPayload(
			ctx.repoContext,
			ctx.repoContext.uri,
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
		const gitApi = getGitApi();
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
