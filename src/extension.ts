// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	commands,
	type Disposable,
	type ExtensionContext,
	ProgressLocation,
	Uri,
	window,
	workspace,
} from "vscode";
import type {
	ConflictLocation,
	NonTextConflictKind,
} from "./agentConflicts.ts";
import { nonTextMessage, resolveConflictedItem } from "./agentConflicts.ts";
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
import {
	type AutoMergeResult,
	performAutoMerge,
	WouldClobberEditError,
} from "./webview/autoMerge.ts";
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

// The one place that decides whether a conflict is a text-merge candidate,
// shared by every auto-merge path (single-file command, single-file agent
// tool, and the batch's upfront filter) so they can never disagree. Throws
// with the same wording agentConflicts.ts's nonTextMessage uses for the
// equivalent case there — remainingStage names which side survived, so the
// missing side is the one that deleted it.
async function requireTextMergeable(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
): Promise<void> {
	const status = await conflictedItem.conflictStatus();
	if (status.kind === "bothModified") {
		return;
	}
	const nonTextKind: NonTextConflictKind =
		status.kind === "bothDeleted"
			? "bothDeleted"
			: status.remainingStage === GIT_STAGE_REMOTE
				? "deletedByUs"
				: "deletedByThem";
	throw new Error(
		`Cannot auto-merge ${documentUri.fsPath} as text: ${nonTextMessage(nonTextKind)}`,
	);
}

// Adapter for the single-file paths only: a caller naming one specific
// file wants a rejection when performAutoMerge could not safely apply the
// merge, not a silently-skipped result — there is no "skip and continue"
// for a single explicit request. handleAutoMergeAll deliberately does not
// use this: it leaves "skippedWouldClobber" as a normal result entry so
// one such file never aborts the batch.
function throwIfSkippedWouldClobber(
	result: AutoMergeResult,
	documentUri: Uri,
): Exclude<AutoMergeResult, { kind: "skippedWouldClobber" }> {
	if (result.kind === "skippedWouldClobber") {
		throw new WouldClobberEditError(documentUri);
	}
	return result;
}

async function handleAutoMerge(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
	conflictedFilesProvider: ConflictedFilesProvider,
) {
	await requireTextMergeable(conflictedItem, documentUri);
	throwIfSkippedWouldClobber(
		await performAutoMerge(conflictedItem, documentUri),
		documentUri,
	);
	conflictedFilesProvider.refresh();
}

// Auto-merges a single conflicted file identified by the agent tool's
// repository-root/path location, reusing the same merge logic as the
// single-file command and the "auto-merge all" batch. Refreshes the tree so
// the UI reflects the change alongside the agent's own result. force lets
// the agent explicitly pre-agree to overwriting a file that has diverged
// from both the pre-merge conflict markers and the auto-merge result —
// see performAutoMerge.
async function handleApplyAutomergeSingle(
	location: ConflictLocation & { force?: boolean },
	conflictedFilesProvider: ConflictedFilesProvider,
): Promise<Exclude<AutoMergeResult, { kind: "skippedWouldClobber" }>> {
	const conflictedItem = resolveConflictedItem(location);
	await requireTextMergeable(conflictedItem, conflictedItem.uri);
	const result = throwIfSkippedWouldClobber(
		await performAutoMerge(
			conflictedItem,
			conflictedItem.uri,
			location.force === undefined ? {} : { force: location.force },
		),
		conflictedItem.uri,
	);
	conflictedFilesProvider.refresh();
	return result;
}

interface ConflictedFileEntry {
	repository: GitApiRepository;
	change: GitApiChange;
}

// Only files conflictStatus() reports as bothModified are text-merge
// candidates (see requireTextMergeable) — a delete/modify or both-deleted
// conflict has no 3-way merge to compute, only a choice of which side
// survives. Filtering here means autoMergeAll's candidate set is correct by
// construction: performAutoMerge is never called on an ineligible file, so
// there is nothing to catch, skip, or report as not-applicable downstream.
// weld_list_conflicts and the tree view are unaffected — they still report
// every conflict kind; only auto-merge's own candidate set is narrowed.
async function collectAutoMergeableFiles(): Promise<ConflictedFileEntry[]> {
	const repos = getGitApi().repositories.filter((r) =>
		isSupportedScheme(r.rootUri),
	);
	const entries = repos.flatMap((repo) =>
		repo.state.mergeChanges.map<ConflictedFileEntry>((change) => ({
			repository: repo,
			change,
		})),
	);
	const eligible = await Promise.all(
		entries.map(async (entry) => {
			const status = await createConflictedItem(
				entry.repository,
				entry.change,
			).conflictStatus();
			return status.kind === "bothModified" ? entry : null;
		}),
	);
	return eligible.filter((entry) => entry !== null);
}

// One file's outcome from an auto-merge-all run, in the same
// repositoryRoot/path shape weld_list_conflicts and weld_get_conflict use to
// identify files, so an agent can feed a skipped entry straight into
// weld_apply_automerge with force without reformatting anything.
// remainingConflicts is always present, on every outcome — including
// "skippedWouldClobber", where it describes what auto-merge would produce,
// not the live file's actual state, since the merge was never applied — so
// "this outcome fixed nothing" is never confused with "there is nothing
// left to fix": a caller must read remainingConflicts, not the outcome
// label alone, to know whether the file still needs attention. staged is
// true only when remainingConflicts was 0 and `git add` actually succeeded —
// see performAutoMerge.
type AutoMergeAllEntry = ConflictLocation & {
	remainingConflicts: number;
	staged: boolean;
} & ( // Wrote the 3-way merge result to the file this call.
		| { outcome: "merged" }
		// Auto-merge was not able to do anything this call: the live file
		// already held exactly the auto-merge result, so nothing was
		// written. Not the same as "resolved" — remainingConflicts still
		// names what, if anything, is left.
		| { outcome: "autoResolutionsAlreadyApplied" }
		// Applying the merge would have discarded an edit already made to
		// this file (WouldClobberEditError) — never an abort reason for
		// the batch, and never produced when force is set. Needs
		// weld_apply_automerge with force, or a manual resolution.
		| { outcome: "skippedWouldClobber" }
	);

