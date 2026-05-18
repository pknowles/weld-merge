// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { relative, sep } from "node:path";
import {
	commands,
	type Disposable,
	type ExtensionContext,
	ProgressLocation,
	Range,
	Uri,
	WorkspaceEdit,
	window,
	workspace,
} from "vscode";
import {
	type ConflictState,
	describeConflictStatusEvidence,
	execGit,
	execGitWithInput,
	getUnresolvedReasons,
	readConflictState,
} from "./gitUtils.ts";
import { getWeldLogChannel, initializeWeldLogChannel } from "./log.ts";
import { GitTextMerger } from "./matchers/gitTextMerger.ts";
import {
	type ConflictedItem,
	conflictedItemFromUri,
	createConflictedItem,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	type GitApiChange,
	type GitApiRepository,
	type GitConflictStage,
	getGitApi,
	isSupportedScheme,
} from "./repoContext.ts";
import { ConflictedFilesProvider, GitFile } from "./treeView.ts";
import { extractConflictLabels } from "./webview/conflictLabels.ts";
import {
	buildInitialConflictedState,
	fetchConflictStages,
} from "./webview/diffPayload.ts";
import { MeldCustomEditorProvider } from "./webview/meldWebviewPanel.ts";

const lastConflictedFilesPerRepo: Map<string, Set<string>> = new Map();
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";
const REMOTE_SMOKE_TEST_SETTING = "remoteSmokeTest";
const LS_TREE_ENTRY_REGEX = /^(\d{6})\s+\S+\s+([0-9a-fA-F]+)\t/;
const CHECKOUT_MISSING_STAGES_REGEX =
	/path ['"].+['"] does not have all necessary versions/;

interface TreeEntry {
	mode: string;
	objectId: string;
}

interface UriCommandArg {
	uri: Uri;
}

interface RemoteSmokeTestOpenResult {
	uri: string;
	command: string;
	stages: {
		base: string;
		local: string;
		remote: string;
	};
	initialState: {
		workingContent: string;
		reconstructedContent: string | null;
	};
}

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

function notifyIfNewConflicts(repoKey: string, repository: GitApiRepository) {
	const currentConflicts = repository.state.mergeChanges.map((change) =>
		change.uri.toString(),
	);
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

async function refreshRepo(
	repo: GitApiRepository,
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<void> {
	conflictedFilesProvider.refresh();
	await notifyIfNewConflicts(repo.rootUri.toString(), repo);
	const stateKey =
		await MeldCustomEditorProvider.getCurrentConflictStateKey(repo);
	MeldCustomEditorProvider.onConflictStateChanged.fire({
		repoUri: repo.rootUri,
		stateKey,
	});
}

function watchRepo(
	repo: GitApiRepository,
	conflictedFilesProvider: ConflictedFilesProvider,
): Disposable {
	let timer: NodeJS.Timeout | undefined;
	const scheduleRefresh = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			refreshRepo(repo, conflictedFilesProvider).catch(
				(error: unknown) => {
					getWeldLogChannel().error(
						`Refresh failed for ${repo.rootUri}: ${getErrorMessage(error)}`,
					);
				},
			);
		}, 50);
	};
	scheduleRefresh();
	const sub = repo.state.onDidChange(scheduleRefresh);
	return {
		dispose: () => {
			clearTimeout(timer);
			sub.dispose();
		},
	};
}

async function getGitFileContent(
	repository: GitApiRepository,
	file: Uri,
	stage: number,
): Promise<string> {
	try {
		return await repository.show(`:${stage}`, file.fsPath);
	} catch (error: unknown) {
		const reason = getErrorMessage(error);
		throw new Error(
			`Could not get git content for stage ${stage} of ${file}. Is it in conflict? ${reason}`,
			{ cause: error },
		);
	}
}

function isUriCommandArg(value: unknown): value is UriCommandArg {
	return (
		typeof value === "object" &&
		value !== null &&
		"uri" in value &&
		(value as { uri: unknown }).uri instanceof Uri
	);
}

function getActiveDocumentUri(): Uri | null {
	const editor = window.activeTextEditor;
	if (!editor) {
		return null;
	}
	if (editor.document.isUntitled) {
		return null;
	}
	return editor.document.uri;
}

