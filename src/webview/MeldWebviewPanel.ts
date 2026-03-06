// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import * as path from "node:path";
import * as vscode from "vscode";

import { buildBaseDiffPayload, buildDiffPayload } from "./diffPayload";
import type { BaseDiffPayload, DiffChunk, FileState } from "./ui/types";

/**
 * Custom text editor provider for the Meld 3-way merge view.
 *
 * Using CustomTextEditorProvider (vs the old createWebviewPanel approach) means
 * VS Code manages the document lifecycle for us:
 *   - Dirty dot appears automatically when WorkspaceEdits are applied
 *   - Ctrl+S / ⌘S triggers saveCustomDocument natively
 *   - "File modified on disk" conflict dialogs appear on external changes
 *   - Opening the same file in a normal text editor syncs rather than conflicts
 */
export class MeldCustomEditorProvider
	implements vscode.CustomTextEditorProvider
{
	public static readonly viewType = "meld.mergeEditor";
	public static readonly onRequestRefresh =
		new vscode.EventEmitter<vscode.Uri>();

	constructor(private readonly extensionUri: vscode.Uri) {}

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MeldCustomEditorProvider(context.extensionUri);
		return vscode.window.registerCustomEditorProvider(
			MeldCustomEditorProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
			},
		);
	}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			webviewPanel.webview.html = "<p>File is not in a workspace.</p>";
			return;
		}

		const repoPath = workspaceFolder.uri.fsPath;
		const relativeFilePath = path
			.relative(repoPath, document.uri.fsPath)
			.replace(/\\/g, "/");

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")],
		};
		webviewPanel.webview.html = this._getHtmlForWebview(webviewPanel.webview);

		// Load git stages and send the diff payload once the webview is ready.
		await this._initializeWebview(
			document,
			webviewPanel,
			repoPath,
			relativeFilePath,
		);
	}

	private async _initializeWebview(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		repoPath: string,
		relativeFilePath: string,
	): Promise<void> {
		const config = vscode.workspace.getConfiguration("meld");
		const debounceDelay =
			config.get<number>("mergeEditor.debounceDelay") ?? 300;
		const syntaxHighlighting =
			config.get<boolean>("mergeEditor.syntaxHighlighting") ?? true;
		const baseCompareHighlighting =
			config.get<boolean>("mergeEditor.baseCompareHighlighting") ?? false;
		const smoothScrolling =
			config.get<boolean>("mergeEditor.smoothScrolling") ?? true;

		const payload = (await buildDiffPayload(repoPath, relativeFilePath)) as {
			command: string;
			data: {
				files: FileState[];
				diffs: DiffChunk[][];
				config?: {
					debounceDelay: number;
					syntaxHighlighting: boolean;
					baseCompareHighlighting: boolean;
					smoothScrolling: boolean;
				};
			};
		};
		// Add configuration to the payload data
		payload.data.config = {
			debounceDelay,
			syntaxHighlighting,
			baseCompareHighlighting,
			smoothScrolling,
		};
		let isUpdatingFromWebview = false;

		const messageListener = webviewPanel.webview.onDidReceiveMessage(
			async (msg) => {
				switch (msg.command) {
					case "ready":
						webviewPanel.webview.postMessage(payload);
						break;

					case "contentChanged": {
						// Apply the edit to the underlying TextDocument so VS Code
						// tracks dirty state and handles Ctrl+S natively.
						const newText: string = msg.text;
						isUpdatingFromWebview = true;
						try {
							const fullRange = new vscode.Range(
								document.positionAt(0),
								document.positionAt(document.getText().length),
							);
							const edit = new vscode.WorkspaceEdit();
							edit.replace(document.uri, fullRange, newText);
							await vscode.workspace.applyEdit(edit);
						} finally {
							isUpdatingFromWebview = false;
						}
						break;
					}

					case "copyHash":
						await vscode.env.clipboard.writeText(msg.hash);
						vscode.window.showInformationMessage(`Copied hash: ${msg.hash}`);
						break;

					case "readClipboard": {
						// navigator.clipboard.readText() is blocked in webview sandbox.
						// The webview posts this message; we resolve it via the extension host.
						const text = await vscode.env.clipboard.readText();
						webviewPanel.webview.postMessage({
							command: "clipboardText",
							requestId: msg.requestId,
							text,
						});
						break;
					}

					case "writeClipboard": {
						await vscode.env.clipboard.writeText(msg.text);
						break;
					}

					case "showDiff": {
						const gitExt = vscode.extensions.getExtension("vscode.git");
						if (gitExt) {
							if (!gitExt.isActive) {
								await gitExt.activate();
							}
							const gitApi = gitExt.exports.getAPI(1);
							// msg.paneIndex === 0 is Local (Stage 2)
							// msg.paneIndex === 2 is Incoming (Stage 3)
							// Stage 1 is Base
							// TODO: with 5-way merge this doesn't work. also,
							// gemini, seriously, stop using magic nubmers and
							// raw indices
							const baseUri = gitApi.toGitUri(document.uri, ":1");
							const targetUri = gitApi.toGitUri(
								document.uri,
								msg.paneIndex === 0 || msg.paneIndex === 1 ? ":2" : ":3",
							);
							const label = `${path.basename(document.uri.fsPath)} (Base ↔ ${msg.paneIndex === 0 || msg.paneIndex === 1 ? "Local" : "Remote"})`;
							try {
								await vscode.commands.executeCommand(
									"vscode.diff",
									baseUri,
									targetUri,
									label,
								);
							} catch (e) {
								const err = e instanceof Error ? e.message : String(e);
								vscode.window.showErrorMessage(`Failed to open diff: ${err}`);
							}
						} else {
							vscode.window.showErrorMessage("Git extension is not available.");
						}
						break;
					}

					case "requestBaseDiff": {
						const basePayload = (await buildBaseDiffPayload(
							repoPath,
							relativeFilePath,
							msg.side,
						)) as {
							command: string;
							data: BaseDiffPayload;
						};
						webviewPanel.webview.postMessage(basePayload);
						break;
					}

					case "completeMerge":
						await document.save();
						vscode.commands.executeCommand("meld-auto-merge.smartAdd", {
							uri: document.uri,
						});
						webviewPanel.dispose();
						break;
				}
			},
		);

		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
			(e) => {
				if (e.document.uri.toString() === document.uri.toString()) {
					// If WE caused this change via applyEdit, ignore it to prevent an infinite feedback loop.
					if (isUpdatingFromWebview) {
						return;
					}

					// The change came from outside our webview (e.g. user typing in the regular text editor tab).
					// Push the change to the webview.
					webviewPanel.webview.postMessage({
						command: "updateContent",
						text: e.document.getText(),
					});
				}
			},
		);

		const changeConfigurationSubscription =
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("meld.mergeEditor.debounceDelay") ||
					e.affectsConfiguration("meld.mergeEditor.syntaxHighlighting") ||
					e.affectsConfiguration("meld.mergeEditor.baseCompareHighlighting") ||
					e.affectsConfiguration("meld.mergeEditor.smoothScrolling")
				) {
					const newConfig = vscode.workspace.getConfiguration("meld");
					const newDelay =
						newConfig.get<number>("mergeEditor.debounceDelay") ?? 300;
					const newSyntaxHighlighting =
						newConfig.get<boolean>("mergeEditor.syntaxHighlighting") ?? true;
					const newBaseCompareHighlighting =
						newConfig.get<boolean>("mergeEditor.baseCompareHighlighting") ??
						false;
					const newSmoothScrolling =
						newConfig.get<boolean>("mergeEditor.smoothScrolling") ?? true;
					webviewPanel.webview.postMessage({
						command: "updateConfig",
						config: {
							debounceDelay: newDelay,
							syntaxHighlighting: newSyntaxHighlighting,
							baseCompareHighlighting: newBaseCompareHighlighting,
							smoothScrolling: newSmoothScrolling,
						},
					});
				}
			});

		const refreshSubscription = MeldCustomEditorProvider.onRequestRefresh.event(
			async (uri) => {
				if (uri.toString() === document.uri.toString()) {
					const newPayload = (await buildDiffPayload(
						repoPath,
						relativeFilePath,
					)) as {
						command: string;
						data: {
							files: FileState[];
							diffs: DiffChunk[][];
							config?: {
								debounceDelay: number;
								syntaxHighlighting: boolean;
								baseCompareHighlighting: boolean;
								smoothScrolling: boolean;
							};
						};
					};
					newPayload.data.config = {
						debounceDelay,
						syntaxHighlighting,
						baseCompareHighlighting,
						smoothScrolling,
					};
					webviewPanel.webview.postMessage(newPayload);
				}
			},
		);

		webviewPanel.onDidDispose(() => {
			messageListener.dispose();
			changeDocumentSubscription.dispose();
			changeConfigurationSubscription.dispose();
			refreshSubscription.dispose();
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "out", "webview", "index.js"),
		);
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "out", "webview", "index.css"),
		);

		return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Meld Diff</title>
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
