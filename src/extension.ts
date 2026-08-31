// Copyright (C) 2026 Pyarelal Knowles, GPL v2

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
import type { ConflictLocation } from "./agentConflicts.ts";
import { resolveConflictedItem } from "./agentConflicts.ts";
import { registerAgentTools } from "./agentTools.ts";
import { fetchConflictStages } from "./conflictSnapshot.ts";
import {
	type ConflictState,
	describeConflictStatusEvidence,
	execGit,
	execGitWithInput,
	getUnresolvedReasons,
	readConflictState,
	repositoryRelativePath,
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
	notifyRepositoryStateChanged,
	registerRepository,
	unregisterRepository,
} from "./repoContext.ts";
import { SubmoduleConflict } from "./submoduleConflict.ts";
import { ConflictedFilesProvider, GitFile } from "./treeView.ts";
import { extractConflictLabels } from "./webview/conflictLabels.ts";
import { buildInitialConflictedState } from "./webview/diffPayload.ts";
import { MeldCustomEditorProvider } from "./webview/meldWebviewPanel.ts";
import { SubmoduleConflictEditorProvider } from "./webview/submoduleConflictEditor.ts";

const lastConflictedFilesPerRepo: Map<string, Set<string>> = new Map();
// Per-repository content fingerprint of the last completed refreshRepo call.
// VS Code fires state.onDidChange multiple times during startup (e.g., once when
// the index first loads and again immediately after), producing identical state on
// consecutive calls. Without this dedup, both fires reach conflictedFilesProvider.refresh()
// and telemetry even though nothing changed — verified by the launch_telemetry test
// which requires <= 2 tree refreshes for 2 startup repositories.
const lastRefreshKeyPerRepo: Map<string, string> = new Map();
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";
const REMOTE_SMOKE_TEST_SETTING = "remoteSmokeTest";
const LAUNCH_TELEMETRY_SETTING = "launchTelemetry";
const LS_TREE_ENTRY_REGEX = /^(\d{6})\s+\S+\s+([0-9a-fA-F]+)\t/;
const CHECKOUT_MISSING_STAGES_REGEX =
	/path ['"].+['"] does not have all necessary versions/;

// Why refreshRepo was called. The set of reasons in a single invocation determines
// which downstream work is appropriate: firstStatusComplete triggers tree/conflict
// bookkeeping but must NOT notify editors (they get their initial snapshot from
// readyRepositoryForRoot()); repositoryStateChanged also notifies open editors so
// they refresh their live view. Keeping them distinct prevents a duplicate snapshot
// being posted to editors on every startup.
type RefreshRepoReason = "firstStatusComplete" | "repositoryStateChanged";

class WeldTelemetry {
	private readonly enabled: boolean;
	private treeRefreshes = 0;
	private treeGetChildrenCalls = 0;
	private refreshRepoCalls = 0;
	private conflictStateChangedEvents = 0;
	private repositoryStateChangedEvents = 0;
	private readonly refreshRepoReasons: Record<RefreshRepoReason, number> = {
		firstStatusComplete: 0,
		repositoryStateChanged: 0,
	};

	constructor(enabled: boolean) {
		this.enabled = enabled;
	}

	// Records extension-owned work from activation onward so launch tests can
	// inspect startup behavior after VS Code has already activated this extension.
	recordTreeRefresh(): void {
		if (!this.enabled) {
			return;
		}
		this.treeRefreshes += 1;
	}

	recordTreeGetChildren(): void {
		if (!this.enabled) {
			return;
		}
		this.treeGetChildrenCalls += 1;
	}

	recordRefreshRepo(reasons: readonly RefreshRepoReason[]): void {
		if (!this.enabled) {
			return;
		}
		this.refreshRepoCalls += 1;
		for (const reason of reasons) {
			this.refreshRepoReasons[reason] += 1;
		}
	}

	recordConflictStateChanged(): void {
		if (!this.enabled) {
			return;
		}
		this.conflictStateChangedEvents += 1;
	}

	recordRepositoryStateChanged(): void {
		if (!this.enabled) {
			return;
		}
		this.repositoryStateChangedEvents += 1;
	}

	snapshot(): WeldTelemetrySnapshot {
		return {
			treeRefreshes: this.treeRefreshes,
			treeGetChildrenCalls: this.treeGetChildrenCalls,
			refreshRepoCalls: this.refreshRepoCalls,
			conflictStateChangedEvents: this.conflictStateChangedEvents,
			repositoryStateChangedEvents: this.repositoryStateChangedEvents,
			refreshRepoReasons: { ...this.refreshRepoReasons },
		};
	}
}

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
	telemetry: WeldTelemetry,
	reasons: readonly RefreshRepoReason[],
): Promise<void> {
	const repoKey = repo.rootUri.toString();
	const stateKey =
		await MeldCustomEditorProvider.getCurrentConflictStateKey(repo);
	// Skip entirely when the conflict state has not changed since the last refresh.
	// VS Code fires state.onDidChange multiple times during startup with identical
	// state, which would otherwise produce extra tree refreshes and telemetry counts.
	// The launch_telemetry test verifies this bound: <= 2 tree refreshes for 2 repos.
	const refreshKey = repositoryRefreshKey(repo, stateKey);
	const previousRefreshKey = lastRefreshKeyPerRepo.get(repoKey);
	if (previousRefreshKey === refreshKey) {
		return;
	}
	lastRefreshKeyPerRepo.set(repoKey, refreshKey);
	// Skip the very first call when the repository has no conflicts at all.
	// This prevents counting an empty-state open as a meaningful event.
	if (previousRefreshKey === undefined && refreshKeyIsEmpty(repo, stateKey)) {
		return;
	}
	telemetry.recordRefreshRepo(reasons);
	conflictedFilesProvider.refresh();
	await notifyIfNewConflicts(repoKey, repo);
	telemetry.recordConflictStateChanged();
	MeldCustomEditorProvider.onConflictStateChanged.fire({
		repoUri: repo.rootUri,
		stateKey,
	});
	// Only notify open editors when the repository state genuinely changed.
	// On firstStatusComplete, editors receive their initial snapshot by awaiting
	// readyRepositoryForRoot() inside the "ready" webview message handler.
	// Firing notifyRepositoryStateChanged here too would post a duplicate snapshot
	// with identical content immediately after startup, before any real change.
	if (reasons.includes("repositoryStateChanged")) {
		telemetry.recordRepositoryStateChanged();
		notifyRepositoryStateChanged(repo);
	}
}

