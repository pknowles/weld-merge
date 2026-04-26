import { type Event, extensions, type Uri, workspace } from "vscode";

interface GitApiChange {
	uri: Uri;
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
	getRepository(uri: Uri): GitApiRepository | null;
	openRepository(uri: Uri): Promise<GitApiRepository | null>;
}

interface RepoContext {
	repository: GitApiRepository;
	rootUri: Uri;
	rootFsPath: string;
	relativePath: string;
	uri: Uri;
}

const SUPPORTED_URI_SCHEMES = new Set(["file", "vscode-remote"]);

// TODO: wtf is this garbage!???
function decodeUriPath(path: string): string[] {
	return path
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => decodeURIComponent(segment));
}

function repoRelativePath(rootUri: Uri, fileUri: Uri): string | null {
	if (rootUri.scheme !== fileUri.scheme) {
		return null;
	}
	if (rootUri.authority !== fileUri.authority) {
		return null;
	}

	const rootSegments = decodeUriPath(rootUri.path);
	const fileSegments = decodeUriPath(fileUri.path);
	if (fileSegments.length < rootSegments.length) {
		return null;
	}
	for (const [index, rootSegment] of rootSegments.entries()) {
		if (fileSegments[index] !== rootSegment) {
			return null;
		}
	}
	return fileSegments.slice(rootSegments.length).join("/");
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

async function resolveRepoContext(uri: Uri): Promise<RepoContext | null> {
	if (!isSupportedScheme(uri)) {
		return null;
	}

	const gitApi = await getGitApi();
	const directRepository = gitApi.getRepository(uri);
	if (directRepository) {
		const relativePath = repoRelativePath(directRepository.rootUri, uri);
		if (relativePath === null) {
			return null;
		}
		return {
			repository: directRepository,
			rootUri: directRepository.rootUri,
			rootFsPath: directRepository.rootUri.fsPath,
			relativePath,
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
	const relativePath = repoRelativePath(workspaceRepository.rootUri, uri);
	if (relativePath === null) {
		return null;
	}

	return {
		repository: workspaceRepository,
		rootUri: workspaceRepository.rootUri,
		rootFsPath: workspaceRepository.rootUri.fsPath,
		relativePath,
		uri,
	};
}

export { getGitApi, isSupportedScheme, repoRelativePath, resolveRepoContext };
export type { GitApiRepository, RepoContext };
