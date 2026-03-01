import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitTextMerger } from "./matchers/gitTextMerger";
import { ConflictedFilesProvider, type GitFile } from "./treeView";
import { MeldCustomEditorProvider } from "./webview/MeldWebviewPanel";

function execShell(cmd: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.exec(cmd, { cwd, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
			if (err) {
				reject(err);
			} else {
				resolve(stdout);
			}
		});
	});
}

function getRelativeRepoPath(documentUri: vscode.Uri): string | null {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
	if (!workspaceFolder) return null;
	return path
		.relative(workspaceFolder.uri.fsPath, documentUri.fsPath)
		.replace(/\\/g, "/");
}

async function getGitFileContent(
	repoPath: string,
	relativeFilePath: string,
	stage: number,
): Promise<string> {
	try {
		const content = await execShell(
			`git show :${stage}:"${relativeFilePath}"`,
			repoPath,
		);
		return content;
	} catch (_e) {
		throw new Error(
			`Could not get git content for stage ${stage} of ${relativeFilePath}. Is it in conflict?`,
		);
	}
}

async function updateIfOpen(uri: vscode.Uri, newContent: string) {
	const doc = vscode.workspace.textDocuments.find(
		(d) => d.uri.toString() === uri.toString(),
	);

	if (!doc) {
		// Not open — nothing to update in editor
		return;
	}

	const edit = new vscode.WorkspaceEdit();

	edit.replace(
		uri,
		new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
		newContent,
	);

	await vscode.workspace.applyEdit(edit);
}

