import * as vscode from "vscode";
import * as path from "node:path";

import { buildDiffPayload } from "./diffPayload";

export class MeldWebviewPanel {
	public static currentPanel: MeldWebviewPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(
		extensionUri: vscode.Uri,
		repoPath: string,
		relativeFilePath: string,
		documentUri: vscode.Uri,
	) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (MeldWebviewPanel.currentPanel) {
			MeldWebviewPanel.currentPanel._panel.reveal(column);
			MeldWebviewPanel.currentPanel.loadGitStates(repoPath, relativeFilePath, documentUri);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"meldDiff",
			`Meld: ${path.basename(relativeFilePath)}`,
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out")],
				retainContextWhenHidden: true,
			},
		);

		MeldWebviewPanel.currentPanel = new MeldWebviewPanel(panel, extensionUri);
		MeldWebviewPanel.currentPanel.loadGitStates(repoPath, relativeFilePath, documentUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
	}

	private async loadGitStates(repoPath: string, relativeFilePath: string, documentUri: vscode.Uri) {
		const payload = await buildDiffPayload(repoPath, relativeFilePath);

		// We must wait for the React App to mount and send a 'ready' message
		// before we blast it with the payload, otherwise the event is missed
		// and it hangs on "Loading Diff..."
		const messageListener = this._panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.command === "ready") {
				this._panel.webview.postMessage(payload);
			} else if (msg.command === "save") {
				const edit = new vscode.WorkspaceEdit();
				const document = await vscode.workspace.openTextDocument(documentUri);
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length)
				);
				edit.replace(documentUri, fullRange, msg.text);
				await vscode.workspace.applyEdit(edit);
				await document.save();
				vscode.window.showInformationMessage(`Saved ${relativeFilePath}`);
			} else if (msg.command === "showCommit") {
				vscode.commands.executeCommand(
					"meld-auto-merge.showCommit",
					repoPath,
					msg.hash,
				);
			} else if (msg.command === "completeMerge") {
				vscode.commands.executeCommand(
					"meld-auto-merge.smartAdd",
					{ uri: documentUri }
				);
				this._panel.dispose();
			}
		});

		this._disposables.push(messageListener);
	}

	public dispose() {
		MeldWebviewPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "out", "webview", "index.js"),
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
