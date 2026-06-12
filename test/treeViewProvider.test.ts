import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from "@jest/globals";
import { extensions, Uri, workspace } from "vscode";
import { getGitDirUri, readConflictState } from "../src/gitUtils.ts";
import type { GitApiRepository } from "../src/repoContext.ts";
import { GitStatus } from "../src/repoContext.ts";
import {
	isActiveSubmoduleGitlinkConflict,
	isKnownSubmoduleConflictPath,
	isSubmoduleGitlinkChange,
} from "../src/submoduleConflict.ts";
import { ConflictedFilesProvider, GitFile } from "../src/treeView.ts";

jest.mock("../src/gitUtils.ts", () => ({
	getGitDirUri: jest.fn(),
	readConflictState: jest.fn(),
}));

jest.mock("../src/submoduleConflict.ts", () => ({
	isActiveSubmoduleGitlinkConflict: jest.fn(),
	isKnownSubmoduleConflictPath: jest.fn(),
	isSubmoduleGitlinkChange: jest.fn(),
}));

interface MutableExtensions {
	getExtension(extensionId: string): unknown;
}

const mockedReadConflictState = jest.mocked(readConflictState);
const mockedGetGitDirUri = jest.mocked(getGitDirUri);
const mockedIsActiveSubmoduleGitlinkConflict = jest.mocked(
	isActiveSubmoduleGitlinkConflict,
);
const mockedIsKnownSubmoduleConflictPath = jest.mocked(
	isKnownSubmoduleConflictPath,
);
const mockedIsSubmoduleGitlinkChange = jest.mocked(isSubmoduleGitlinkChange);

Object.defineProperty(globalThis, "TextDecoder", {
	value: TextDecoder,
	configurable: true,
});

let restoreGitApi: (() => void) | null = null;

beforeEach(() => {
	mockedReadConflictState.mockReset();
	mockedGetGitDirUri.mockReset();
	mockedIsActiveSubmoduleGitlinkConflict.mockReset();
	mockedIsKnownSubmoduleConflictPath.mockReset();
	mockedIsSubmoduleGitlinkChange.mockReset();
	mockedIsActiveSubmoduleGitlinkConflict.mockResolvedValue(false);
	mockedIsKnownSubmoduleConflictPath.mockResolvedValue(false);
	mockedIsSubmoduleGitlinkChange.mockResolvedValue(false);
});

afterEach(() => {
	restoreGitApi?.();
	restoreGitApi = null;
	jest.restoreAllMocks();
});

function makeRepo(
	rootPath: string,
	mergePaths: string[] = [],
	scheme = "file",
): GitApiRepository {
	const rootUri = Uri.from({ scheme, path: rootPath });
	return {
		rootUri,
		state: {
			mergeChanges: mergePaths.map((path) => ({
				uri: Uri.joinPath(rootUri, path),
				status: GitStatus.BOTH_MODIFIED,
			})),
			onDidChange: () => ({ dispose: () => undefined }),
		},
		status: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		show: jest
			.fn<(ref: string, path: string) => Promise<string>>()
			.mockRejectedValue(new Error("not used")),
		getCommit: jest.fn<() => never>(),
		getMergeBase: jest
			.fn<(ref1: string, ref2: string) => Promise<string>>()
			.mockResolvedValue("merge-base"),
		add: jest.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(),
	};
}

function installGitApi(repositories: GitApiRepository[]): () => void {
	const mutableExtensions = extensions as unknown as MutableExtensions;
	const originalGetExtension = mutableExtensions.getExtension;
	mutableExtensions.getExtension = () => ({
		isActive: true,
		exports: {
			enabled: true,
			onDidChangeEnablement: () => ({ dispose: () => undefined }),
			getAPI: () => ({
				git: { path: "git" },
				state: "initialized",
				repositories,
				onDidChangeState: () => ({ dispose: () => undefined }),
				onDidOpenRepository: () => ({ dispose: () => undefined }),
				onDidCloseRepository: () => ({ dispose: () => undefined }),
				getRepository: () => null,
				getRepositoryRoot: () => Promise.resolve(null),
				openRepository: () => Promise.resolve(null),
				toGitUri: (uri: Uri) => uri,
			}),
		},
		activate: () => Promise.reject(new Error("not used")),
	});
	return () => {
		mutableExtensions.getExtension = originalGetExtension;
	};
}

function mockMergeMsg(
	content: string,
): jest.SpiedFunction<typeof workspace.fs.readFile> {
	return jest
		.spyOn(workspace.fs, "readFile")
		.mockResolvedValue(Buffer.from(content, "utf8"));
}