async function resolveConflictedItemFromUri(
	documentUri: Uri,
	commandName: string,
): Promise<ConflictedItem | null> {
	if (!isSupportedScheme(documentUri)) {
		const message = `Cannot run ${commandName}: unsupported URI scheme "${documentUri.scheme}".`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
		return null;
	}
	try {
		const conflictedItem = await conflictedItemFromUri(documentUri);
		if (!conflictedItem) {
			const message = `Cannot run ${commandName}: file is not in a git repository.`;
			window.showErrorMessage(message);
			getWeldLogChannel().error(message);
			return null;
		}
		return conflictedItem;
	} catch (error: unknown) {
		const message = `Cannot run ${commandName}: ${getErrorMessage(error)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
		return null;
	}
}

function resolveActiveEditorConflictedItem(
	commandName: string,
): Promise<ConflictedItem | null> {
	const documentUri = getActiveDocumentUri();
	if (!documentUri) {
		return Promise.resolve(null);
	}
	return resolveConflictedItemFromUri(documentUri, commandName);
}

function handleOpenMergeEditor(conflictedItem: ConflictedItem) {
	commands.executeCommand("git.openMergeEditor", conflictedItem.uri);
}

async function handleOpenMeldDiff(conflictedItem: ConflictedItem) {
	const conflictStatus = await conflictedItem.conflictStatus();
	if (conflictStatus.kind === "bothDeleted") {
		const diagnostic = await describeConflictStatusEvidence(conflictedItem);
		getWeldLogChannel().error(diagnostic);
		const choice = await window.showErrorMessage(
			`Unexpected conflict state for ${conflictedItem.uri.fsPath}: both sides deleted this file. Git should have auto-resolved this. See the Weld output channel for status diagnostics.`,
			"Show Weld Output",
		);
		if (choice === "Show Weld Output") {
			getWeldLogChannel().show();
		}
		return;
	}
	if (conflictStatus.kind === "deleteModify") {
		await MeldCustomEditorProvider.handleDeleteModifyConflict(
			conflictedItem,
			conflictStatus.remainingStage,
		);
		return;
	}
	commands.executeCommand(
		"vscode.openWith",
		conflictedItem.uri,
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

function getRepoRelativePath(rootPath: string, filePath: string): string {
	const repoRelativePath = relative(rootPath, filePath).split(sep).join("/");
	if (
		repoRelativePath.length === 0 ||
		repoRelativePath.startsWith("../") ||
		repoRelativePath === ".." ||
		repoRelativePath.includes("\n") ||
		repoRelativePath.includes("\t")
	) {
		throw new Error(`Cannot restore ${filePath}: invalid repository path.`);
	}
	return repoRelativePath;
}

function parseTreeEntry(
	output: string,
	ref: string,
	filePath: string,
): TreeEntry {
	const match = LS_TREE_ENTRY_REGEX.exec(output);
	if (!(match?.[1] && match[2])) {
		throw new Error(
			`Cannot restore ${filePath}: ${ref} has no tree entry.`,
		);
	}
	return { mode: match[1], objectId: match[2] };
}

async function readTreeEntry(
	ref: string,
	repoRelativePath: string,
	cwd: string,
	filePath: string,
): Promise<TreeEntry> {
	const output = await execGit(["ls-tree", ref, "--", repoRelativePath], cwd);
	return parseTreeEntry(output, ref, filePath);
}

function isCheckoutMissingStagesError(error: unknown): boolean {
	return CHECKOUT_MISSING_STAGES_REGEX.test(getErrorMessage(error));
}

async function restoreDeleteModifyConflict(
	repoContext: ConflictedItem,
	survivingRef: "HEAD" | ConflictState["otherRef"],
	survivingStage: GitConflictStage,
	mergeBase: string,
): Promise<void> {
	const { uri, rootUri } = repoContext;
	const filePath = uri.fsPath;
	const cwd = rootUri.fsPath;
	const repoRelativePath = getRepoRelativePath(cwd, filePath);
	const [baseEntry, survivingEntry] = await Promise.all([
		readTreeEntry(mergeBase, repoRelativePath, cwd, filePath),
		readTreeEntry(survivingRef, repoRelativePath, cwd, filePath),
	]);

	await execGit(["checkout", survivingRef, "--", repoRelativePath], cwd);
	await execGitWithInput(
		["update-index", "--index-info"],
		cwd,
		[
			`0 ${ZERO_OBJECT_ID}\t${repoRelativePath}`,
			`${baseEntry.mode} ${baseEntry.objectId} 1\t${repoRelativePath}`,
			`${survivingEntry.mode} ${survivingEntry.objectId} ${survivingStage}\t${repoRelativePath}`,
			"",
		].join("\n"),
	);
}

// Runs Weld's three-way merge for a single conflicted file and writes the
// result back through a VS Code WorkspaceEdit. Throws on any failure so both
// the single-file command and the batch "auto-merge all" flow can surface the
// real reason instead of swallowing it.
async function performAutoMerge(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
): Promise<void> {
	const [baseContent, localContent, remoteContent] = await Promise.all([
		getGitFileContent(conflictedItem.repository, conflictedItem.uri, 1),
		getGitFileContent(conflictedItem.repository, conflictedItem.uri, 2),
		getGitFileContent(conflictedItem.repository, conflictedItem.uri, 3),
	]);

	const merger = new GitTextMerger();
	const localLines = localContent.split("\n");
	const baseLines = baseContent.split("\n");
	const remoteLines = remoteContent.split("\n");

	const sequences = [localLines, baseLines, remoteLines];
	merger.initialize(sequences, sequences);

	const finalMergedText = merger.merge3FilesGit(true);

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
			`Failed to apply merged text to ${conflictedItem.uri}.`,
		);
	}
}

async function handleAutoMerge(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	await performAutoMerge(conflictedItem, documentUri);
	conflictedFilesProvider.refresh();
}

interface ConflictedFileEntry {
	repository: GitApiRepository;
	change: GitApiChange;
}

function collectConflictedFilesAcrossRepositories(): ConflictedFileEntry[] {
	const repos = getGitApi().repositories.filter((r) =>
		isSupportedScheme(r.rootUri),
	);
	return repos.flatMap((repo) =>
		repo.state.mergeChanges.map<ConflictedFileEntry>((change) => ({
			repository: repo,
			change,
		})),
	);
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
			progress.report({ message: `Merging ${entry.change.uri}...` });
			const repoContext = createConflictedItem(
				entry.repository,
				entry.change,
			);
			try {
				await performAutoMerge(repoContext, entry.change.uri);
			} catch (error: unknown) {
				throw new Error(
					`Weld Auto-Merge All stopped at ${entry.change.uri} after ${successCount} successful merge(s): ${getErrorMessage(error)}`,
					{ cause: error },
				);
			}
			successCount++;
			log.info(`Weld Auto-Merge All: merged ${entry.change.uri}`);
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
	conflictedItem: ConflictedItem,
	documentUri: Uri,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const confirm = await window.showWarningMessage(
		`Are you sure you want to checkout the conflicted version of ${conflictedItem.uri} (-m)? This will overwrite your current file.`,
		{ modal: true },
		"Yes",
	);
	if (confirm !== "Yes") {
		return;
	}

	try {
		await restoreConflictedFile(conflictedItem);
		MeldCustomEditorProvider.onRequestRefresh.fire(documentUri);
		window.showInformationMessage(
			`Checked out conflicted version of ${conflictedItem.uri}`,
		);
		conflictedFilesProvider.refresh();
	} catch (e: unknown) {
		const message = `Checkout failed: ${getErrorMessage(e)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
	}
}

// git checkout -m fails for delete/modify conflicts because one index stage is
// absent. Instead: try checkout -m first (works for both-modified). If that
// fails, detect the deleted side, restore the surviving content, and recreate
// the unmerged index stages so Git still reports the delete/modify conflict.
async function restoreConflictedFile(
	repoContext: ConflictedItem,
): Promise<void> {
	const { uri, rootUri, repository } = repoContext;
	const filePath = uri.fsPath;
	const cwd = rootUri.fsPath;
	try {
		await execGit(["checkout", "-m", "--", filePath], cwd);
		return;
	} catch (error: unknown) {
		if (!isCheckoutMissingStagesError(error)) {
			throw new Error(
				`Cannot restore ${filePath}: checkout -m failed unexpectedly: ${getErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}
	const conflictState = await readConflictState(repository);
	if (!conflictState) {
		throw new Error(
			`Cannot restore ${filePath}: no active merge/cherry-pick/rebase state found.`,
		);
	}
	const { otherRef } = conflictState;
	const mergeBase = await repository.getMergeBase("HEAD", otherRef);
	const localDiff = await execGit(
		["diff", "--name-status", mergeBase, "HEAD", "--", filePath],
		cwd,
	);
	if (localDiff.trimStart().startsWith("D")) {
		await restoreDeleteModifyConflict(
			repoContext,
			otherRef,
			GIT_STAGE_REMOTE,
			mergeBase,
		);
		return;
	}
	const remoteDiff = await execGit(
		["diff", "--name-status", mergeBase, otherRef, "--", filePath],
		cwd,
	);
	if (remoteDiff.trimStart().startsWith("D")) {
		await restoreDeleteModifyConflict(
			repoContext,
			"HEAD",
			GIT_STAGE_LOCAL,
			mergeBase,
		);
		return;
	}
	throw new Error(
		`Cannot restore ${filePath}: checkout -m failed but neither side appears to have deleted it.`,
	);
}

async function handleRerereForget(
	conflictedItem: ConflictedItem,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const confirm = await window.showWarningMessage(
		`Are you sure you want to forget the recorded rerere resolution for ${conflictedItem.uri}?`,
		{ modal: true },
		"Yes",
	);
	if (confirm !== "Yes") {
		return;
	}

	try {
		await execGit(
			["rerere", "forget", "--", conflictedItem.uri.fsPath],
			conflictedItem.rootUri.fsPath,
		);
		window.showInformationMessage(
			`Forgot recorded resolution for ${conflictedItem.uri}`,
		);
		conflictedFilesProvider.refresh();
	} catch (e: unknown) {
		const message = `Rerere forget failed: ${getErrorMessage(e)}`;
		window.showErrorMessage(message);
		getWeldLogChannel().error(message);
	}
}

async function handleSmartAdd(
	conflictedItem: ConflictedItem,
	text: string,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const unresolvedReasons = getUnresolvedReasons(text);
	if (unresolvedReasons.length > 0) {
		window.showErrorMessage(
			`Cannot add file: file contains ${unresolvedReasons.join(" and ")}.`,
		);
		return false;
	}

	try {
		await conflictedItem.repository.add([conflictedItem.uri.fsPath]);
		conflictedFilesProvider.refresh();
		return true;
	} catch (e: unknown) {
		showExceptionMessage("Git Add Failed", e);
		return false;
	}
}

async function readSavedDocument(uri: Uri): Promise<string> {
	const document = await workspace.openTextDocument(uri);
	await document.save();
	return document.getText();
}

async function handleTreeAutoMerge(
	file: GitFile,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	await handleAutoMerge(
		file.conflictedItem,
		file.uri,
		conflictedFilesProvider,
	);
}

async function handleActiveEditorAutoMerge(
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const documentUri = getActiveDocumentUri();
	if (!documentUri) {
		throw new Error("Weld auto-merge: no active text editor.");
	}
	const conflictedItem = await resolveConflictedItemFromUri(
		documentUri,
		"Weld auto-merge",
	);
	if (!conflictedItem) {
		return;
	}
	await handleAutoMerge(conflictedItem, documentUri, conflictedFilesProvider);
}

async function handleTreeCheckoutConflicted(
	file: GitFile,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	await handleCheckoutConflicted(
		file.conflictedItem,
		file.uri,
		conflictedFilesProvider,
	);
}

async function handleActiveEditorCheckoutConflicted(
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const documentUri = getActiveDocumentUri();
	if (!documentUri) {
		return;
	}
	const conflictedItem = await resolveConflictedItemFromUri(
		documentUri,
		"checkout conflicted file",
	);
	if (!conflictedItem) {
		return;
	}
	await handleCheckoutConflicted(
		conflictedItem,
		documentUri,
		conflictedFilesProvider,
	);
}

async function handleTreeSmartAdd(
	file: GitFile,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const text = await readSavedDocument(file.uri);
	return handleSmartAdd(file.conflictedItem, text, conflictedFilesProvider);
}

async function handleUriSmartAdd(
	target: UriCommandArg,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const text = await readSavedDocument(target.uri);
	const conflictedItem = await resolveConflictedItemFromUri(
		target.uri,
		"git add resolved file",
	);
	if (!conflictedItem) {
		return;
	}
	return handleSmartAdd(conflictedItem, text, conflictedFilesProvider);
}

async function handleActiveEditorSmartAdd(
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	const editor = window.activeTextEditor;
	if (!editor) {
		return;
	}
	if (editor.document.isUntitled) {
		return;
	}
	await editor.document.save();
	const conflictedItem = await resolveConflictedItemFromUri(
		editor.document.uri,
		"git add resolved file",
	);
	if (!conflictedItem) {
		return;
	}
	return handleSmartAdd(
		conflictedItem,
		editor.document.getText(),
		conflictedFilesProvider,
	);
}

async function handleOpenMergeEditorCommand(
	target: GitFile | UriCommandArg | undefined,
) {
	if (target instanceof GitFile) {
		handleOpenMergeEditor(target.conflictedItem);
		return;
	}
	if (isUriCommandArg(target)) {
		const conflictedItem = await resolveConflictedItemFromUri(
			target.uri,
			"open merge editor",
		);
		if (!conflictedItem) {
			return;
		}
		handleOpenMergeEditor(conflictedItem);
		return;
	}
	const conflictedItem =
		await resolveActiveEditorConflictedItem("open merge editor");
	if (!conflictedItem) {
		return;
	}
	handleOpenMergeEditor(conflictedItem);
}

async function handleOpenMeldDiffCommand(
	target: GitFile | UriCommandArg | undefined,
) {
	if (target instanceof GitFile) {
		await handleOpenMeldDiff(target.conflictedItem);
		return;
	}
	if (isUriCommandArg(target)) {
		const conflictedItem = await resolveConflictedItemFromUri(
			target.uri,
			"open Weld diff",
		);
		if (!conflictedItem) {
			return;
		}
		await handleOpenMeldDiff(conflictedItem);
		return;
	}
	const conflictedItem =
		await resolveActiveEditorConflictedItem("open Weld diff");
	if (!conflictedItem) {
		return;
	}
	await handleOpenMeldDiff(conflictedItem);
}

async function handleRerereForgetCommand(
	target: GitFile | UriCommandArg | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	if (target instanceof GitFile) {
		await handleRerereForget(
			target.conflictedItem,
			conflictedFilesProvider,
		);
		return;
	}
	if (isUriCommandArg(target)) {
		const conflictedItem = await resolveConflictedItemFromUri(
			target.uri,
			"rerere forget",
		);
		if (!conflictedItem) {
			return;
		}
		await handleRerereForget(conflictedItem, conflictedFilesProvider);
		return;
	}
	const conflictedItem =
		await resolveActiveEditorConflictedItem("rerere forget");
	if (!conflictedItem) {
		return;
	}
	await handleRerereForget(conflictedItem, conflictedFilesProvider);
}

function handleSmartAddCommand(
	target: GitFile | UriCommandArg | undefined,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	if (target instanceof GitFile) {
		return handleTreeSmartAdd(target, conflictedFilesProvider);
	}
	if (isUriCommandArg(target)) {
		return handleUriSmartAdd(target, conflictedFilesProvider);
	}
	return handleActiveEditorSmartAdd(conflictedFilesProvider);
}

async function openFirstConflictFromTreeForRemoteSmokeTest(
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<RemoteSmokeTestOpenResult> {
	const children = await conflictedFilesProvider.getChildren();
	const conflict = children.find(
		(item) =>
			item instanceof GitFile && item.contextValue === "conflictedFile",
	);
	if (!(conflict instanceof GitFile)) {
		throw new Error(
			"Remote smoke test could not find a conflicted tree item.",
		);
	}
	if (!conflict.command) {
		throw new Error(
			"Remote smoke test conflicted tree item has no command.",
		);
	}
	const args = conflict.command.arguments;
	if (!args) {
		throw new Error(
			"Remote smoke test conflicted tree item command has no arguments.",
		);
	}
	const [base, local, remote] = await Promise.all([
		getGitFileContent(conflict.conflictedItem.repository, conflict.uri, 1),
		getGitFileContent(conflict.conflictedItem.repository, conflict.uri, 2),
		getGitFileContent(conflict.conflictedItem.repository, conflict.uri, 3),
	]);
	const document = await workspace.openTextDocument(conflict.uri);
	const workingContent = document.getText();
	const labels = extractConflictLabels(workingContent);
	const reconstructedContent = labels
		? await buildInitialConflictedState(
				conflict.conflictedItem.rootUri,
				await fetchConflictStages(conflict.conflictedItem),
				labels,
			)
		: null;
	await commands.executeCommand(conflict.command.command, ...args);
	return {
		uri: conflict.uri.toString(),
		command: conflict.command.command,
		stages: {
			base,
			local,
			remote,
		},
		initialState: {
			workingContent,
			reconstructedContent,
		},
	};
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
			(target: GitFile | UriCommandArg | undefined) =>
				handleOpenMergeEditorCommand(target),
		),
		commands.registerCommand(
			"meld-auto-merge.openMeldDiff",
			(target: GitFile | UriCommandArg | undefined) =>
				handleOpenMeldDiffCommand(target),
		),
		commands.registerCommand(
			"meld-auto-merge.autoMerge",
			(target: GitFile | undefined) => {
				if (target instanceof GitFile) {
					return handleTreeAutoMerge(target, conflictedFilesProvider);
				}
				return handleActiveEditorAutoMerge(conflictedFilesProvider);
			},
		),
		commands.registerCommand("meld-auto-merge.autoMergeAll", () =>
			handleAutoMergeAll(conflictedFilesProvider),
		),
		commands.registerCommand(
			"meld-auto-merge.checkoutConflicted",
			(target: GitFile | undefined) => {
				if (target instanceof GitFile) {
					return handleTreeCheckoutConflicted(
						target,
						conflictedFilesProvider,
					);
				}
				return handleActiveEditorCheckoutConflicted(
					conflictedFilesProvider,
				);
			},
		),
		commands.registerCommand(
			"meld-auto-merge.rerereForget",
			(target: GitFile | UriCommandArg | undefined) =>
				handleRerereForgetCommand(target, conflictedFilesProvider),
		),
		commands.registerCommand(
			"meld-auto-merge.smartAdd",
			(target: GitFile | UriCommandArg | undefined) =>
				handleSmartAddCommand(target, conflictedFilesProvider),
		),
	);
	if (
		workspace
			.getConfiguration("weld")
			.get<boolean>(REMOTE_SMOKE_TEST_SETTING) === true
	) {
		context.subscriptions.push(
			commands.registerCommand(
				"meld-auto-merge.test.openFirstConflictFromTree",
				() =>
					openFirstConflictFromTreeForRemoteSmokeTest(
						conflictedFilesProvider,
					),
			),
		);
	}
}

function setupGitRepoWatchers(
	context: ExtensionContext,
	conflictedFilesProvider: ConflictedFilesProvider,
): void {
	const gitApi = getGitApi();
	const repoWatchers = new Map<string, Disposable>();

	const onRepoOpened = (repo: GitApiRepository) => {
		if (!isSupportedScheme(repo.rootUri)) {
			return;
		}
		const key = repo.rootUri.toString();
		if (repoWatchers.has(key)) {
			return;
		}
		repoWatchers.set(key, watchRepo(repo, conflictedFilesProvider));
	};

	const onRepoClosed = (repo: GitApiRepository) => {
		const key = repo.rootUri.toString();
		repoWatchers.get(key)?.dispose();
		repoWatchers.delete(key);
		lastConflictedFilesPerRepo.delete(key);
		conflictedFilesProvider.refresh();
	};

	for (const repo of gitApi.repositories) {
		onRepoOpened(repo);
	}

	context.subscriptions.push(
		gitApi.onDidOpenRepository(onRepoOpened),
		gitApi.onDidCloseRepository(onRepoClosed),
		workspace.onDidSaveTextDocument(() =>
			conflictedFilesProvider.refresh(),
		),
		{
			dispose: () => {
				for (const d of repoWatchers.values()) {
					d.dispose();
				}
			},
		},
	);
}

// Shape of `extensions.getExtension(...).exports` for this extension.
// MeldCustomEditorProvider is exposed so that tests can instantiate the
// bundled class rather than a source-imported copy, keeping all static
// fields (e.g. onConflictStateChanged) on the same module instance as the
// running extension.
export interface WeldExtensionApi {
	setInitialConflictContent: typeof MeldCustomEditorProvider.setInitialConflictContent;
	meldCustomEditorProvider: typeof MeldCustomEditorProvider;
	restoreConflictedFile: typeof restoreConflictedFile;
	conflictedFilesProvider: ConflictedFilesProvider;
}

export function activate(context: ExtensionContext): WeldExtensionApi {
	const logChannel = initializeWeldLogChannel();
	context.subscriptions.push(logChannel);
	const conflictedFilesProvider = new ConflictedFilesProvider();
	registerViews(context, conflictedFilesProvider);
	registerCommands(context, conflictedFilesProvider);
	setupGitRepoWatchers(context, conflictedFilesProvider);
	return {
		setInitialConflictContent:
			MeldCustomEditorProvider.setInitialConflictContent,
		meldCustomEditorProvider: MeldCustomEditorProvider,
		restoreConflictedFile,
		conflictedFilesProvider,
	};
}

export function deactivate() {
	// Cleanup if needed
}
