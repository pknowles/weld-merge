import { type Event, extensions, type Uri, workspace } from "vscode";

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
}

const SUPPORTED_URI_SCHEMES = new Set(["file", "vscode-remote"]);

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

function conflictedItemFromUri(uri: Uri): ConflictedItem | null {
	if (!isSupportedScheme(uri)) {
		return null;
	}

	const gitApi = getGitApi();
	const directRepository = gitApi.getRepository(uri);
	if (directRepository) {
		return {
			repository: directRepository,
			rootUri: directRepository.rootUri,
			uri,
		};
	}

	const workspaceFolder = workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		return null;
	}

	const workspaceRepository = gitApi.getRepository(workspaceFolder.uri);
	if (!workspaceRepository) {
		return null;
	}

	return {
		repository: workspaceRepository,
		rootUri: workspaceRepository.rootUri,
		uri,
	};
}

export type { ConflictedItem, GitApiChange, GitApiRepository };
export { conflictedItemFromUri, GitStatus, getGitApi, isSupportedScheme };