describe("ConflictedFilesProvider repository rows", () => {
	it("keeps good repository rows when another repository fails", async () => {
		const goodRepo = makeRepo("/work/good", ["conflict.txt"]);
		const badRepo = makeRepo("/work/bad", []);
		const unsupportedRepo = makeRepo(
			"/work/virtual",
			["ignored.txt"],
			"git",
		);
		restoreGitApi = installGitApi([goodRepo, badRepo, unsupportedRepo]);
		mockedReadConflictState.mockImplementation((repo) => {
			if (repo.rootUri.toString() === badRepo.rootUri.toString()) {
				return Promise.reject(
					new Error("state failed", {
						cause: new Error("root cause"),
					}),
				);
			}
			return Promise.resolve(undefined);
		});

		const children = await new ConflictedFilesProvider().getChildren();
		const conflict = children.find(
			(item) =>
				item instanceof GitFile &&
				item.contextValue === "conflictedFile",
		);
		const error = children.find(
			(item) => item.contextValue === "weldError",
		);

		expect(children).toHaveLength(2);
		expect(conflict).toBeInstanceOf(GitFile);
		expect(conflict?.label).toBe("/work/good/conflict.txt");
		expect(conflict?.description).toBe("Conflicted");
		expect(conflict?.tooltip).toBe("/work/good/conflict.txt");
		expect(conflict?.resourceUri?.toString()).toBe(
			"file:///work/good/conflict.txt",
		);
		expect(conflict?.command).toMatchObject({
			command: "meld-auto-merge.openMeldDiff",
			title: "Open",
			arguments: [conflict],
		});
		expect(error?.label).toBe(
			"Failed to list conflicts for file:///work/bad",
		);
		expect(error?.description).toBe(
			"state failed -> caused by: root cause",
		);
		expect(error?.tooltip).toBe("state failed -> caused by: root cause");
		expect(mockedReadConflictState).not.toHaveBeenCalledWith(
			unsupportedRepo,
		);
	});

	it("shows an operation-specific warning when Git reports a conflict state without paths", async () => {
		const repo = makeRepo("/work/mismatch");
		restoreGitApi = installGitApi([repo]);
		mockedReadConflictState.mockResolvedValue({
			operation: "cherry-pick",
			otherRef: "CHERRY_PICK_HEAD",
		});
		mockedGetGitDirUri.mockResolvedValue(Uri.file("/work/mismatch/.git"));
		mockMergeMsg("Cherry-pick message without a conflicts block\n");

		const children = await new ConflictedFilesProvider().getChildren();

		expect(children).toHaveLength(1);
		expect(children[0]?.contextValue).toBe("weldWarning");
		expect(children[0]?.label).toBe(
			"No conflicts detected during cherry-pick",
		);
		expect(children[0]?.description).toBe("Git API mismatch");
		expect(children[0]?.tooltip).toContain(
			"Git reports a conflict operation in progress",
		);
	});
});

describe("ConflictedFilesProvider resolved rows", () => {
	it("reconstructs resolved file and submodule rows from MERGE_MSG", async () => {
		const repo = makeRepo("/work/resolved", ["active.txt"]);
		restoreGitApi = installGitApi([repo]);
		mockedReadConflictState.mockResolvedValue({
			operation: "merge",
			otherRef: "MERGE_HEAD",
		});
		mockedGetGitDirUri.mockResolvedValue(Uri.file("/work/resolved/.git"));
		mockMergeMsg(
			[
				"Merge branch 'feature'",
				"# Conflicts:",
				"#\tactive.txt",
				"#\tresolved.txt",
				"#\tsub",
				"#\tresolved.txt",
				"",
			].join("\n"),
		);
		mockedIsKnownSubmoduleConflictPath.mockImplementation((_repo, uri) =>
			Promise.resolve(uri.fsPath === "/work/resolved/sub"),
		);

		const children = await new ConflictedFilesProvider().getChildren();
		const active = children.find(
			(item) =>
				item instanceof GitFile &&
				item.uri.fsPath.endsWith("active.txt"),
		);
		const resolvedFile = children.find(
			(item) =>
				item instanceof GitFile &&
				item.uri.fsPath.endsWith("resolved.txt"),
		);
		const resolvedSubmodule = children.find(
			(item) =>
				item instanceof GitFile && item.uri.fsPath.endsWith("/sub"),
		);

		expect(children).toHaveLength(3);
		expect(active?.contextValue).toBe("conflictedFile");
		expect(resolvedFile?.contextValue).toBe("resolvedFile");
		expect(resolvedFile?.description).toBe("Resolved");
		expect(resolvedFile?.command?.command).toBe(
			"meld-auto-merge.openConflictedFile",
		);
		expect(resolvedFile?.command?.arguments).toEqual([resolvedFile]);
		expect(resolvedSubmodule?.contextValue).toBe("resolvedSubmodule");
		expect(resolvedSubmodule?.description).toBe("Resolved Submodule");
		expect(resolvedSubmodule?.command?.command).toBe(
			"meld-auto-merge.openMeldDiff",
		);
		expect(mockedIsKnownSubmoduleConflictPath).toHaveBeenCalledWith(
			repo,
			Uri.file("/work/resolved/sub"),
		);
	});
});

describe("ConflictedFilesProvider events", () => {
	it("fires tree-change and materialization events at the public boundary", async () => {
		const provider = new ConflictedFilesProvider();
		const events: unknown[] = [];
		let refreshes = 0;
		let materializations = 0;
		const treeSubscription = provider.onDidChangeTreeData((event) => {
			events.push(event);
		});
		const refreshSubscription = provider.onDidRefresh(() => {
			refreshes += 1;
		});
		const getChildrenSubscription = provider.onDidGetChildren(() => {
			materializations += 1;
		});
		try {
			provider.refresh();
			const childRows = await provider.getChildren({} as never);

			expect(events).toEqual([undefined]);
			expect(refreshes).toBe(1);
			expect(materializations).toBe(1);
			expect(childRows).toEqual([]);
		} finally {
			treeSubscription.dispose();
			refreshSubscription.dispose();
			getChildrenSubscription.dispose();
		}
	});
});
