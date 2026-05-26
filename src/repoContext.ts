import {
	type Disposable,
	type Event,
	EventEmitter,
	extensions,
	type Uri,
	workspace,
} from "vscode";
import { getWeldLogChannel } from "./log.ts";

// Mirrors the public `Status` const enum order from VS Code's bundled Git API
// (`extensions/git/src/api/git.d.ts`). The API exposes only numeric statuses at
// runtime, so derive the values from the official ordered names in one place.
const gitStatusNames = [
	"INDEX_MODIFIED",
	"INDEX_ADDED",
	"INDEX_DELETED",
	"INDEX_RENAMED",
	"INDEX_COPIED",
	"MODIFIED",
	"DELETED",
	"UNTRACKED",
	"IGNORED",
	"INTENT_TO_ADD",
	"INTENT_TO_RENAME",
	"TYPE_CHANGED",
	"ADDED_BY_US",
	"ADDED_BY_THEM",
	"DELETED_BY_US",
	"DELETED_BY_THEM",
	"BOTH_ADDED",
	"BOTH_DELETED",
	"BOTH_MODIFIED",
] as const;

type GitStatusName = (typeof gitStatusNames)[number];
type GitStatus = number;

const GitStatus: Record<GitStatusName, GitStatus> = Object.fromEntries(
	gitStatusNames.map((name, index) => [name, index]),
) as Record<GitStatusName, GitStatus>;

function getGitStatusName(status: GitStatus): string {
	return gitStatusNames[status] ?? `UNKNOWN_STATUS_${status}`;
}

interface GitApiChange {
	uri: Uri;
	status: GitStatus;
}

interface GitApiCommit {
	hash: string;
	message: string;
	authorName?: string;
	authorEmail?: string;
	authorDate?: Date;
}

interface GitApiRepositoryState {
	mergeChanges: GitApiChange[];
	onDidChange: Event<void>;
}

interface GitApiRepository {
	rootUri: Uri;
	state: GitApiRepositoryState;
	status(): Promise<void>;
	show(ref: string, path: string): Promise<string>;
	getCommit(ref: string): Promise<GitApiCommit>;
	getMergeBase(ref1: string, ref2: string): Promise<string>;
	add(paths: string[]): Promise<void>;
}

const _onRepositoryStateChangedEmitter = new EventEmitter<GitApiRepository>();
let gitApiWhenInitializedPromise: Promise<GitApi> | undefined;

// Repositories currently known to Weld. The promise is the acquisition carrier:
// it resolves only to a fully usable repository wrapper for this Git lifetime.
const _gitRepositories = new Map<string, Promise<ReadyRepository>>();

// Broadcast after a repository status refresh has produced new state. Only a
// live-refresh signal for already-open editors; startup state comes from the
// shared repository acquisition promise, not by observing this event.
const onRepositoryStateChanged: Event<GitApiRepository> =
	_onRepositoryStateChangedEmitter.event;

function notifyRepositoryStateChanged(repo: GitApiRepository): void {
	_onRepositoryStateChangedEmitter.fire(repo);
}

const SUPPORTED_URI_SCHEMES = new Set(["file", "vscode-remote"]);
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;
type GitConflictStage = typeof GIT_STAGE_LOCAL | typeof GIT_STAGE_REMOTE;
type GitApiState = "uninitialized" | "initialized";

type ConflictStatus =
	| { kind: "bothModified" }
	| { kind: "bothDeleted" }
	| { kind: "deleteModify"; remainingStage: GitConflictStage };

interface GitExtension {
	enabled: boolean;
	onDidChangeEnablement: Event<boolean>;
	getAPI(version: number): GitApi;
}

interface GitApi {
	git: {
		path: string;
	};
	state: GitApiState;
	repositories: GitApiRepository[];
	onDidChangeState: Event<GitApiState>;
	onDidOpenRepository: Event<GitApiRepository>;
	onDidCloseRepository: Event<GitApiRepository>;
	getRepository(uri: Uri): GitApiRepository | null;
	getRepositoryRoot(uri: Uri): Promise<Uri | null>;
	openRepository(uri: Uri): Promise<GitApiRepository | null>;
	toGitUri(uri: Uri, ref: string): Uri;
}

// Possibly-conflicted file or submodule
interface ConflictedItem {
	repository: GitApiRepository; // api, awkwardly grouped
	rootUri: Uri; // TODO: remove. use repository.rootUri
	uri: Uri; // file or submodule
	mergeChange: GitApiChange | null;
	conflictStatus(): Promise<ConflictStatus>;
}

class GitApiUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitApiUnavailableError";
	}
}

