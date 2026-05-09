import { type Event, extensions, type Uri, workspace } from "vscode";

interface GitApiChange {
	uri: Uri;
	status: number;
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

interface RepoContext {
	repository: GitApiRepository;
	rootUri: Uri;
	uri: Uri;
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

function resolveRepoContext(uri: Uri): RepoContext | null {
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

export type { GitApiRepository, RepoContext };
export { getGitApi, isSupportedScheme, resolveRepoContext };
