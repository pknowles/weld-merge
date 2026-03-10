// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
	commands,
	type ExtensionContext,
	ProgressLocation,
	Range,
	RelativePattern,
	type Uri,
	WorkspaceEdit,
	window,
	workspace,
} from "vscode";
import {
	execGit,
	getConflictedFiles,
	getUnresolvedReasons,
} from "./gitUtils.ts";
import { GitTextMerger } from "./matchers/gitTextMerger.ts";
import { ConflictedFilesProvider, type GitFile } from "./treeView.ts";
import { MeldCustomEditorProvider } from "./webview/meldWebviewPanel.ts";

const lastConflictedFilesPerRepo: Map<string, Set<string>> = new Map();

async function notifyIfNewConflicts(repoPath: string) {
	const currentConflicts = await getConflictedFiles(repoPath);
	const lastFiles = lastConflictedFilesPerRepo.get(repoPath) || new Set();
	const newConflicts = currentConflicts.filter((f) => !lastFiles.has(f));

	if (newConflicts.length > 0) {
		const message = `Meld: ${currentConflicts.length} merge conflict${currentConflicts.length > 1 ? "s" : ""} detected.`;
		const action = "View Conflict List";
		window.showInformationMessage(message, action).then((selection) => {
			if (selection === action) {
				commands.executeCommand("meldConflictedFiles.focus");
			}
		});
	}

	lastConflictedFilesPerRepo.set(repoPath, new Set(currentConflicts));
}

function getRelativeRepoPath(documentUri: Uri): string | null {
	const workspaceFolder = workspace.getWorkspaceFolder(documentUri);
	if (!workspaceFolder) {
		return null;
	}
	return relative(workspaceFolder.uri.fsPath, documentUri.fsPath).replace(
		/\\/g,
		"/",
	);
}

async function getGitFileContent(
	repoPath: string,
	relativeFilePath: string,
	stage: number,
): Promise<string> {
	try {
		// We use child_process.execFile here instead of the official vscode.git extension API.
		// The official API does not reliably expose fetching specific merge conflict stages (1, 2, 3)
		// without needing to instantiate entire GitUri documents.
		// 'relativeFilePath' comes directly from VS Code's trusted URI, and because it is passed
		const content = await execGit(
			["show", `:${stage}:${relativeFilePath}`],
			repoPath,
		);
		return content;
	} catch {
		throw new Error(
			`Could not get git content for stage ${stage} of ${relativeFilePath}. Is it in conflict?`,
		);
	}
}