class NotInRepositoryError extends Error {
	constructor(uri: Uri) {
		super(`${uri.toString()} is not in a Git repository.`);
		this.name = "NotInRepositoryError";
	}
}

class RepositoryUnavailableError extends Error {
	constructor(uri: Uri) {
		super(`Git repository is not available for ${uri.toString()}.`);
		this.name = "RepositoryUnavailableError";
	}
}

class EditorDisposedError extends Error {
	constructor() {
		super(
			"Editor was disposed before Git repository state became available.",
		);
		this.name = "EditorDisposedError";
	}
}

class RepositoryClosedError extends Error {
	constructor(uri: Uri) {
		super(
			`Git repository closed before it became ready: ${uri.toString()}`,
		);
		this.name = "RepositoryClosedError";
	}
}

// ReadyRepository carries the proof that a repository's first status run has
// completed and mergeChanges are populated. The private constructor enforces that
// all construction goes through the static methods below, so holding a
// ReadyRepository means the repository is ready — no separate flag or set needed.
class ReadyRepository {
	readonly repository: GitApiRepository;

	private constructor(repo: GitApiRepository) {
		this.repository = repo;
	}

	static fromFirstStatus(repo: GitApiRepository): ReadyRepository {
		return new ReadyRepository(repo);
	}
}

// Resolves only after the first status-backed state event. That event is the Git
// API boundary where mergeChanges become reliable for editors.
function waitForFirstStatus(
	api: GitApi,
	repo: GitApiRepository,
): Promise<ReadyRepository> {
	if (repo.state.mergeChanges.length > 0) {
		return Promise.resolve(ReadyRepository.fromFirstStatus(repo));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const disposables: Disposable[] = [];
		const finish = (result: ReadyRepository | Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			for (const disposable of disposables) {
				disposable.dispose();
			}
			if (result instanceof Error) {
				reject(result);
				return;
			}
			resolve(result);
		};
		disposables.push(
			repo.state.onDidChange(() =>
				finish(ReadyRepository.fromFirstStatus(repo)),
			),
			api.onDidCloseRepository((closedRepo) => {
				if (repositoryMatchesRoot(closedRepo, repo.rootUri)) {
					finish(new RepositoryClosedError(repo.rootUri));
				}
			}),
		);
	});
}

// Mirrors VS Code's repository-open lifetime. The stored promise is retained
// after fulfillment so later editors receive the same acquired repository, and is
// removed on rejection so a later repository open can create a fresh acquisition.
function registerRepository(api: GitApi, repo: GitApiRepository): void {
	const key = repo.rootUri.toString();
	if (_gitRepositories.has(key)) {
		return;
	}
	const promise = waitForFirstStatus(api, repo);
	promise.catch(() => {
		if (_gitRepositories.get(key) === promise) {
			_gitRepositories.delete(key);
		}
	});
	_gitRepositories.set(key, promise);
}

// Called from extension.ts onDidCloseRepository. Existing waiters are rejected by
// the promise's own Git close listener; this removes the fulfilled/pending entry
// from the current repository map so a later open starts a fresh acquisition.
function unregisterRepository(rootUri: Uri): void {
	_gitRepositories.delete(rootUri.toString());
}

function isSupportedScheme(uri: Uri): boolean {
	return SUPPORTED_URI_SCHEMES.has(uri.scheme);
}

// Fetches the Git API fresh each time. Not cached because extensions.getExtension
// returns a new wrapper object per call, so caching would prevent test mocking.
function getGitApi(): GitApi {
	const gitExtension = extensions.getExtension<GitExtension>("vscode.git");
	if (!gitExtension) {
		throw new Error("Git extension is not available.");
	}
	return gitExtension.exports.getAPI(1);
}

function getGitApiWhenInitialized(): Promise<GitApi> {
	gitApiWhenInitializedPromise ??= initializeGitApi().finally(() => {
		// Share one in-flight initialization without pinning the Git API forever;
		// tests and extension reloads must be able to observe the current VS Code
		// extension export rather than a stale object from an earlier call.
		gitApiWhenInitializedPromise = undefined;
	});
	return gitApiWhenInitializedPromise;
}

async function initializeGitApi(): Promise<GitApi> {
	const extension = extensions.getExtension<GitExtension>("vscode.git");
	if (!extension) {
		throw new GitApiUnavailableError(
			"The built-in Git extension is not available.",
		);
	}
	const gitExtension = extension.isActive
		? extension.exports
		: await extension.activate();
	if (!gitExtension.enabled) {
		throw new GitApiUnavailableError(
			"The built-in Git extension is disabled.",
		);
	}
	const api = gitExtension.getAPI(1);
	if (api.state === "initialized") {
		return api;
	}
	await waitForGitApiInitialized(api);
	return api;
}

