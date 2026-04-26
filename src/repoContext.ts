import { relative } from "node:path";
import { extensions, type Uri, workspace } from "vscode";

interface GitApiRepository {
	rootUri: Uri;
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

let cachedGitApiPromise: Promise<GitApi> | null = null;

async function loadGitApi(): Promise<GitApi> {
	const gitExtension = extensions.getExtension<GitExtension>("vscode.git");
	if (!gitExtension) {
		throw new Error("Git extension is not available.");
	}
	if (!gitExtension.isActive) {
		await gitExtension.activate();
	}
	return gitExtension.exports.getAPI(1);
}

function relativeFromRoot(rootUri: Uri, fileUri: Uri): string {
	return relative(rootUri.fsPath, fileUri.fsPath).replace(/\\/g, "/");
}

function isSupportedScheme(uri: Uri): boolean {
	return SUPPORTED_URI_SCHEMES.has(uri.scheme);
}

function getGitApi(): Promise<GitApi> {
	if (!cachedGitApiPromise) {
		cachedGitApiPromise = loadGitApi();
	}
	return cachedGitApiPromise;
}

async function resolveRepoContext(uri: Uri): Promise<RepoContext | null> {
	if (!isSupportedScheme(uri)) {
		return null;
	}

	const gitApi = await getGitApi();
	const directRepository = gitApi.getRepository(uri);
	if (directRepository) {
		return {
			repository: directRepository,
			rootUri: directRepository.rootUri,
			rootFsPath: directRepository.rootUri.fsPath,
			relativePath: relativeFromRoot(directRepository.rootUri, uri),
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
		rootFsPath: workspaceRepository.rootUri.fsPath,
		relativePath: relativeFromRoot(workspaceRepository.rootUri, uri),
		uri,
	};
}

export { getGitApi, isSupportedScheme, resolveRepoContext };
export type { RepoContext };