export function activate(context: vscode.ExtensionContext) {
	const conflictedFilesProvider = new ConflictedFilesProvider();
	vscode.window.registerTreeDataProvider(
		"meldConflictedFiles",
		conflictedFilesProvider,
	);

	context.subscriptions.push(MeldCustomEditorProvider.register(context));

	const disposableRefresh = vscode.commands.registerCommand(
		"meld-auto-merge.refreshConflicted",
		() => {
			conflictedFilesProvider.refresh();
		},
	);

	const disposableOpenConflicted = vscode.commands.registerCommand(
		"meld-auto-merge.openConflictedFile",
		(file: GitFile) => {
			vscode.window.showTextDocument(file.uri);
		},
	);

	const disposableOpenMergeEditor = vscode.commands.registerCommand(
		"meld-auto-merge.openMergeEditor",
		(file?: GitFile) => {
			let uri = file?.uri;
			if (!uri) {
				const editor = vscode.window.activeTextEditor;
				if (!editor) return;
				uri = editor.document.uri;
			}
			vscode.commands.executeCommand("git.openMergeEditor", uri);
		},
	);

	const disposableOpenMeldDiff = vscode.commands.registerCommand(
		"meld-auto-merge.openMeldDiff",
		async (file?: GitFile) => {
			let documentUri: vscode.Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = vscode.window.activeTextEditor;
				if (!editor || !editor.document || editor.document.isUntitled) return;
				documentUri = editor.document.uri;
			}

			vscode.commands.executeCommand(
				"vscode.openWith",
				documentUri,
				MeldCustomEditorProvider.viewType,
			);
		},
	);

	const disposable = vscode.commands.registerCommand(
		"meld-auto-merge.autoMerge",
		async (file?: GitFile) => {
			let documentUri: vscode.Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					vscode.window.showErrorMessage("No active text editor found.");
					return;
				}
				documentUri = editor.document.uri;
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) {
				vscode.window.showErrorMessage(
					"File must be in a workspace to use git commands.",
				);
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) {
				vscode.window.showErrorMessage(
					"Could not determine relative file path.",
				);
				return;
			}

			try {
				const baseContent = await getGitFileContent(
					repoPath,
					relativeFilePath,
					1,
				);
				const localContent = await getGitFileContent(
					repoPath,
					relativeFilePath,
					2,
				);
				const remoteContent = await getGitFileContent(
					repoPath,
					relativeFilePath,
					3,
				);

				vscode.window.showInformationMessage(
					"Running Meld auto-merge heuristics...",
				);

				const merger = new GitTextMerger();

				// Meld sequences are expected to be arrays of lines WITHOUT trailing newlines (joined by \n later)
				const splitLines = (text: string) => {
					const lines = text.split("\n");
					if (lines.length > 0 && lines[lines.length - 1] === "") {
						lines.pop(); // remove trailing empty string from trailing newline
					}
					return lines;
				};

				const localLines = splitLines(localContent);
				const baseLines = splitLines(baseContent);
				const remoteLines = splitLines(remoteContent);

				const sequences = [localLines, baseLines, remoteLines];

				const initGen = merger.initialize(sequences, sequences);
				let val = initGen.next();
				while (!val.done) {
					val = initGen.next();
				}

				const mergeGen = merger.merge_3_files_git(true);
				let finalMergedText: string | null = null;
				for (const res of mergeGen) {
					if (res !== null && typeof res === "string") {
						finalMergedText = res;
					}
				}

				if (finalMergedText === null) {
					throw new Error("Merge generation failed to produce text.");
				}

				const document = await vscode.workspace.openTextDocument(documentUri);
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				);

				const edit = new vscode.WorkspaceEdit();
				edit.replace(documentUri, fullRange, finalMergedText as string);
				const success = await vscode.workspace.applyEdit(edit);

				if (success) {
					vscode.window.showInformationMessage(
						`Meld Auto-Merge complete! Unresolved conflicts marked.`,
					);
					conflictedFilesProvider.refresh();
				} else {
					vscode.window.showErrorMessage(
						`Failed to apply merged text to editor.`,
					);
				}
			} catch (e: unknown) {
				vscode.window.showErrorMessage(
					`Meld Auto-Merge Error: ${(e as Error).message}`,
				);
			}
		},
	);

	const disposableAutoMergeAll = vscode.commands.registerCommand(
		"meld-auto-merge.autoMergeAll",
		async () => {
			const files = await conflictedFilesProvider.getChildren();
			const unmergedFiles = files.filter(
				(f) => f.contextValue === "conflictedFile",
			);
			if (unmergedFiles.length === 0) {
				vscode.window.showInformationMessage(
					"No unmerged files to auto-merge.",
				);
				return;
			}

			let successCount = 0;
			let errorCount = 0;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Meld Auto-Merge All",
					cancellable: false,
				},
				async (progress) => {
					for (const file of unmergedFiles) {
						try {
							progress.report({ message: `Merging ${file.label}...` });
							await vscode.commands.executeCommand(
								"meld-auto-merge.autoMerge",
								file,
							);
							successCount++;
						} catch (_e) {
							errorCount++;
						}
					}
				},
			);

			vscode.window.showInformationMessage(
				`Auto-merge finished: ${successCount} succeeded, ${errorCount} failed.`,
			);
		},
	);

	const disposableCheckout = vscode.commands.registerCommand(
		"meld-auto-merge.checkoutConflicted",
		async (file?: GitFile) => {
			let documentUri: vscode.Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = vscode.window.activeTextEditor;
				if (!editor || !editor.document || editor.document.isUntitled) return;
				documentUri = editor.document.uri;
			}

			const relativePath =
				getRelativeRepoPath(documentUri) || documentUri.fsPath;
			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to checkout the conflicted version of ${relativePath} (-m)? This will overwrite your current file.`,
				{ modal: true },
				"Yes",
			);
			if (confirm !== "Yes") return;

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) return;

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) return;

			try {
				await execShell(`git checkout -m -- "${relativeFilePath}"`, repoPath);

				// After disk updated, read back and apply to editor if open to preserve undo
				const newContent = await fs.readFile(documentUri.fsPath, "utf8");
				await updateIfOpen(documentUri, newContent);

				vscode.window.showInformationMessage(
					`Checked out conflicted version of ${relativeFilePath}`,
				);
				conflictedFilesProvider.refresh();
			} catch (e: unknown) {
				vscode.window.showErrorMessage(
					`Checkout failed: ${(e as Error).message}`,
				);
			}
		},
	);

	const disposableRerere = vscode.commands.registerCommand(
		"meld-auto-merge.rerereForget",
		async (file?: GitFile) => {
			let documentUri: vscode.Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = vscode.window.activeTextEditor;
				if (!editor || !editor.document || editor.document.isUntitled) return;
				documentUri = editor.document.uri;
			}

			const relativePath =
				getRelativeRepoPath(documentUri) || documentUri.fsPath;
			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to forget the recorded rerere resolution for ${relativePath}?`,
				{ modal: true },
				"Yes",
			);
			if (confirm !== "Yes") return;

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) return;

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) return;

			try {
				await execShell(`git rerere forget "${relativeFilePath}"`, repoPath);
				vscode.window.showInformationMessage(
					`Forgot recorded resolution for ${relativeFilePath}`,
				);
				conflictedFilesProvider.refresh();
			} catch (e: unknown) {
				vscode.window.showErrorMessage(
					`Rerere forget failed: ${(e as Error).message}`,
				);
			}
		},
	);

	const disposableSmartAdd = vscode.commands.registerCommand(
		"meld-auto-merge.smartAdd",
		async (file?: GitFile) => {
			let documentUri: vscode.Uri;
			let text: string;

			if (file) {
				documentUri = file.uri;
				const doc = await vscode.workspace.openTextDocument(documentUri);
				await doc.save();
				text = doc.getText();
			} else {
				const editor = vscode.window.activeTextEditor;
				if (!editor || !editor.document || editor.document.isUntitled) return;
				await editor.document.save(); // ensure saved
				documentUri = editor.document.uri;
				text = editor.document.getText();
			}

			if (
				text.includes("<<<<<<<") ||
				text.includes("=======") ||
				text.includes(">>>>>>>")
			) {
				vscode.window.showErrorMessage(
					"Cannot add file: Conflict markers still remain in the text.",
				);
				return;
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) return;

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) return;

			try {
				await execShell(`git add "${relativeFilePath}"`, repoPath);
				vscode.window.showInformationMessage(
					`Successfully added ${relativeFilePath}`,
				);
				conflictedFilesProvider.refresh();
			} catch (e: unknown) {
				vscode.window.showErrorMessage(
					`Git Add failed: ${(e as Error).message}`,
				);
			}
		},
	);

	context.subscriptions.push(
		disposable,
		disposableAutoMergeAll,
		disposableCheckout,
		disposableRerere,
		disposableSmartAdd,
		disposableRefresh,
		disposableOpenConflicted,
		disposableOpenMergeEditor,
		disposableOpenMeldDiff,
	);

	// Watch for .git/index changes to auto-refresh the TreeView
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const repoPath = workspaceFolders[0].uri.fsPath;
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(repoPath, ".git/index"),
		);
		context.subscriptions.push(watcher);
		watcher.onDidChange(() => conflictedFilesProvider.refresh());
		watcher.onDidCreate(() => conflictedFilesProvider.refresh());
		watcher.onDidDelete(() => conflictedFilesProvider.refresh());
	}

	// Fallback refresh when user saves any document
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(() => {
			conflictedFilesProvider.refresh();
		}),
	);
}

export function deactivate() {}