async function updateIfOpen(uri: Uri, newContent: string) {
	const doc = workspace.textDocuments.find(
		(d) => d.uri.toString() === uri.toString(),
	);

	if (!doc) {
		// Not open — nothing to update in editor
		return;
	}

	const edit = new WorkspaceEdit();

	edit.replace(
		uri,
		new Range(0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
		newContent,
	);

	await workspace.applyEdit(edit);
}

export function activate(context: ExtensionContext) {
	const conflictedFilesProvider = new ConflictedFilesProvider();
	window.registerTreeDataProvider(
		"meldConflictedFiles",
		conflictedFilesProvider,
	);

	context.subscriptions.push(MeldCustomEditorProvider.register(context));

	const disposableRefresh = commands.registerCommand(
		"meld-auto-merge.refreshConflicted",
		() => {
			conflictedFilesProvider.refresh();
		},
	);

	const disposableOpenConflicted = commands.registerCommand(
		"meld-auto-merge.openConflictedFile",
		(file: GitFile) => {
			window.showTextDocument(file.uri);
		},
	);

	const disposableOpenMergeEditor = commands.registerCommand(
		"meld-auto-merge.openMergeEditor",
		(file?: GitFile) => {
			let uri = file?.uri;
			if (!uri) {
				const editor = window.activeTextEditor;
				if (!editor) {
					return;
				}
				uri = editor.document.uri;
			}
			commands.executeCommand("git.openMergeEditor", uri);
		},
	);

	const disposableOpenMeldDiff = commands.registerCommand(
		"meld-auto-merge.openMeldDiff",
		(file?: GitFile) => {
			let documentUri: Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = window.activeTextEditor;
				if (!editor?.document || editor.document.isUntitled) {
					return;
				}
				documentUri = editor.document.uri;
			}

			commands.executeCommand(
				"vscode.openWith",
				documentUri,
				MeldCustomEditorProvider.viewType,
			);
		},
	);

	const disposable = commands.registerCommand(
		"meld-auto-merge.autoMerge",
		async (file?: GitFile) => {
			let documentUri: Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = window.activeTextEditor;
				if (!editor) {
					window.showErrorMessage("No active text editor found.");
					return;
				}
				documentUri = editor.document.uri;
			}

			const workspaceFolder = workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) {
				window.showErrorMessage(
					"File must be in a workspace to use git commands.",
				);
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) {
				window.showErrorMessage(
					"Could not determine relative file path.",
				);
				return;
			}

			try {
				const [baseContent, localContent, remoteContent] =
					await Promise.all([
						getGitFileContent(repoPath, relativeFilePath, 1),
						getGitFileContent(repoPath, relativeFilePath, 2),
						getGitFileContent(repoPath, relativeFilePath, 3),
					]);

				window.showInformationMessage(
					"Running Meld auto-merge heuristics...",
				);

				const merger = new GitTextMerger();

				// Meld sequences are expected to be arrays of lines WITHOUT trailing newlines (joined by \n later)
				const splitLines = (text: string) => {
					const lines = text.split("\n");
					if (lines.length > 0 && lines.at(-1) === "") {
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

				const mergeGen = merger.merge3FilesGit(true);
				let finalMergedText: string | null = null;
				for (const res of mergeGen) {
					if (res !== null && typeof res === "string") {
						finalMergedText = res;
					}
				}

				if (finalMergedText === null) {
					throw new Error("Merge generation failed to produce text.");
				}

				const document = await workspace.openTextDocument(documentUri);
				const fullRange = new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				);

				const edit = new WorkspaceEdit();
				edit.replace(documentUri, fullRange, finalMergedText as string);
				const success = await workspace.applyEdit(edit);

				if (success) {
					window.showInformationMessage(
						"Meld Auto-Merge complete! Unresolved conflicts marked.",
					);
					conflictedFilesProvider.refresh();
				} else {
					window.showErrorMessage(
						"Failed to apply merged text to editor.",
					);
				}
			} catch (e: unknown) {
				window.showErrorMessage(
					`Meld Auto-Merge Error: ${(e as Error).message}`,
				);
			}
		},
	);

	const disposableAutoMergeAll = commands.registerCommand(
		"meld-auto-merge.autoMergeAll",
		async () => {
			const files = await conflictedFilesProvider.getChildren();
			const unmergedFiles = files.filter(
				(f) => f.contextValue === "conflictedFile",
			);
			if (unmergedFiles.length === 0) {
				window.showInformationMessage(
					"No unmerged files to auto-merge.",
				);
				return;
			}

			let successCount = 0;
			let errorCount = 0;

			await window.withProgress(
				{
					location: ProgressLocation.Notification,
					title: "Meld Auto-Merge All",
					cancellable: false,
				},
				async (progress) => {
					for (const file of unmergedFiles) {
						try {
							progress.report({
								message: `Merging ${file.label}...`,
							});
							// biome-ignore lint/performance/noAwaitInLoops: sequential merge is safer for git index locks
							await commands.executeCommand(
								"meld-auto-merge.autoMerge",
								file,
							);
							successCount++;
						} catch {
							errorCount++;
						}
					}
				},
			);

			window.showInformationMessage(
				`Auto-merge finished: ${successCount} succeeded, ${errorCount} failed.`,
			);
		},
	);

	const disposableCheckout = commands.registerCommand(
		"meld-auto-merge.checkoutConflicted",
		async (file?: GitFile) => {
			let documentUri: Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = window.activeTextEditor;
				if (!editor?.document || editor.document.isUntitled) {
					return;
				}
				documentUri = editor.document.uri;
			}

			const relativePath =
				getRelativeRepoPath(documentUri) || documentUri.fsPath;
			const confirm = await window.showWarningMessage(
				`Are you sure you want to checkout the conflicted version of ${relativePath} (-m)? This will overwrite your current file.`,
				{ modal: true },
				"Yes",
			);
			if (confirm !== "Yes") {
				return;
			}

			const workspaceFolder = workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) {
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) {
				return;
			}

			try {
				await execGit(
					["checkout", "-m", "--", relativeFilePath],
					repoPath,
				);

				// After disk updated, read back and apply to editor if open to preserve undo
				const newContent = await readFile(documentUri.fsPath, "utf8");
				await updateIfOpen(documentUri, newContent);

				// Explicitly tell the webview to recalculate diffs and conflict markers
				MeldCustomEditorProvider.onRequestRefresh.fire(documentUri);

				window.showInformationMessage(
					`Checked out conflicted version of ${relativeFilePath}`,
				);
				conflictedFilesProvider.refresh();
			} catch (e: unknown) {
				window.showErrorMessage(
					`Checkout failed: ${(e as Error).message}`,
				);
			}
		},
	);

	const disposableRerere = commands.registerCommand(
		"meld-auto-merge.rerereForget",
		async (file?: GitFile) => {
			let documentUri: Uri;
			if (file) {
				documentUri = file.uri;
			} else {
				const editor = window.activeTextEditor;
				if (!editor?.document || editor.document.isUntitled) {
					return;
				}
				documentUri = editor.document.uri;
			}

			const relativePath =
				getRelativeRepoPath(documentUri) || documentUri.fsPath;
			const confirm = await window.showWarningMessage(
				`Are you sure you want to forget the recorded rerere resolution for ${relativePath}?`,
				{ modal: true },
				"Yes",
			);
			if (confirm !== "Yes") {
				return;
			}

			const workspaceFolder = workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) {
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) {
				return;
			}

			try {
				await execGit(["rerere", "forget", relativeFilePath], repoPath);
				window.showInformationMessage(
					`Forgot recorded resolution for ${relativeFilePath}`,
				);
				conflictedFilesProvider.refresh();
			} catch (e: unknown) {
				window.showErrorMessage(
					`Rerere forget failed: ${(e as Error).message}`,
				);
			}
		},
	);

	const disposableSmartAdd = commands.registerCommand(
		"meld-auto-merge.smartAdd",
		async (file?: GitFile) => {
			let documentUri: Uri;
			let text: string;

			if (file) {
				documentUri = file.uri;
				const doc = await workspace.openTextDocument(documentUri);
				await doc.save();
				text = doc.getText();
			} else {
				const editor = window.activeTextEditor;
				if (!editor?.document || editor.document.isUntitled) {
					return;
				}
				await editor.document.save(); // ensure saved
				documentUri = editor.document.uri;
				text = editor.document.getText();
			}

			const unresolvedReasons = getUnresolvedReasons(text);
			if (unresolvedReasons.length > 0) {
				window.showErrorMessage(
					`Cannot add file: file contains ${unresolvedReasons.join(" and ")}.`,
				);
				return false;
			}

			const workspaceFolder = workspace.getWorkspaceFolder(documentUri);
			if (!workspaceFolder) {
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const relativeFilePath = getRelativeRepoPath(documentUri);
			if (!relativeFilePath) {
				return;
			}

			try {
				// While the official vscode.git API has an `.add()` method, using execFile here keeps the implementation
				// consistent without the overhead of querying the Git extension for the active Repository object.
				// 'relativeFilePath' is safely passed as a discrete argument array element to execFile.
				await execGit(["add", relativeFilePath], repoPath);
				window.showInformationMessage(
					`Successfully added ${relativeFilePath}`,
				);
				conflictedFilesProvider.refresh();
				return true;
			} catch (e: unknown) {
				window.showErrorMessage(
					`Git Add failed: ${(e as Error).message}`,
				);
				return false;
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
	const workspaceFolders = workspace.workspaceFolders;
	if (workspaceFolders) {
		for (const workspaceFolder of workspaceFolders) {
			const repoPath = workspaceFolder.uri.fsPath;
			const watcher = workspace.createFileSystemWatcher(
				new RelativePattern(repoPath, ".git/index"),
			);
			context.subscriptions.push(watcher);
			const refresh = () => {
				conflictedFilesProvider.refresh();
				notifyIfNewConflicts(repoPath);
			};
			watcher.onDidChange(refresh);
			watcher.onDidCreate(refresh);
			watcher.onDidDelete(refresh);

			// Initial check
			notifyIfNewConflicts(repoPath);
		}
	}

	// Fallback refresh when user saves any document
	context.subscriptions.push(
		workspace.onDidSaveTextDocument(() => {
			conflictedFilesProvider.refresh();
		}),
	);
}

export function deactivate() {
	// Cleanup if needed
}
