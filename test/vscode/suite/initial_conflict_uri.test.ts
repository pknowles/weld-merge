import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "mocha";
import {
	commands,
	EventEmitter,
	extensions,
	Uri,
	window,
	workspace,
} from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { getGitApi } from "../../../src/repoContext.ts";
import {
	ConflictedFilesProvider,
	ErrorTreeItem,
} from "../../../src/treeView.ts";
import { makeRepo, openRepoInGitExtension } from "./helpers.ts";

const TOP_LEVEL_FAILURE_REGEX = /forced top-level failure/;
const PER_REPO_LABEL_REGEX = /Failed to list conflicts for/;
const PER_REPO_FILENOTFOUND_REGEX =
	/(FileNotFound|ENOENT|cannot find|MERGE_MSG)/;
const AUTO_MERGE_ALL_FAILURE_REGEX =
	/Weld Auto-Merge All stopped at .*tracked\.txt after 0 successful merge\(s\): .*forced repository\.show failure/;

// Reproduces the Compare feature's initial-conflict URI round-trip using the
// real VS Code host. setInitialConflictContent stores the original conflicted
// text under a URI built from the document URI with the scheme swapped to
// `weld-initial-conflict:`. The registered TextDocumentContentProvider must
// receive the same URI and look the content back up.
//
// Regression guard: an earlier version embedded an encoded form of the
// document URI into the conflict URI's path; Uri.parse decoded it during
// normalisation, so the provider's lookup key never matched what was stored.
//
// We obtain setInitialConflictContent via `ext.activate()` (not a source
// import) so that we write into the same module instance the extension's
// registered content provider reads from.

async function activateWeld(): Promise<WeldExtensionApi> {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	return (await ext.activate()) as WeldExtensionApi;
}

