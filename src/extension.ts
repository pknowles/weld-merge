// Copyright (C) 2026 Pyarelal Knowles, GPL v2

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
import { getWeldLogChannel, initializeWeldLogChannel } from "./log.ts";
import { GitTextMerger } from "./matchers/gitTextMerger.ts";
import {
	getGitApi,
	isSupportedScheme,
	type RepoContext,
	resolveRepoContext,
} from "./repoContext.ts";
import { ConflictedFilesProvider, type GitFile } from "./treeView.ts";
import { MeldCustomEditorProvider } from "./webview/meldWebviewPanel.ts";

const lastConflictedFilesPerRepo: Map<string, Set<string>> = new Map();
const GIT_CONFLICT_WATCH_PATTERNS = [
	".git/index",
	".git/MERGE_HEAD",
	".git/CHERRY_PICK_HEAD",
	".git/REVERT_HEAD",
	".git/rebase-merge/**",
	".git/rebase-apply/**",
];

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function notifyIfNewConflicts(repoKey: string, repoPath: string) {
	const currentConflicts = await getConflictedFiles(repoPath);
	const lastFiles = lastConflictedFilesPerRepo.get(repoKey) || new Set();
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

	lastConflictedFilesPerRepo.set(repoKey, new Set(currentConflicts));
}

interface TrackedRepository {
	repoKey: string;
	rootUri: Uri;
	rootFsPath: string;
}

async function getTrackedRepositories(): Promise<TrackedRepository[]> {
	const workspaceFolders = workspace.workspaceFolders;
	if (!workspaceFolders) {
		return [];
	}
	const gitApi = await getGitApi();
	const repositoriesByRootUri = new Map<string, TrackedRepository>();
	for (const workspaceFolder of workspaceFolders) {
		if (!isSupportedScheme(workspaceFolder.uri)) {
			continue;
		}
		const repository = gitApi.getRepository(workspaceFolder.uri);
		if (!repository) {
			continue;
		}
		repositoriesByRootUri.set(repository.rootUri.toString(), {
			repoKey: repository.rootUri.toString(),
			rootUri: repository.rootUri,
			rootFsPath: repository.rootUri.fsPath,
		});
	}
	return [...repositoriesByRootUri.values()];
}

function registerConflictWatchersForRepository(
	context: ExtensionContext,
	conflictedFilesProvider: ConflictedFilesProvider,
	trackedRepository: TrackedRepository,
): void {
	const doRefresh = async () => {
		try {
			conflictedFilesProvider.refresh();
			await notifyIfNewConflicts(
				trackedRepository.repoKey,
				trackedRepository.rootFsPath,
			);
			const stateKey =
				await MeldCustomEditorProvider.getCurrentConflictStateKey(
					trackedRepository.rootFsPath,
				);
			MeldCustomEditorProvider.onConflictStateChanged.fire({
				repoPath: trackedRepository.rootFsPath,
				stateKey,
			});
		} catch (error: unknown) {
			getWeldLogChannel().error(
				`Refresh watcher failed for ${trackedRepository.rootFsPath}: ${getErrorMessage(error)}`,
			);
		}
	};

	const RefreshDebounceMs = 50;
	let refreshTimer: NodeJS.Timeout | null = null;
	const refresh = () => {
		if (refreshTimer !== null) {
			clearTimeout(refreshTimer);
		}
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			doRefresh().catch((error: unknown) => {
				getWeldLogChannel().error(
					`Refresh watcher failed for ${trackedRepository.rootFsPath}: ${getErrorMessage(error)}`,
				);
			});
		}, RefreshDebounceMs);
	};
	context.subscriptions.push({
		dispose: () => {
			if (refreshTimer !== null) {
				clearTimeout(refreshTimer);
				refreshTimer = null;
			}
		},
	});

	for (const pattern of GIT_CONFLICT_WATCH_PATTERNS) {
		const watcher = workspace.createFileSystemWatcher(
			new RelativePattern(trackedRepository.rootUri, pattern),
		);
		context.subscriptions.push(watcher);
		watcher.onDidChange(refresh);
		watcher.onDidCreate(refresh);
		watcher.onDidDelete(refresh);
	}
	doRefresh().catch((error: unknown) => {
		getWeldLogChannel().error(
			`Initial watcher refresh failed for ${trackedRepository.rootFsPath}: ${getErrorMessage(error)}`,
		);
	});
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