// Full content fingerprint of a repository's conflict state. Two consecutive
// calls with the same mergeChanges and stateKey return the same string, so
// refreshRepo can skip duplicate work when VS Code fires onDidChange repeatedly.
function repositoryRefreshKey(
	repo: GitApiRepository,
	stateKey: string | undefined,
): string {
	const mergeChangesKey = repo.state.mergeChanges
		.map((change) => `${change.uri.toString()}:${change.status}`)
		.sort()
		.join("\n");
	return `${stateKey ?? "no-conflict-state"}\n${mergeChangesKey}`;
}

function refreshKeyIsEmpty(
	repo: GitApiRepository,
	stateKey: string | undefined,
): boolean {
	return stateKey === undefined && repo.state.mergeChanges.length === 0;
}

function watchRepo(
	repo: GitApiRepository,
	conflictedFilesProvider: ConflictedFilesProvider,
	telemetry: WeldTelemetry,
): Disposable {
	let timer: NodeJS.Timeout | undefined;
	let firstStatusComplete = false;
	const pendingReasons = new Set<RefreshRepoReason>();
	const scheduleRefresh = (reason: RefreshRepoReason) => {
		pendingReasons.add(reason);
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			const reasons = [...pendingReasons];
			pendingReasons.clear();
			refreshRepo(
				repo,
				conflictedFilesProvider,
				telemetry,
				reasons,
			).catch((error: unknown) => {
				getWeldLogChannel().error(
					`Refresh failed for ${repo.rootUri}: ${getErrorMessage(error)}`,
				);
			});
		}, 50);
	};

	const recordFirstStatusComplete = () => {
		firstStatusComplete = true;
		scheduleRefresh("firstStatusComplete");
	};

	if (repo.state.mergeChanges.length > 0) {
		recordFirstStatusComplete();
	}

	// VS Code fires state.onDidChange after repository status has produced real
	// state. Use that event as the first-refresh boundary so Weld does not add a
	// second Git status run or broadcast an empty repository-open state.
	const sub = repo.state.onDidChange(() => {
		if (!firstStatusComplete) {
			recordFirstStatusComplete();
			return;
		}
		scheduleRefresh("repositoryStateChanged");
	});
	return {
		dispose: () => {
			clearTimeout(timer);
			sub.dispose();
		},
	};
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

function isSubmoduleTreeItem(file: GitFile): boolean {
	return (
		file.contextValue === "conflictedSubmodule" ||
		file.contextValue === "resolvedSubmodule"
	);
}