function waitForGitApiInitialized(api: GitApi): Promise<void> {
	return new Promise((resolve) => {
		const disposable = api.onDidChangeState((state) => {
			if (state === "initialized") {
				disposable.dispose();
				resolve();
			}
		});
	});
}

function withPanelDisposal<T>(
	panel: { onDidDispose(listener: () => void): Disposable },
	promise: Promise<T>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const disposable = panel.onDidDispose(() => {
			if (settled) {
				return;
			}
			settled = true;
			disposable.dispose();
			reject(new EditorDisposedError());
		});
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				disposable.dispose();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				disposable.dispose();
				reject(error);
			},
		);
	});
}

async function repositoryRootForDocument(api: GitApi, uri: Uri): Promise<Uri> {
	const existing = api.getRepository(uri);
	if (existing) {
		return existing.rootUri;
	}
	const root = await api.getRepositoryRoot(uri);
	if (!root) {
		throw new NotInRepositoryError(uri);
	}
	return root;
}

function repositoryMatchesRoot(
	repository: GitApiRepository,
	rootUri: Uri,
): boolean {
	return repository.rootUri.toString() === rootUri.toString();
}

function openRepositoryAtRoot(
	api: GitApi,
	rootUri: Uri,
	panel: { onDidDispose(listener: () => void): Disposable },
): Promise<GitApiRepository> {
	const existing = api.getRepository(rootUri);
	if (existing) {
		return Promise.resolve(existing);
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		const disposables: Disposable[] = [];
		const finish = (result: GitApiRepository | Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			for (const disposable of disposables) {
				disposable.dispose();
			}
			if (result instanceof Error) {
				reject(result);
				return;
			}
			resolve(result);
		};

		disposables.push(
			api.onDidOpenRepository((repository) => {
				if (repositoryMatchesRoot(repository, rootUri)) {
					finish(repository);
				}
			}),
			panel.onDidDispose(() => finish(new EditorDisposedError())),
		);

		api.openRepository(rootUri).then(
			(repository) => {
				if (repository) {
					finish(repository);
					return;
				}
				const opened = api.getRepository(rootUri);
				if (opened) {
					finish(opened);
					return;
				}
				finish(new RepositoryUnavailableError(rootUri));
			},
			(error: unknown) => {
				if (error instanceof Error) {
					finish(error);
					return;
				}
				finish(new Error(String(error)));
			},
		);
	});
}

function repositoryPromiseFor(
	api: GitApi,
	repository: GitApiRepository,
): Promise<ReadyRepository> {
	registerRepository(api, repository);
	const promise = _gitRepositories.get(repository.rootUri.toString());
	if (!promise) {
		throw new RepositoryUnavailableError(repository.rootUri);
	}
	return promise;
}

// The sole entry point for custom editors needing a repository. Resolves once
// the Git API is initialized, the repository is open, and first status has fired.
// Returns a ReadyRepository whose type proves all three conditions hold, so callers
// never touch a GitApiRepository with unpopulated mergeChanges.
async function readyRepositoryForRoot(
	rootUri: Uri,
	panel: { onDidDispose(listener: () => void): Disposable },
): Promise<ReadyRepository> {
	const api = await withPanelDisposal(panel, getGitApiWhenInitialized());
	const repository = await openRepositoryAtRoot(api, rootUri, panel);
	return withPanelDisposal(panel, repositoryPromiseFor(api, repository));
}

async function conflictedItemForDocument(
	uri: Uri,
	panel: { onDidDispose(listener: () => void): Disposable },
): Promise<ConflictedItem> {
	if (!isSupportedScheme(uri)) {
		throw new Error(`Unsupported URI scheme "${uri.scheme}".`);
	}
	const api = await withPanelDisposal(panel, getGitApiWhenInitialized());
	const rootUri = await withPanelDisposal(
		panel,
		repositoryRootForDocument(api, uri),
	);
	const { repository } = await readyRepositoryForRoot(rootUri, panel);
	return createConflictedItemFromUri(repository, uri);
}

async function readConflictStage(
	repository: GitApiRepository,
	file: Uri,
	stage: GitConflictStage,
): Promise<string | null> {
	try {
		return await repository.show(`:${stage}`, file.fsPath);
	} catch {
		return null;
	}
}

