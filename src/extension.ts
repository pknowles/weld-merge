import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as path from "node:path";
import { Merger } from "./matchers/merge";
import { ConflictedFilesProvider, type GitFile } from "./treeView";
import { MeldWebviewPanel } from "./webview/MeldWebviewPanel";

class GitTextMerger extends Merger {
	*merge_3_files_git(mark_conflicts: boolean = true) {
		this.differ.unresolved = [];
		let lastline = 0;
		let mergedline = 0;
		const mergedtext: string[] = [];

		for (const change of this.differ.all_changes()) {
			yield null;
			let low_mark = lastline;
			if (change[0] !== null) low_mark = change[0].start_a;
			if (change[1] !== null && change[1].start_a > low_mark) {
				low_mark = change[1].start_a;
			}

			for (let i = lastline; i < low_mark; i++) {
				mergedtext.push(this.texts[1][i]);
			}
			mergedline += low_mark - lastline;
			lastline = low_mark;

			if (
				change[0] !== null &&
				change[1] !== null &&
				change[0].tag === "conflict"
			) {
				const min_mark = Math.min(change[0].start_a, change[1].start_a);
				const high_mark = Math.max(change[0].end_a, change[1].end_a);
				if (mark_conflicts) {
					mergedtext.push("<<<<<<< HEAD");
					for (let i = change[0].start_b; i < change[0].end_b; i++) {
						mergedtext.push(this.texts[0][i]);
					}
					mergedtext.push("||||||| BASE");
					for (let i = min_mark; i < high_mark; i++) {
						mergedtext.push(this.texts[1][i]);
					}
					mergedtext.push("=======");
					for (let i = change[1].start_b; i < change[1].end_b; i++) {
						mergedtext.push(this.texts[2][i]);
					}
					mergedtext.push(">>>>>>> REMOTE");

					const added_lines =
						change[0].end_b -
						change[0].start_b +
						(high_mark - min_mark) +
						(change[1].end_b - change[1].start_b) +
						4;
					for (let i = 0; i < added_lines; i++) {
						this.differ.unresolved.push(mergedline);
						mergedline += 1;
					}
					lastline = high_mark;
				}
			} else if (change[0] !== null) {
				lastline += this._apply_change(this.texts[0], change[0], mergedtext);
				mergedline += change[0].end_b - change[0].start_b;
			} else if (change[1] !== null) {
				lastline += this._apply_change(this.texts[2], change[1], mergedtext);
				mergedline += change[1].end_b - change[1].start_b;
			}
		}

		const baselen = this.texts[1].length;
		for (let i = lastline; i < baselen; i++) {
			mergedtext.push(this.texts[1][i]);
		}

		yield mergedtext.join("\n");
	}
}

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

export function activate(context: vscode.ExtensionContext) {
	const conflictedFilesProvider = new ConflictedFilesProvider();
	vscode.window.registerTreeDataProvider(
		"meldConflictedFiles",
		conflictedFilesProvider,
	);

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

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) return;

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) return;

			MeldWebviewPanel.createOrShow(
				context.extensionUri,
				repoPath,
				relativeFilePath,
				documentUri
			);
		},
	);

	const disposableShowCommit = vscode.commands.registerCommand(
		"meld-auto-merge.showCommit",
		async (repoPath: string, hash: string) => {
			try {
				const output = await execShell(`git show ${hash}`, repoPath);
				const doc = await vscode.workspace.openTextDocument({
					content: output,
					language: "git-commit",
				});
				vscode.window.showTextDocument(doc);
			} catch (e: unknown) {
				vscode.window.showErrorMessage(
					`Failed to show commit: ${(e as Error).message}`,
				);
			}
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
		disposableShowCommit,
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