async function handleOpenSubmoduleConflict(file: GitFile): Promise<void> {
	await SubmoduleConflictEditorProvider.open(
		file.conflictedItem.repository,
		file.uri,
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
	const repoRelativePath = repositoryRelativePath(rootUri, uri);
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

interface AutoMergeResult {
	remainingConflicts: number;
}

// Runs Weld's three-way merge for a single conflicted file and writes the
// result back through a VS Code WorkspaceEdit. Throws on any failure so both
// the single-file command and the batch "auto-merge all" flow can surface the
// real reason instead of swallowing it. Returns the number of conflicts the
// merge could not resolve (left as <<<<<<< markers in the document). This is
// differ.conflicts (populated by initialize()'s three-way diff, one entry per
// conflicting hunk), not differ.unresolved (populated by merge3FilesGit, one
// entry per marker *line* — the same distinction agentConflicts.ts's
// conflictCount draws via conflictChangeIndexes vs. individual DiffChunks).
async function performAutoMerge(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
): Promise<AutoMergeResult> {
	// Reuses fetchConflictStages rather than fetching git stage 1 directly:
	// a both-added conflict has no stage 1 (no common ancestor), and
	// git show :1: throws for it. fetchConflictStages already knows this
	// and substitutes "" for base, matching the empty-base convention
	// createThreeWayComparison relies on elsewhere.
	const {
		base: baseContent,
		local: localContent,
		remote: remoteContent,
	} = await fetchConflictStages(conflictedItem);

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
	return { remainingConflicts: merger.differ.conflicts.length };
}

async function handleAutoMerge(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	await performAutoMerge(conflictedItem, documentUri);
	conflictedFilesProvider.refresh();
}

// Auto-merges a single conflicted file identified by the agent tool's
// repository-root/path location, reusing the same merge logic as the
// single-file command and the "auto-merge all" batch. Refreshes the tree so
// the UI reflects the change alongside the agent's own result.
async function handleApplyAutomergeSingle(
	location: ConflictLocation,
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<AutoMergeResult> {
	const conflictedItem = resolveConflictedItem(location);
	const result = await performAutoMerge(conflictedItem, conflictedItem.uri);
	conflictedFilesProvider.refresh();
	return result;
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

interface AutoMergeAllResult {
	mergedCount: number;
	totalCount: number;
}

// Auto-merges every conflicted file in every tracked repository. Fails fast on
// the first file that cannot be merged (rethrows with the failing file's name
// and successful count as context). Returns merged/total counts for the caller
// to log or display.
async function handleAutoMergeAll(
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<AutoMergeAllResult> {
	const conflictedFiles = collectConflictedFilesAcrossRepositories();
	const totalCount = conflictedFiles.length;
	if (totalCount === 0) {
		return { mergedCount: 0, totalCount: 0 };
	}

	let mergedCount = 0;
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
					`Weld Auto-Merge All stopped at ${entry.change.uri} after ${mergedCount} successful merge(s): ${getErrorMessage(error)}`,
					{ cause: error },
				);
			}
			mergedCount++;
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
		if (mergedCount > 0) {
			getWeldLogChannel().info(
				`Weld Auto-Merge All: merged ${mergedCount} of ${totalCount} file(s).`,
			);
			conflictedFilesProvider.refresh();
		}
	}

	return { mergedCount, totalCount };
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

async function handleCheckoutSubmoduleConflict(
	file: GitFile,
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<void> {
	const confirm = await window.showWarningMessage(
		`Are you sure you want to restore the conflicted submodule index entries for ${file.uri}?`,
		{ modal: true },
		"Yes",
	);
	if (confirm !== "Yes") {
		return;
	}
	try {
		await SubmoduleConflict.restore(
			file.conflictedItem.repository,
			file.uri,
		);
		window.showInformationMessage(
			`Restored conflicted submodule ${file.uri}`,
		);
		conflictedFilesProvider.refresh();
		notifyRepositoryStateChanged(file.conflictedItem.repository);
	} catch (error: unknown) {
		const message = `Submodule restore failed: ${getErrorMessage(error)}`;
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
	if (isSubmoduleTreeItem(file)) {
		window.showErrorMessage(
			"Submodule conflicts cannot be auto-merged as text. Open the submodule resolver from the tree instead.",
		);
		return;
	}
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
	if (isSubmoduleTreeItem(file)) {
		await handleCheckoutSubmoduleConflict(file, conflictedFilesProvider);
		return;
	}
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
		if (isSubmoduleTreeItem(target)) {
			await handleOpenSubmoduleConflict(target);
			return;
		}
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
	// One fetch for both uses below: stages themselves and the reconstructed
	// state. Also avoids performAutoMerge's stage-1 bug for both-added
	// conflicts, which have no base stage to show.
	const stages = await fetchConflictStages(conflict.conflictedItem);
	const { base, local, remote } = stages;
	const document = await workspace.openTextDocument(conflict.uri);
	const workingContent = document.getText();
	const labels = extractConflictLabels(workingContent);
	const reconstructedContent = labels
		? await buildInitialConflictedState(
				conflict.conflictedItem.rootUri,
				stages,
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
	context.subscriptions.push(
		SubmoduleConflictEditorProvider.register(
			context,
			conflictedFilesProvider,
		),
	);
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
		commands.registerCommand("meld-auto-merge.autoMergeAll", async () => {
			const { mergedCount, totalCount } = await handleAutoMergeAll(
				conflictedFilesProvider,
			);
			if (totalCount === 0) {
				window.showInformationMessage(
					"No unmerged files to auto-merge.",
				);
				return;
			}
			window.showInformationMessage(
				`Weld Auto-Merge All: merged ${mergedCount} file(s).`,
			);
		}),
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
	telemetry: WeldTelemetry,
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
		registerRepository(gitApi, repo);
		repoWatchers.set(
			key,
			watchRepo(repo, conflictedFilesProvider, telemetry),
		);
	};

	const onRepoClosed = (repo: GitApiRepository) => {
		const key = repo.rootUri.toString();
		repoWatchers.get(key)?.dispose();
		repoWatchers.delete(key);
		unregisterRepository(repo.rootUri);
		lastConflictedFilesPerRepo.delete(key);
		lastRefreshKeyPerRepo.delete(key);
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
// Custom editor classes and repository notifications are exposed so VS Code
// host tests observe the bundled extension instance instead of a source-imported
// copy with separate static fields or event emitters.
export interface WeldExtensionApi {
	setInitialConflictContent: typeof MeldCustomEditorProvider.setInitialConflictContent;
	meldCustomEditorProvider: typeof MeldCustomEditorProvider;
	submoduleConflictEditorProvider: typeof SubmoduleConflictEditorProvider;
	restoreConflictedFile: typeof restoreConflictedFile;
	conflictedFilesProvider: ConflictedFilesProvider;
	notifyRepositoryStateChanged: typeof notifyRepositoryStateChanged;
	getTelemetrySnapshot(): WeldTelemetrySnapshot;
}

export interface WeldTelemetrySnapshot {
	readonly treeRefreshes: number;
	readonly treeGetChildrenCalls: number;
	readonly refreshRepoCalls: number;
	readonly conflictStateChangedEvents: number;
	readonly repositoryStateChangedEvents: number;
	readonly refreshRepoReasons: Readonly<Record<RefreshRepoReason, number>>;
}

export function activate(context: ExtensionContext): WeldExtensionApi {
	const logChannel = initializeWeldLogChannel();
	context.subscriptions.push(logChannel);
	const telemetry = new WeldTelemetry(
		workspace
			.getConfiguration("weld")
			.get<boolean>(LAUNCH_TELEMETRY_SETTING) === true,
	);
	const conflictedFilesProvider = new ConflictedFilesProvider();
	context.subscriptions.push(
		conflictedFilesProvider.onDidRefresh(() =>
			telemetry.recordTreeRefresh(),
		),
		conflictedFilesProvider.onDidGetChildren(() =>
			telemetry.recordTreeGetChildren(),
		),
	);
	registerViews(context, conflictedFilesProvider);
	registerCommands(context, conflictedFilesProvider);
	setupGitRepoWatchers(context, conflictedFilesProvider, telemetry);
	registerAgentTools(
		context,
		async () => {
			const { mergedCount, totalCount } = await handleAutoMergeAll(
				conflictedFilesProvider,
			);
			return totalCount === 0
				? "No conflicted files found."
				: `Merged ${mergedCount} of ${totalCount} file(s).`;
		},
		(location) =>
			handleApplyAutomergeSingle(location, conflictedFilesProvider),
	);
	return {
		setInitialConflictContent:
			MeldCustomEditorProvider.setInitialConflictContent,
		meldCustomEditorProvider: MeldCustomEditorProvider,
		submoduleConflictEditorProvider: SubmoduleConflictEditorProvider,
		restoreConflictedFile,
		conflictedFilesProvider,
		notifyRepositoryStateChanged,
		getTelemetrySnapshot: () => telemetry.snapshot(),
	};
}

export function deactivate() {
	// Cleanup if needed
}
