import { type Event, extensions, type Uri, workspace } from "vscode";
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
	show(ref: string, path: string): Promise<string>;
	getCommit(ref: string): Promise<GitApiCommit>;
	getMergeBase(ref1: string, ref2: string): Promise<string>;
	add(paths: string[]): Promise<void>;
}

const SUPPORTED_URI_SCHEMES = new Set(["file", "vscode-remote"]);
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;
type GitConflictStage = typeof GIT_STAGE_LOCAL | typeof GIT_STAGE_REMOTE;

type ConflictStatus =
	| { kind: "bothModified" }
	| { kind: "bothDeleted" }
	| { kind: "deleteModify"; remainingStage: GitConflictStage };

interface GitExtension {
	getAPI(version: number): GitApi;
}

interface GitApi {
	git: {
		path: string;
	};
	repositories: GitApiRepository[];
	onDidOpenRepository: Event<GitApiRepository>;
	onDidCloseRepository: Event<GitApiRepository>;
	getRepository(uri: Uri): GitApiRepository | null;
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
	conflictedItemFromUri,
	createConflictedItem,
	createConflictedItemFromUri,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	GitStatus,
	getGitApi,
	getGitStatusName,
	isSupportedScheme,
};
