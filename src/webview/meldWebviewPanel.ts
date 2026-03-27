// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { basename, relative } from "node:path";
import {
	type CancellationToken,
	type ConfigurationChangeEvent,
	type CustomTextEditorProvider,
	commands,
	type Disposable,
	EventEmitter,
	type ExtensionContext,
	env,
	extensions,
	Range,
	type TextDocument,
	Uri,
	type Webview,
	type WebviewPanel,
	WorkspaceEdit,
	window,
	workspace,
} from "vscode";
import { getUnresolvedReasons } from "../gitUtils.ts";
import { buildBaseDiffPayload, buildDiffPayload } from "./diffPayload.ts";
import type { BaseDiffPayload, WebviewPayload } from "./ui/types.ts";

const DEFAULT_DEBOUNCE_DELAY = 300;

interface ContentChangedMessage {
	command: "contentChanged";
	text: string;
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
	| CompleteMergeMessage;

/**
 * Custom text editor provider for the Weld 3-way merge view.
 */
export class MeldCustomEditorProvider implements CustomTextEditorProvider {
	static readonly viewType = "weld.mergeEditor";
	static readonly onRequestRefresh = new EventEmitter<Uri>();

	private readonly extensionUri: Uri;

	constructor(extensionUri: Uri) {
		this.extensionUri = extensionUri;
	}

	static register(context: ExtensionContext): Disposable {
		const provider = new MeldCustomEditorProvider(context.extensionUri);
		return window.registerCustomEditorProvider(
			MeldCustomEditorProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
			},
		);
	}

	async resolveCustomTextEditor(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		_token: CancellationToken,
	): Promise<void> {
		const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			webviewPanel.webview.html = "<p>File is not in a workspace.</p>";
			return;
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
		webviewPanel.webview.html = this._getHtmlForWebview(
			webviewPanel.webview,
		);

		await this._initializeWebview(
			document,
			webviewPanel,
			repoPath,
			relativeFilePath,
		);
	}

	private async _initializeWebview(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		repoPath: string,
		relativeFilePath: string,
	): Promise<void> {
		const config = workspace.getConfiguration("weld");
		const debounceDelay =
			config.get<number>("mergeEditor.debounceDelay") ??
			DEFAULT_DEBOUNCE_DELAY;
		const syntaxHighlighting =
			config.get<boolean>("mergeEditor.syntaxHighlighting") ?? true;
		const baseCompareHighlighting =
			config.get<boolean>("mergeEditor.baseCompareHighlighting") ?? false;
		const smoothScrolling =
			config.get<boolean>("mergeEditor.smoothScrolling") ?? true;

		const payload = (await buildDiffPayload(
			repoPath,
			relativeFilePath,
		)) as WebviewPayload;

		payload.data.config = {
			debounceDelay,
			syntaxHighlighting,
			baseCompareHighlighting,
			smoothScrolling,
		};

		let isUpdatingFromWebview = false;

		const messageListener = webviewPanel.webview.onDidReceiveMessage(
			async (msg: WebviewMessage) => {
				await this._handleMessage(msg, {
					document,
					webviewPanel,
					repoPath,
					relativeFilePath,
					payload,
					updateState: (val) => {
						isUpdatingFromWebview = val;
					},
				});
			},
		);

		this._setupSubscriptions(document, webviewPanel, {
			messageListener,
			isUpdatingFromWebview: () => isUpdatingFromWebview,
			repoPath,
			relativeFilePath,
			debounceDelay,
			syntaxHighlighting,
			baseCompareHighlighting,
			smoothScrolling,
		});
	}

	private _setupSubscriptions(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		ctx: {
			messageListener: Disposable;
			isUpdatingFromWebview: () => boolean;
			repoPath: string;
			relativeFilePath: string;
			debounceDelay: number;
			syntaxHighlighting: boolean;
			baseCompareHighlighting: boolean;
			smoothScrolling: boolean;
		},
	) {
		const changeDocumentSubscription = workspace.onDidChangeTextDocument(
			(e) => {
				if (
					e.document.uri.toString() === document.uri.toString() &&
					!ctx.isUpdatingFromWebview()
				) {
					webviewPanel.webview.postMessage({
						command: "updateContent",
						text: e.document.getText(),
					});
				}
			},
		);

		const changeConfigurationSubscription =
			workspace.onDidChangeConfiguration((e) => {
				this._handleConfigChange(e, webviewPanel);
			});

		const refreshSubscription =
			MeldCustomEditorProvider.onRequestRefresh.event(async (uri) => {
				if (uri.toString() === document.uri.toString()) {
					const newPayload = (await buildDiffPayload(
						ctx.repoPath,
						ctx.relativeFilePath,
					)) as WebviewPayload;
					newPayload.data.config = {
						debounceDelay: ctx.debounceDelay,
						syntaxHighlighting: ctx.syntaxHighlighting,
						baseCompareHighlighting: ctx.baseCompareHighlighting,
						smoothScrolling: ctx.smoothScrolling,
					};
					webviewPanel.webview.postMessage(newPayload);
				}
			});

		webviewPanel.onDidDispose(() => {
			ctx.messageListener.dispose();
			changeDocumentSubscription.dispose();
			changeConfigurationSubscription.dispose();
			refreshSubscription.dispose();
		});
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
			const newConfig = workspace.getConfiguration("weld");
			const config = {
				debounceDelay:
					newConfig.get<number>("mergeEditor.debounceDelay") ??
					DEFAULT_DEBOUNCE_DELAY,
				syntaxHighlighting:
					newConfig.get<boolean>("mergeEditor.syntaxHighlighting") ??
					true,
				baseCompareHighlighting:
					newConfig.get<boolean>(
						"mergeEditor.baseCompareHighlighting",
					) ?? false,
				smoothScrolling:
					newConfig.get<boolean>("mergeEditor.smoothScrolling") ??
					true,
			};
			webviewPanel.webview.postMessage({
				command: "updateConfig",
				config,
			});
		}
	}

	private async _handleMessage(
		msg: WebviewMessage,
		ctx: {
			document: TextDocument;
			webviewPanel: WebviewPanel;
			repoPath: string;
			relativeFilePath: string;
			payload: WebviewPayload;
			updateState: (val: boolean) => void;
		},
	): Promise<void> {
		switch (msg.command) {
			case "ready":
				ctx.webviewPanel.webview.postMessage(ctx.payload);
				break;
			case "contentChanged":
				await this._applyContentEdit(
					ctx.document,
					msg.text,
					ctx.updateState,
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

	private async _applyContentEdit(
		document: TextDocument,
		text: string,
		updateState: (val: boolean) => void,
	) {
		updateState(true);
		try {
			const fullRange = new Range(
				document.positionAt(0),
				document.positionAt(document.getText().length),
			);
			const edit = new WorkspaceEdit();
			edit.replace(document.uri, fullRange, text);
			await workspace.applyEdit(edit);
		} finally {
			updateState(false);
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
