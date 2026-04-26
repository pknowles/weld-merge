import { beforeEach, describe, it, jest } from "@jest/globals";

const getExtensionMock = jest.fn();
const getWorkspaceFolderMock = jest.fn();

jest.mock("vscode", () => ({
	extensions: {
		getExtension: getExtensionMock,
	},
	workspace: {
		getWorkspaceFolder: getWorkspaceFolderMock,
	},
}));

import { resolveRepoContext } from "../src/repoContext.ts";

interface MockUri {
	scheme: string;
	fsPath: string;
}

function makeUri(scheme: string, fsPath: string): MockUri {
	return { scheme, fsPath };
}

function makeGitExtension(
	getRepository: (uri: MockUri) => { rootUri: MockUri } | null,
) {
	return {
		isActive: true,
		activate: jest.fn(async () => undefined),
		exports: {
			getAPI: () => ({
				git: {
					path: "git",
				},
				getRepository,
			}),
		},
	};
}

describe("repoContext.resolveRepoContext", () => {
	beforeEach(() => {
		getExtensionMock.mockReset();
		getWorkspaceFolderMock.mockReset();
	});

	it("returns null for unsupported URI schemes", async () => {
		getExtensionMock.mockReturnValue(
			makeGitExtension(() => {
				throw new Error("getRepository should not be called");
			}),
		);
		const uri = makeUri("git", "/repo/file.ts");
		await expect(resolveRepoContext(uri as never)).resolves.toBeNull();
	});

	it("resolves root and relative path from direct repository match", async () => {
		const rootUri = makeUri("file", "/repo");
		getExtensionMock.mockReturnValue(
			makeGitExtension((uri) =>
				uri.fsPath.startsWith("/repo/") ? { rootUri } : null,
			),
		);
		const uri = makeUri("file", "/repo/src/file.ts");
		await expect(resolveRepoContext(uri as never)).resolves.toMatchObject({
			rootFsPath: "/repo",
			relativePath: "src/file.ts",
		});
	});

	it("falls back to workspace folder repository lookup", async () => {
		const rootUri = makeUri("file", "/repo");
		const folderUri = makeUri("file", "/workspace/subdir");
		getExtensionMock.mockReturnValue(
			makeGitExtension((uri) =>
				uri.fsPath === folderUri.fsPath ? { rootUri } : null,
			),
		);
		getWorkspaceFolderMock.mockReturnValue({ uri: folderUri });
		const uri = makeUri("file", "/repo/feature/file.ts");
		await expect(resolveRepoContext(uri as never)).resolves.toMatchObject({
			rootFsPath: "/repo",
			relativePath: "feature/file.ts",
		});
	});

	it("returns null when no repository is found", async () => {
		getExtensionMock.mockReturnValue(makeGitExtension(() => null));
		getWorkspaceFolderMock.mockReturnValue(undefined);
		const uri = makeUri("file", "/repo/missing.ts");
		await expect(resolveRepoContext(uri as never)).resolves.toBeNull();
	});
});