function getTargetDocumentUri(file?: GitFile): Uri | null {
	if (file) {
		return file.uri;
	}
	const editor = window.activeTextEditor;
	if (!editor?.document || editor.document.isUntitled) {
		return null;
	}
	return editor.document.uri;
}

async function resolveCommandRepoContext(
	documentUri: Uri,
	commandName: string,
): Promise<RepoContext | null> {
	if (!isSupportedScheme(documentUri)) {
		const message = `Cannot run ${commandName}: unsupported URI scheme "${documentUri.scheme}".`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
		return null;
	}
	try {
		const repoContext = await resolveRepoContext(documentUri);
		if (!repoContext) {
			const message = `Cannot run ${commandName}: file is not in a git repository.`;
			window.showErrorMessage(message);
			getWeldLogChannel().error(message);
			return null;
		}
		return repoContext;
	} catch (error: unknown) {
		const message = `Cannot run ${commandName}: ${getErrorMessage(error)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
		return null;
	}
}

async function handleOpenMergeEditor(file?: GitFile) {
	const documentUri = getTargetDocumentUri(file);
	if (!documentUri) {
		return;
	}
	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"open merge editor",
	);
	if (!repoContext) {
		return;
	}
	commands.executeCommand("git.openMergeEditor", repoContext.uri);
}

async function handleOpenMeldDiff(file?: GitFile) {
	const documentUri = getTargetDocumentUri(file);
	if (!documentUri) {
		return;
	}
	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"open Weld diff",
	);
	if (!repoContext) {
		return;
	}
	commands.executeCommand(
		"vscode.openWith",
		repoContext.uri,
		MeldCustomEditorProvider.viewType,
	);
}

function handleOpenConflictedFile(file: GitFile) {
	if (!isSupportedScheme(file.uri)) {
		const message = `Cannot open conflicted file: unsupported URI scheme "${file.uri.scheme}".`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
		return;
	}
	window.showTextDocument(file.uri);
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
	const documentUri = getTargetDocumentUri(file);
	if (!documentUri) {
		window.showErrorMessage("No active text editor found.");
		return;
	}

	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"Weld auto-merge",
	);
	if (!repoContext) {
		return;
	}

	try {
		const [baseContent, localContent, remoteContent] = await Promise.all([
			getGitFileContent(
				repoContext.rootFsPath,
				repoContext.relativePath,
				1,
			),
			getGitFileContent(
				repoContext.rootFsPath,
				repoContext.relativePath,
				2,
			),
			getGitFileContent(
				repoContext.rootFsPath,
				repoContext.relativePath,
				3,
			),
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
		const message = `Weld Auto-Merge Error: ${getErrorMessage(e)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
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
					await commands.executeCommand(
						"meld-auto-merge.autoMerge",
						file,
					);
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

async function handleCheckoutConflicted(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const documentUri = getTargetDocumentUri(file);
	if (!documentUri) {
		return;
	}
	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"checkout conflicted file",
	);
	if (!repoContext) {
		return;
	}

	const confirm = await window.showWarningMessage(
		`Are you sure you want to checkout the conflicted version of ${repoContext.relativePath} (-m)? This will overwrite your current file.`,
		{ modal: true },
		"Yes",
	);
	if (confirm !== "Yes") {
		return;
	}

	try {
		await execGit(
			["checkout", "-m", "--", repoContext.relativePath],
			repoContext.rootFsPath,
		);
		MeldCustomEditorProvider.onRequestRefresh.fire(documentUri);
		window.showInformationMessage(
			`Checked out conflicted version of ${repoContext.relativePath}`,
		);
		conflictedFilesProvider.refresh();
	} catch (e: unknown) {
		const message = `Checkout failed: ${getErrorMessage(e)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
	}
}

async function handleRerereForget(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const documentUri = getTargetDocumentUri(file);
	if (!documentUri) {
		return;
	}
	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"rerere forget",
	);
	if (!repoContext) {
		return;
	}

	const confirm = await window.showWarningMessage(
		`Are you sure you want to forget the recorded rerere resolution for ${repoContext.relativePath}?`,
		{ modal: true },
		"Yes",
	);
	if (confirm !== "Yes") {
		return;
	}

	try {
		await execGit(
			["rerere", "forget", "--", repoContext.relativePath],
			repoContext.rootFsPath,
		);
		window.showInformationMessage(
			`Forgot recorded resolution for ${repoContext.relativePath}`,
		);
		conflictedFilesProvider.refresh();
	} catch (e: unknown) {
		const message = `Rerere forget failed: ${getErrorMessage(e)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
	}
}

async function handleSmartAdd(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	let documentUri: Uri | null = null;
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
	if (!documentUri) {
		return;
	}

	const unresolvedReasons = getUnresolvedReasons(text);
	if (unresolvedReasons.length > 0) {
		window.showErrorMessage(
			`Cannot add file: file contains ${unresolvedReasons.join(" and ")}.`,
		);
		return false;
	}

	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"git add resolved file",
	);
	if (!repoContext) {
		return;
	}

	try {
		await execGit(
			["add", "--", repoContext.relativePath],
			repoContext.rootFsPath,
		);
		window.showInformationMessage(
			`Successfully added ${repoContext.relativePath}`,
		);
		conflictedFilesProvider.refresh();
		return true;
	} catch (e: unknown) {
		const message = `Git Add failed: ${getErrorMessage(e)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
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
		commands.registerCommand("meld-auto-merge.refreshConflicted", () => {
			conflictedFilesProvider.refresh();
		}),
		commands.registerCommand(
			"meld-auto-merge.openConflictedFile",
			(file: GitFile) => handleOpenConflictedFile(file),
		),
		commands.registerCommand(
			"meld-auto-merge.openMergeEditor",
			(file?: GitFile) => handleOpenMergeEditor(file),
		),
		commands.registerCommand(
			"meld-auto-merge.openMeldDiff",
			(file?: GitFile) => handleOpenMeldDiff(file),
		),
		commands.registerCommand(
			"meld-auto-merge.autoMerge",
			(file?: GitFile) => handleAutoMerge(file, conflictedFilesProvider),
		),
		commands.registerCommand("meld-auto-merge.autoMergeAll", () =>
			handleAutoMergeAll(conflictedFilesProvider),
		),
		commands.registerCommand(
			"meld-auto-merge.checkoutConflicted",
			(file?: GitFile) =>
				handleCheckoutConflicted(file, conflictedFilesProvider),
		),
		commands.registerCommand(
			"meld-auto-merge.rerereForget",
			(file?: GitFile) =>
				handleRerereForget(file, conflictedFilesProvider),
		),
		commands.registerCommand("meld-auto-merge.smartAdd", (file?: GitFile) =>
			handleSmartAdd(file, conflictedFilesProvider),
		),
	);
}

async function setupWatchers(
	context: ExtensionContext,
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<void> {
	const trackedRepositories = await getTrackedRepositories();
	for (const trackedRepository of trackedRepositories) {
		registerConflictWatchersForRepository(
			context,
			conflictedFilesProvider,
			trackedRepository,
		);
	}

	context.subscriptions.push(
		workspace.onDidSaveTextDocument(() => {
			conflictedFilesProvider.refresh();
		}),
	);
}

// The shape of `extensions.getExtension(...).exports` for this extension.
// Kept minimal on purpose: currently only integration tests consume this API,
// but each entry is a real, reusable operation against the live extension
// state (not a test-only backdoor).
export interface WeldExtensionApi {
	setInitialConflictContent: typeof MeldCustomEditorProvider.setInitialConflictContent;
}

export async function activate(
	context: ExtensionContext,
): Promise<WeldExtensionApi> {
	const logChannel = initializeWeldLogChannel();
	context.subscriptions.push(logChannel);
	const conflictedFilesProvider = new ConflictedFilesProvider();
	registerViews(context, conflictedFilesProvider);
	registerCommands(context, conflictedFilesProvider);
	await setupWatchers(context, conflictedFilesProvider);
	return {
		setInitialConflictContent:
			MeldCustomEditorProvider.setInitialConflictContent,
	};
}

export function deactivate() {
	// Cleanup if needed
}