describe("initial conflict content URI round-trip (VS Code host)", () => {
	it("openTextDocument on the returned URI yields the stored content", async () => {
		const api = await activateWeld();
		const docUri = Uri.file(
			`/tmp/weld-compare-roundtrip-${Date.now()}.txt`,
		);
		const content =
			"<<<<<<< HEAD\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> other\n";

		const conflictUri = api.setInitialConflictContent(docUri, content);
		const doc = await workspace.openTextDocument(conflictUri);
		try {
			assert.equal(doc.getText(), content);
		} finally {
			await window.showTextDocument(doc);
			await commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});
});

// Verifies that tree view failures show persistent ErrorTreeItem UI rather than
// silently returning empty lists or transient popups.
describe("error propagation and tree UI errors (VS Code host)", () => {
	// Top-level failure: entire tree replaced with single error item
	it("shows a single top-level tree error item when list loading fails", async () => {
		const provider = new ConflictedFilesProvider();
		const target = provider as unknown as {
			_getRootChildren: () => Promise<unknown[]>;
		};
		const originalGetRootChildren = target._getRootChildren.bind(provider);
		target._getRootChildren = () =>
			Promise.reject(new Error("forced top-level failure"));
		try {
			const children = await provider.getChildren();
			assert.equal(children.length, 1);
			const first = children[0];
			assert.ok(first instanceof ErrorTreeItem);
			assert.equal(first.label, "Failed to list conflicts");
			assert.match(String(first.description), TOP_LEVEL_FAILURE_REGEX);
		} finally {
			target._getRootChildren = originalGetRootChildren;
		}
	});

	// Real-code exercise of the per-repository catch: a real repository is
	// placed in merge conflict state (MERGE_HEAD present) but MERGE_MSG is
	// deliberately not written. _getOriginallyConflicted will then hit a real
	// FileNotFound from workspace.fs.readFile and the catch in
	// _buildItemsForRepository must surface a single ErrorTreeItem for that
	// repo. No prototype mocks: the failure, the catch, and the error-item
	// formatting are all executed for real.
	it("replaces a repository's subtree with an ErrorTreeItem when MERGE_MSG is missing", async () => {
		const repoPath = await makeRepo("weld-vscode-tree-missing-mergemsg-");
		try {
			await openRepoInGitExtension(repoPath);
			await writeFile(join(repoPath, ".git", "MERGE_HEAD"), "deadbeef\n");

			const gitApi = await getGitApi();
			const repository = gitApi.getRepository(Uri.file(repoPath));
			if (!repository) {
				throw new Error(
					`Expected git extension to expose repository for ${repoPath}`,
				);
			}

			const provider = new ConflictedFilesProvider();
			const target = provider as unknown as {
				_buildItemsForRepository: (
					repository: unknown,
				) => Promise<unknown[]>;
			};
			const children = await target._buildItemsForRepository(repository);
			assert.equal(children.length, 1);
			const first = children[0];
			assert.ok(first instanceof ErrorTreeItem);
			assert.match(String(first.label), PER_REPO_LABEL_REGEX);
			assert.match(
				String(first.description),
				PER_REPO_FILENOTFOUND_REGEX,
			);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});

// Verifies that autoMergeAll failures propagate with file context and cause,
// rather than being silently swallowed. Uses mock injection via extensions.getExtension
// patch to force repository.show() to fail on the first file.
describe("autoMergeAll command error propagation (VS Code host)", () => {
	it("rejects with file context and inner cause when repository.show fails", async () => {
		await activateWeld();

		// The test harness opens VS Code with a workspace folder (see runTest.ts)
		const workspaceFolder = workspace.workspaceFolders?.[0];
		assert.ok(
			workspaceFolder,
			"Test harness must provide a workspace folder via launchArgs",
		);
		const workspaceUri = workspaceFolder.uri;

		// extensions.getExtension() returns a NEW object each call, so we must
		// patch extensions.getExtension itself to intercept the git extension.
		const conflictUri = Uri.joinPath(workspaceUri, "tracked.txt");
		const changeEmitter = new EventEmitter<void>();

		let injectedFailureCalls = 0;
		let getExtensionCalls = 0;
		const getRepositoryCalls: string[] = [];

		const originalGetExtension = extensions.getExtension.bind(extensions);
		const extAny = extensions as {
			getExtension: typeof extensions.getExtension;
		};
		extAny.getExtension = ((id: string) => {
			getExtensionCalls++;
			const ext = originalGetExtension(id);
			if (id === "vscode.git" && ext) {
				const origGetAPI = ext.exports.getAPI.bind(ext.exports);
				ext.exports.getAPI = (version: number) => {
					const realApi = origGetAPI(version);
					const origGetRepo = realApi.getRepository.bind(realApi);
					realApi.getRepository = (uri: Uri) => {
						getRepositoryCalls.push(uri.toString());
						if (uri.toString() === workspaceUri.toString()) {
							return {
								rootUri: workspaceUri,
								state: {
									mergeChanges: [{ uri: conflictUri }],
									onDidChange: changeEmitter.event,
								},
								show: (): Promise<string> => {
									injectedFailureCalls++;
									return Promise.reject(
										new Error(
											"forced repository.show failure",
										),
									);
								},
								getCommit: () =>
									Promise.reject(new Error("not used")),
								getMergeBase: () =>
									Promise.reject(new Error("not used")),
								add: () =>
									Promise.reject(new Error("not used")),
							};
						}
						return origGetRepo(uri);
					};
					return realApi;
				};
			}
			return ext;
		}) as typeof extensions.getExtension;

		try {
			let commandError: unknown;
			try {
				await commands.executeCommand("meld-auto-merge.autoMergeAll");
			} catch (e: unknown) {
				commandError = e;
			}

			const debugInfo = [
				`workspaceFolders: ${JSON.stringify((workspace.workspaceFolders ?? []).map((f) => f.uri.toString()))}`,
				`workspaceUri: ${workspaceUri.toString()}`,
				`getExtensionCalls: ${getExtensionCalls}`,
				`getRepository calls: [${getRepositoryCalls.join(", ")}]`,
				`injectedFailureCalls: ${injectedFailureCalls}`,
				`commandError: ${commandError instanceof Error ? commandError.message : String(commandError)}`,
			].join("\n");

			assert.ok(
				commandError,
				`Command should have rejected.\n${debugInfo}`,
			);
			assert.match(
				commandError instanceof Error
					? commandError.message
					: String(commandError),
				AUTO_MERGE_ALL_FAILURE_REGEX,
				`Error didn't match.\n${debugInfo}`,
			);
		} finally {
			extAny.getExtension = originalGetExtension;
			changeEmitter.dispose();
		}
	});
});