interface AutoMergeAllResult {
	files: AutoMergeAllEntry[];
	totalCount: number;
}

// Auto-merges every text-mergeable conflicted file in every tracked
// repository. A file whose live content would be discarded by the merge
// (WouldClobberEditError) is skipped, not a batch-aborting failure — see
// WouldClobberEditError; force applies to every file the batch attempts, so
// nothing is ever skipped for this reason when it is set. Any other error
// still fails the batch fast (rethrows with the failing file's name and
// successful count as context). Returns one result per file the batch
// attempted, plus the files it skipped and the total considered.
async function handleAutoMergeAll(
	conflictedFilesProvider: ConflictedFilesProvider,
	options: { force?: boolean } = {},
): Promise<AutoMergeAllResult> {
	const conflictedFiles = await collectAutoMergeableFiles();
	const totalCount = conflictedFiles.length;
	if (totalCount === 0) {
		return { files: [], totalCount: 0 };
	}

	const files: AutoMergeAllEntry[] = [];
	const mergeEntryBuilder =
		(progress: { report: (value: { message?: string }) => void }) =>
		async (entry: ConflictedFileEntry): Promise<void> => {
			progress.report({ message: `Merging ${entry.change.uri}...` });
			const repoContext = createConflictedItem(
				entry.repository,
				entry.change,
			);
			const location: ConflictLocation = {
				repositoryRoot: entry.repository.rootUri.toString(),
				path: repositoryRelativePath(
					entry.repository.rootUri,
					entry.change.uri,
				),
			};
			let result: AutoMergeResult;
			try {
				result = await performAutoMerge(
					repoContext,
					entry.change.uri,
					options,
				);
			} catch (error: unknown) {
				throw new Error(
					`Weld Auto-Merge All stopped at ${entry.change.uri} after ${files.length} successful merge(s): ${getErrorMessage(error)}`,
					{ cause: error },
				);
			}
			files.push({
				...location,
				remainingConflicts: result.remainingConflicts,
				staged: result.staged,
				outcome: result.kind,
			});
		};
	try {
		await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: "Weld Auto-Merge All",
				cancellable: false,
			},
			async (progress) => {
				// Sequential chain: stop-on-first-failure is intentional
				// (a clobber-skip is not a failure and never stops the
				// chain), and each merge must observe the previous one's
				// applied edit before starting.
				const mergeEntry = mergeEntryBuilder(progress);
				await conflictedFiles.reduce<Promise<void>>(
					(previous, entry) => previous.then(() => mergeEntry(entry)),
					Promise.resolve(),
				);
			},
		);
	} finally {
		const mergedCount = files.filter(
			(file) => file.outcome !== "skippedWouldClobber",
		).length;
		if (mergedCount > 0) {
			const fullyResolvedCount = files.filter(
				(file) => file.remainingConflicts === 0,
			).length;
			const skippedCount = files.length - mergedCount;
			getWeldLogChannel().info(
				`Weld Auto-Merge All: merged ${mergedCount} of ${totalCount} file(s), ${fullyResolvedCount} fully resolved${
					skippedCount > 0
						? `, skipped ${skippedCount} already-edited file(s)`
						: ""
				}.`,
			);
			conflictedFilesProvider.refresh();
		}
	}

	return { files, totalCount };
}

// Turns an AutoMergeAllResult into the tree command's human-readable info
// message. The agent tool returns the structured result directly (JSON, not
// prose) and logs its own short summary instead of this one — an agent reads
// the fields, not the sentence a person would see in a notification popup.
function summarizeAutoMergeAll(result: AutoMergeAllResult): string {
	const attempted = result.files.filter(
		(file) => file.outcome !== "skippedWouldClobber",
	);
	const mergedCount = attempted.length;
	const fullyResolvedCount = attempted.filter(
		(file) => file.remainingConflicts === 0,
	).length;
	const unresolvedCount = mergedCount - fullyResolvedCount;
	const skipped = result.files.filter(
		(file) => file.outcome === "skippedWouldClobber",
	);
	const parts = [
		`Merged ${mergedCount} of ${result.totalCount} file(s); ${fullyResolvedCount} fully resolved`,
	];
	if (unresolvedCount > 0) {
		parts.push(
			`, ${unresolvedCount} still have unresolved conflicts left as <<<<<<< markers`,
		);
	}
	if (skipped.length > 0) {
		parts.push(
			`, ${skipped.length} skipped (already edited since the conflict was created — retry with force to overwrite): ${skipped
				.map((file) => file.path)
				.join(", ")}`,
		);
	}
	return `${parts.join("")}.`;
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
			const result = await handleAutoMergeAll(conflictedFilesProvider);
			if (result.totalCount === 0) {
				window.showInformationMessage(
					"No unmerged files to auto-merge.",
				);
				return;
			}
			window.showInformationMessage(
				`Weld Auto-Merge All: ${summarizeAutoMergeAll(result)}`,
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
		(options) => handleAutoMergeAll(conflictedFilesProvider, options),
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