function statusFromStages(
	localStage: string | null,
	remoteStage: string | null,
): ConflictStatus {
	if (localStage !== null && remoteStage !== null) {
		return { kind: "bothModified" };
	}
	if (localStage === null && remoteStage !== null) {
		return { kind: "deleteModify", remainingStage: GIT_STAGE_REMOTE };
	}
	if (localStage !== null && remoteStage === null) {
		return { kind: "deleteModify", remainingStage: GIT_STAGE_LOCAL };
	}
	return { kind: "bothDeleted" };
}

function logStatusMismatch(
	file: Uri,
	change: GitApiChange,
	computedStatus: ConflictStatus,
	localStage: string | null,
	remoteStage: string | null,
): void {
	if (
		(change.status === GitStatus.DELETED_BY_US &&
			computedStatus.kind === "deleteModify" &&
			computedStatus.remainingStage === GIT_STAGE_REMOTE) ||
		(change.status === GitStatus.DELETED_BY_THEM &&
			computedStatus.kind === "deleteModify" &&
			computedStatus.remainingStage === GIT_STAGE_LOCAL) ||
		(change.status === GitStatus.BOTH_DELETED &&
			computedStatus.kind === "bothDeleted") ||
		(![
			GitStatus.DELETED_BY_US,
			GitStatus.DELETED_BY_THEM,
			GitStatus.BOTH_DELETED,
		].includes(change.status) &&
			computedStatus.kind === "bothModified")
	) {
		return;
	}

	getWeldLogChannel().warn(
		`VS Code Git status ${change.status} (${getGitStatusName(change.status)}) disagrees with readable conflict stages for ${file.toString()}; falling back to ${computedStatus.kind} conflict handling. stage ${GIT_STAGE_LOCAL}: ${localStage === null ? "missing" : `present (${localStage.length} bytes)`}; stage ${GIT_STAGE_REMOTE}: ${remoteStage === null ? "missing" : `present (${remoteStage.length} bytes)`}.`,
	);
}

async function computeConflictStatus(
	repository: GitApiRepository,
	file: Uri,
	change: GitApiChange | null,
): Promise<ConflictStatus> {
	if (!change) {
		return { kind: "bothModified" };
	}

	// The Git API status is advisory. Cursor has reported BOTH_DELETED for
	// files where stages 1/2/3 are readable. Stage availability is slower to
	// probe but is the reliable conflict shape, and it works through the VS Code
	// Git API for remote workspaces.
	const [localStage, remoteStage] = await Promise.all([
		readConflictStage(repository, file, GIT_STAGE_LOCAL),
		readConflictStage(repository, file, GIT_STAGE_REMOTE),
	]);
	const computedStatus = statusFromStages(localStage, remoteStage);
	logStatusMismatch(file, change, computedStatus, localStage, remoteStage);
	return computedStatus;
}

function createConflictedItem(
	repository: GitApiRepository,
	mergeChange: GitApiChange,
): ConflictedItem {
	return {
		repository,
		rootUri: repository.rootUri,
		uri: mergeChange.uri,
		mergeChange,
		conflictStatus: () =>
			computeConflictStatus(repository, mergeChange.uri, mergeChange),
	};
}

function createConflictedItemFromUri(
	repository: GitApiRepository,
	uri: Uri,
): ConflictedItem {
	const uriKey = uri.toString();
	const mergeChange =
		repository.state.mergeChanges.find(
			(change) => change.uri.toString() === uriKey,
		) ?? null;
	return {
		repository,
		rootUri: repository.rootUri,
		uri,
		mergeChange,
		conflictStatus: () =>
			computeConflictStatus(repository, uri, mergeChange),
	};
}

function conflictedItemFromUri(uri: Uri): ConflictedItem | null {
	if (!isSupportedScheme(uri)) {
		return null;
	}

	const gitApi = getGitApi();
	const directRepository = gitApi.getRepository(uri);
	if (directRepository) {
		return createConflictedItemFromUri(directRepository, uri);
	}

	const workspaceFolder = workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		return null;
	}

	const workspaceRepository = gitApi.getRepository(workspaceFolder.uri);
	if (!workspaceRepository) {
		return null;
	}

	return createConflictedItemFromUri(workspaceRepository, uri);
}

export type {
	ConflictedItem,
	GitApiChange,
	GitApiRepository,
	GitConflictStage,
};
export {
	conflictedItemForDocument,
	conflictedItemFromUri,
	createConflictedItem,
	createConflictedItemFromUri,
	EditorDisposedError,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	GitApiUnavailableError,
	GitStatus,
	getGitApi,
	getGitStatusName,
	isSupportedScheme,
	NotInRepositoryError,
	notifyRepositoryStateChanged,
	onRepositoryStateChanged,
	RepositoryClosedError,
	RepositoryUnavailableError,
	readyRepositoryForRoot,
	registerRepository,
	unregisterRepository,
};
