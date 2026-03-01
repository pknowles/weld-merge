import * as path from "node:path";
import * as vscode from "vscode";

import { buildDiffPayload } from "./diffPayload";
import type { DiffChunk, FileState } from "./ui/types";

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
		const debounceDelay = config.get<number>("mergeEditor.debounceDelay") ?? 300;

		const payload = (await buildDiffPayload(
			repoPath,
			relativeFilePath,
		)) as {
			files: FileState[];
			diffs: DiffChunk[][];
			config?: { debounceDelay: number };
		};
		// Add configuration to the payload
		payload.config = { debounceDelay };
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
						vscode.env.clipboard.writeText(msg.hash);
						vscode.window.showInformationMessage(`Copied hash: ${msg.hash}`);
						break;

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
							const baseUri = gitApi.toGitUri(document.uri, ":1");
							const targetUri = gitApi.toGitUri(
								document.uri,
								msg.paneIndex === 0 ? ":2" : ":3",
							);
							const label = `${path.basename(document.uri.fsPath)} (Base ↔ ${msg.paneIndex === 0 ? "Local" : "Remote"})`;
							vscode.commands.executeCommand(
								"vscode.diff",
								baseUri,
								targetUri,
								label,
							);
						} else {
							vscode.window.showErrorMessage("Git extension is not available.");
						}
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

		const changeConfigurationSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("meld.mergeEditor.debounceDelay")) {
				const newConfig = vscode.workspace.getConfiguration("meld");
				const newDelay = newConfig.get<number>("mergeEditor.debounceDelay") ?? 300;
				webviewPanel.webview.postMessage({
					command: "updateConfig",
					config: { debounceDelay: newDelay }
				});
			}
		});

		webviewPanel.onDidDispose(() => {
			messageListener.dispose();
			changeDocumentSubscription.dispose();
			changeConfigurationSubscription.dispose();
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "out", "webview", "index.js"),
		);

		return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Meld Diff</title>
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
