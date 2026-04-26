// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	commands,
	type ExtensionContext,
	ProgressLocation,
	Range,
	Uri,
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
	type GitApiRepository,
	getGitApi,
	isSupportedScheme,
	type RepoContext,
	resolveRepoContext,
} from "./repoContext.ts";
import { ConflictedFilesProvider, type GitFile } from "./treeView.ts";
import { MeldCustomEditorProvider } from "./webview/meldWebviewPanel.ts";

const lastConflictedFilesPerRepo: Map<string, Set<string>> = new Map();
function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const messages: string[] = [];
		const seen = new Set<unknown>();
		let current: unknown = error;
		while (current instanceof Error && !seen.has(current)) {
			seen.add(current);
			messages.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
		}
		if (current !== undefined && !seen.has(current)) {
			messages.push(String(current));
		}
		return messages.join(" -> caused by: ");
	}
	return String(error);
}

function showExceptionMessage(context: string, exception: unknown): void {
	if (exception instanceof Error) {
		const details: string[] = [];
		const messages: string[] = [];
		const seen = new Set<unknown>();
		let current: unknown = exception;
		while (current instanceof Error) {
			seen.add(current);
			messages.push(current.message);
			// Look for stderr specifically
			if (
				"stderr" in current &&
				typeof current.stderr === "string" &&
				current.stderr
			) {
				details.push(current.stderr);
			}
			current = (current as Error & { cause?: unknown }).cause;
		}
		if (current !== undefined && !seen.has(current)) {
			messages.push(String(current));
		}
		const message = `${context}: ${messages.join(" -> caused by: ")}`;
		//window.showErrorMessage(message, { detail: details.join("\n\n") });
		window.showErrorMessage(`${message} \n${details.join("\n")}`);
		getWeldLogChannel().error(message);
	} else {
		const message = `${context}: ${String(exception)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
	}
}

async function notifyIfNewConflicts(
	repoKey: string,
	repository: GitApiRepository,
) {
	const currentConflicts = await getConflictedFiles(repository);
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
	repository: GitApiRepository;
}

function getTrackedRepositories(): TrackedRepository[] {
	const workspaceFolders = workspace.workspaceFolders;
	if (!workspaceFolders) {
		return [];
	}
	const gitApi = getGitApi();
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
			repository,
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
				trackedRepository.repository,
			);
			const stateKey =
				await MeldCustomEditorProvider.getCurrentConflictStateKey(
					trackedRepository.repository,
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

	const stateChangeSubscription =
		trackedRepository.repository.state.onDidChange(() => {
			refresh();
		});
	context.subscriptions.push(stateChangeSubscription);
	doRefresh().catch((error: unknown) => {
		getWeldLogChannel().error(
			`Initial watcher refresh failed for ${trackedRepository.rootFsPath}: ${getErrorMessage(error)}`,
		);
	});
}

async function getGitFileContent(
	repository: GitApiRepository,
	relativeFilePath: string,
	stage: number,
): Promise<string> {
	try {
		return await repository.show(`:${stage}`, relativeFilePath);
	} catch (error: unknown) {
		const reason = getErrorMessage(error);
		throw new Error(
			`Could not get git content for stage ${stage} of ${relativeFilePath}. Is it in conflict? ${reason}`,
			{ cause: error },
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

// Runs Weld's three-way merge for a single conflicted file and writes the
// result back through a VS Code WorkspaceEdit. Throws on any failure so both
// the single-file command and the batch "auto-merge all" flow can surface the
// real reason instead of swallowing it.
async function performAutoMerge(
	repoContext: RepoContext,
	documentUri: Uri,
): Promise<void> {
	const [baseContent, localContent, remoteContent] = await Promise.all([
		getGitFileContent(repoContext.repository, repoContext.relativePath, 1),
		getGitFileContent(repoContext.repository, repoContext.relativePath, 2),
		getGitFileContent(repoContext.repository, repoContext.relativePath, 3),
	]);

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
		throw new Error(
			`Merge engine produced no text for ${repoContext.relativePath}.`,
		);
	}

	const document = await workspace.openTextDocument(documentUri);
	const fullRange = new Range(
		document.positionAt(0),
		document.positionAt(document.getText().length),
	);

	const edit = new WorkspaceEdit();
	edit.replace(documentUri, fullRange, finalMergedText);
	const applied = await workspace.applyEdit(edit);
	if (!applied) {
		throw new Error(
			`Failed to apply merged text to ${repoContext.relativePath}.`,
		);
	}
}

async function handleAutoMerge(
	file: GitFile | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const documentUri = getTargetDocumentUri(file);
	if (!documentUri) {
		throw new Error("Weld auto-merge: no active text editor.");
	}

	const repoContext = await resolveCommandRepoContext(
		documentUri,
		"Weld auto-merge",
	);
	if (!repoContext) {
		return;
	}

	await performAutoMerge(repoContext, documentUri);
	conflictedFilesProvider.refresh();
}

interface ConflictedFileEntry {
	repository: GitApiRepository;
	rootUri: Uri;
	relativePath: string;
	uri: Uri;
}

async function collectConflictedFilesAcrossRepositories(): Promise<
	ConflictedFileEntry[]
> {
	const trackedRepositories = await getTrackedRepositories();
	const perRepositoryEntries = await Promise.all(
		trackedRepositories.map(async (tracked) => {
			const relativePaths = await getConflictedFiles(tracked.repository);
			return relativePaths.map<ConflictedFileEntry>((relativePath) => {
				const segments = relativePath
					.split("/")
					.filter((segment) => segment.length > 0);
				return {
					repository: tracked.repository,
					rootUri: tracked.rootUri,
					relativePath,
					uri: Uri.joinPath(tracked.rootUri, ...segments),
				};
			});
		}),
	);
	return perRepositoryEntries.flat();
}

// Auto-merges every conflicted file in every tracked repository. Logs every
// successful merge to the Weld output channel so a partial run still leaves a
// record of what changed, then fails fast on the first file that cannot be
// merged (rethrows with the failing file's name as context).
async function handleAutoMergeAll(
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<void> {
	const conflictedFiles = await collectConflictedFilesAcrossRepositories();
	if (conflictedFiles.length === 0) {
		window.showInformationMessage("No unmerged files to auto-merge.");
		return;
	}

	const log = getWeldLogChannel();
	let successCount = 0;
	const mergeEntryBuilder =
		(progress: { report: (value: { message?: string }) => void }) =>
		async (entry: ConflictedFileEntry): Promise<void> => {
			progress.report({ message: `Merging ${entry.relativePath}...` });
			const repoContext: RepoContext = {
				repository: entry.repository,
				rootUri: entry.rootUri,
				rootFsPath: entry.rootUri.fsPath,
				relativePath: entry.relativePath,
				uri: entry.uri,
			};
			try {
				await performAutoMerge(repoContext, entry.uri);
			} catch (error: unknown) {
				throw new Error(
					`Weld Auto-Merge All stopped at ${entry.relativePath} after ${successCount} successful merge(s): ${getErrorMessage(error)}`,
					{ cause: error },
				);
			}
			successCount++;
			log.info(`Weld Auto-Merge All: merged ${entry.relativePath}`);
		};
	try {
		await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: "Weld Auto-Merge All",
				cancellable: false,
			},
			async (progress) => {
				// Sequential chain: stop-on-first-failure is intentional, and
				// each merge must observe the previous one's applied edit
				// before starting.
				const mergeEntry = mergeEntryBuilder(progress);
				await conflictedFiles.reduce<Promise<void>>(
					(previous, entry) => previous.then(() => mergeEntry(entry)),
					Promise.resolve(),
				);
			},
		);
	} finally {
		if (successCount > 0) {
			conflictedFilesProvider.refresh();
		}
	}

	window.showInformationMessage(
		`Weld Auto-Merge All: merged ${successCount} file(s).`,
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
		await repoContext.repository.add([repoContext.uri.fsPath]);
		conflictedFilesProvider.refresh();
		return true;
	} catch (e: unknown) {
		showExceptionMessage("Git Add Failed", e);
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

// Shape of `extensions.getExtension(...).exports` for this extension. Kept
// minimal on purpose: every entry must be a real reusable operation against
// the live extension state. Do not add test-only hooks here; tests should
// exercise real command / event boundaries and mock at prototype / git-API
// level instead.
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
