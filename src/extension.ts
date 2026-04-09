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
import { restoreSubmoduleConflict } from "./gitSubmodule.ts";
import {
	execGit,
	getConflictedFiles,
	getUnresolvedReasons,
} from "./gitUtils.ts";
import { GitTextMerger } from "./matchers/gitTextMerger.ts";
import { ConflictedFilesProvider, type GitFile } from "./treeView.ts";
import { MeldCustomEditorProvider } from "./webview/meldWebviewPanel.ts";
import { SubmodulePanel } from "./webview/submodulePanel.ts";

const lastConflictedFilesPerRepo: Map<string, Set<string>> = new Map();

async function notifyIfNewConflicts(repoPath: string) {
	const currentConflicts = await getConflictedFiles(repoPath);
	const lastFiles = lastConflictedFilesPerRepo.get(repoPath) || new Set();
	const newConflicts = currentConflicts.filter((f) => !lastFiles.has(f));

	if (newConflicts.length > 0) {
		const message = `Weld: ${currentConflicts.length} merge conflict${currentConflicts.length > 1 ? "s" : ""} detected.`;
		const action = "View Conflict List";
		window.showInformationMessage(message, action).then((selection) => {
			if (selection === action) {
				commands.executeCommand("weldConflictedFiles.focus");
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

function handleOpenMergeEditor(file?: GitFile) {
	let uri = file?.uri;
	if (!uri) {
		const editor = window.activeTextEditor;
		if (!editor) {
			return;
		}
		uri = editor.document.uri;
	}
	commands.executeCommand("git.openMergeEditor", uri);
}

function handleOpenMeldDiff(file?: GitFile) {
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
}

async function handleOpenSubmoduleDiff(
	file: GitFile,
	extensionUri: Uri,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const workspaceFolder = workspace.getWorkspaceFolder(file.uri);
	if (!workspaceFolder) {
		return;
	}
	if (file.contextValue === "resolvedSubmodule") {
		const action = await window.showInformationMessage(
			`Submodule ${file.label} is already resolved. Would you like to restore the conflict to re-resolve it?`,
			"Restore Conflict",
		);
		if (action === "Restore Conflict") {
			const success = await commands.executeCommand<boolean>(
				"weldMerge.checkoutConflicted",
				file,
			);
			if (!success) {
				return;
			}
		} else {
			return;
		}
	}

	await SubmodulePanel.open(
		extensionUri,
		workspaceFolder.uri.fsPath,
		file.label as string,
		conflictedFilesProvider,
	);
}

function splitLines(text: string) {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

async function handleAutoMerge(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
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
		window.showErrorMessage("Could not determine relative file path.");
		return;
	}

	try {
		const [baseContent, localContent, remoteContent] = await Promise.all([
			getGitFileContent(repoPath, relativeFilePath, 1),
			getGitFileContent(repoPath, relativeFilePath, 2),
			getGitFileContent(repoPath, relativeFilePath, 3),
		]);

		window.showInformationMessage("Running Weld auto-merge heuristics...");

		const merger = new GitTextMerger();
		const localLines = splitLines(localContent);
		const baseLines = splitLines(baseContent);
		const remoteLines = splitLines(remoteContent);

		const sequences = [localLines, baseLines, remoteLines];
		const initGen = merger.initialize(sequences, sequences);
		while (!initGen.next().done) {
			/* iterate */
		}

		const mergeGen = merger.merge3FilesGit(true);
		let resMerge = mergeGen.next();
		while (!resMerge.done) {
			resMerge = mergeGen.next();
		}
		const finalMergedText =
			resMerge.value !== undefined ? (resMerge.value as string) : null;

		if (finalMergedText === null) {
			throw new Error("Merge generation failed to produce text.");
		}

		const document = await workspace.openTextDocument(documentUri);
		const fullRange = new Range(
			document.positionAt(0),
			document.positionAt(document.getText().length),
		);

		const edit = new WorkspaceEdit();
		edit.replace(documentUri, fullRange, finalMergedText);
		if (await workspace.applyEdit(edit)) {
			window.showInformationMessage(
				"Weld Auto-Merge complete! Unresolved conflicts marked.",
			);
			conflictedFilesProvider.refresh();
		} else {
			window.showErrorMessage("Failed to apply merged text to editor.");
		}
	} catch (e: unknown) {
		window.showErrorMessage(
			`Weld Auto-Merge Error: ${(e as Error).message}`,
		);
	}
}

async function handleAutoMergeAll(
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const files = await conflictedFilesProvider.getChildren();
	const unmergedFiles = files.filter(
		(f) => f.contextValue === "conflictedFile",
	);
	if (unmergedFiles.length === 0) {
		window.showInformationMessage("No unmerged files to auto-merge.");
		return;
	}

	let successCount = 0;
	let errorCount = 0;

	await window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: "Weld Auto-Merge All",
			cancellable: false,
		},
		async (progress) => {
			const processNext = async (index: number): Promise<void> => {
				const file = unmergedFiles[index];
				if (!file) {
					return;
				}
				try {
					progress.report({
						message: `Merging ${file.label}...`,
					});
					await commands.executeCommand("weldMerge.autoMerge", file);
					successCount++;
				} catch {
					errorCount++;
				}
				return processNext(index + 1);
			};
			await processNext(0);
		},
	);

	window.showInformationMessage(
		`Auto-merge finished: ${successCount} succeeded, ${errorCount} failed.`,
	);
}

async function checkIfSubmodule(
	repoPath: string,
	relativeFilePath: string,
	file?: GitFile,
): Promise<boolean> {
	try {
		const lsStage = await execGit(
			["ls-files", "-s", "--", relativeFilePath],
			repoPath,
		);
		return (
			lsStage.includes("160000") ||
			Boolean(file?.contextValue?.toLowerCase().includes("submodule"))
		);
	} catch {
		return false;
	}
}

async function handleCheckoutConflicted(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<boolean> {
	let documentUri: Uri;
	if (file) {
		documentUri = file.uri;
	} else {
		const editor = window.activeTextEditor;
		if (!editor?.document || editor.document.isUntitled) {
			return false;
		}
		documentUri = editor.document.uri;
	}

	const workspaceFolder = workspace.getWorkspaceFolder(documentUri);
	if (!workspaceFolder) {
		return false;
	}

	const repoPath = file?.repoPath ?? workspaceFolder.uri.fsPath;
	const relativeFilePath =
		file?.label?.toString() ?? getRelativeRepoPath(documentUri);
	if (!relativeFilePath) {
		return false;
	}

	const isSubmodule = await checkIfSubmodule(
		repoPath,
		relativeFilePath,
		file,
	);

	const relativePath = getRelativeRepoPath(documentUri) || documentUri.fsPath;
	const message = isSubmodule
		? `Are you sure you want to restore the conflict state for submodule ${relativeFilePath} (git update-index --index-info)? This will overwrite your current staged resolution.`
		: `Are you sure you want to checkout the conflicted version of ${relativePath} (git checkout -m)? This will overwrite your current file.`;

	const confirm = await window.showWarningMessage(
		message,
		{ modal: true },
		"Yes",
	);
	if (confirm !== "Yes") {
		return false;
	}

	try {
		if (isSubmodule) {
			await restoreSubmoduleConflict(repoPath, relativeFilePath);
		} else {
			await execGit(["checkout", "-m", "--", relativeFilePath], repoPath);
			const newContent = await readFile(documentUri.fsPath, "utf8");
			await updateIfOpen(documentUri, newContent);
		}

		MeldCustomEditorProvider.onRequestRefresh.fire(documentUri);
		window.showInformationMessage(
			`Checked out conflicted version of ${relativeFilePath}`,
		);
		conflictedFilesProvider.refresh();
		return true;
	} catch (e: unknown) {
		window.showErrorMessage(`Checkout failed: ${(e as Error).message}`);
		return false;
	}
}

async function handleRerereForget(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
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

	const relativePath = getRelativeRepoPath(documentUri) || documentUri.fsPath;
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
}

async function handleSmartAdd(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
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
		await editor.document.save();
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
		await execGit(["add", relativeFilePath], repoPath);
		window.showInformationMessage(`Successfully added ${relativeFilePath}`);
		conflictedFilesProvider.refresh();
		return true;
	} catch (e: unknown) {
		window.showErrorMessage(`Git Add failed: ${(e as Error).message}`);
		return false;
	}
}

function registerViews(
	context: ExtensionContext,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	window.registerTreeDataProvider(
		"weldConflictedFiles",
		conflictedFilesProvider,
	);
	context.subscriptions.push(MeldCustomEditorProvider.register(context));
}

function registerCommands(
	context: ExtensionContext,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	context.subscriptions.push(
		commands.registerCommand("weldMerge.refreshConflicted", () => {
			conflictedFilesProvider.refresh();
		}),
		commands.registerCommand(
			"weldMerge.openConflictedFile",
			(file: GitFile) => {
				window.showTextDocument(file.uri);
			},
		),
		commands.registerCommand(
			"weldMerge.openMergeEditor",
			(file?: GitFile) => handleOpenMergeEditor(file),
		),
		commands.registerCommand("weldMerge.openMeldDiff", (file?: GitFile) =>
			handleOpenMeldDiff(file),
		),
		commands.registerCommand("weldMerge.autoMerge", (file?: GitFile) =>
			handleAutoMerge(file, conflictedFilesProvider),
		),
		commands.registerCommand("weldMerge.autoMergeAll", () =>
			handleAutoMergeAll(conflictedFilesProvider),
		),
		commands.registerCommand(
			"weldMerge.checkoutConflicted",
			(file?: GitFile) =>
				handleCheckoutConflicted(file, conflictedFilesProvider),
		),
		commands.registerCommand("weldMerge.rerereForget", (file?: GitFile) =>
			handleRerereForget(file, conflictedFilesProvider),
		),
		commands.registerCommand("weldMerge.smartAdd", (file?: GitFile) =>
			handleSmartAdd(file, conflictedFilesProvider),
		),
		commands.registerCommand("weld.openSubmoduleDiff", (file: GitFile) =>
			handleOpenSubmoduleDiff(
				file,
				context.extensionUri,
				conflictedFilesProvider,
			),
		),
	);
}

function setupWatchers(
	context: ExtensionContext,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
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
			notifyIfNewConflicts(repoPath);
		}
	}

	context.subscriptions.push(
		workspace.onDidSaveTextDocument(() => {
			conflictedFilesProvider.refresh();
		}),
	);
}

export function activate(context: ExtensionContext) {
	const conflictedFilesProvider = new ConflictedFilesProvider();
	registerViews(context, conflictedFilesProvider);
	registerCommands(context, conflictedFilesProvider);
	setupWatchers(context, conflictedFilesProvider);
}

export function deactivate() {
	// Cleanup if needed
}
