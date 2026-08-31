import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "mocha";
import sinon from "sinon";
import {
	commands,
	EventEmitter,
	extensions,
	Uri,
	window,
	workspace,
} from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { GitStatus, getGitApi } from "../../../src/repoContext.ts";
import {
	ConflictedFilesProvider,
	ErrorTreeItem,
} from "../../../src/treeView.ts";
import {
	lsFilesStages,
	makeAllConflictKindsRepo,
	makeRepo,
	makeWeldResolvableConflict,
	openRepoInGitExtension,
	waitForRepoClose,
	withConflictRepo,
	workingTreeContent,
} from "./helpers.ts";

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
		const stub = sinon
			.stub(
				provider as unknown as {
					_getRootChildren: () => Promise<unknown[]>;
				},
				"_getRootChildren",
			)
			.rejects(new Error("forced top-level failure"));
		try {
			const children = await provider.getChildren();
			assert.equal(children.length, 1);
			const first = children[0];
			assert.ok(first instanceof ErrorTreeItem);
			assert.equal(first.label, "Failed to list conflicts");
			assert.match(String(first.description), TOP_LEVEL_FAILURE_REGEX);
		} finally {
			stub.restore();
		}
	});

	// Real-code exercise of the per-repository catch: a real repository is
	// placed in merge conflict state (MERGE_HEAD present) but MERGE_MSG is
	// deliberately not written. _getResolvedFileUris will then hit a real
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
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
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

		// Patch ext.exports.getAPI directly — ext.exports is shared across all
		// calls to extensions.getExtension, so this survives wrapper churn and
		// can be cleanly restored in finally (unlike patching getExtension itself).
		const conflictUri = Uri.joinPath(workspaceUri, "tracked.txt");
		const changeEmitter = new EventEmitter<void>();

		let injectedFailureCalls = 0;
		const getRepositoryCalls: string[] = [];

		const gitExt = extensions.getExtension("vscode.git");
		assert.ok(gitExt, "Git extension must be available");
		const origGetAPI = gitExt.exports.getAPI.bind(gitExt.exports);

		const mockRepo = {
			rootUri: workspaceUri,
			state: {
				mergeChanges: [
					{ uri: conflictUri, status: GitStatus.BOTH_MODIFIED },
				],
				onDidChange: changeEmitter.event,
			},
			// collectAutoMergeableFiles classifies via conflictStatus()
			// before autoMergeAll ever calls performAutoMerge, which only
			// ever reads stages 2 and 3 (never 1 — see computeConflictStatus
			// in repoContext.ts). Resolving those lets classification
			// correctly see a bothModified conflict and proceed to the real
			// merge, where fetchConflictStages' stage-1 read hits the
			// injected failure this test exists to observe.
			show: (ref: string): Promise<string> => {
				if (ref === ":2" || ref === ":3") {
					return Promise.resolve("stage content\n");
				}
				injectedFailureCalls++;
				return Promise.reject(
					new Error("forced repository.show failure"),
				);
			},
			getCommit: () => Promise.reject(new Error("not used")),
			getMergeBase: () => Promise.reject(new Error("not used")),
			add: () => Promise.reject(new Error("not used")),
		};

		const getAPIStub = sinon
			.stub(gitExt.exports, "getAPI")
			.callsFake((...args: unknown[]) => {
				const realApi = origGetAPI(args[0] as number);
				Object.defineProperty(realApi, "repositories", {
					get: () => [mockRepo],
					configurable: true,
				});
				const origGetRepo = realApi.getRepository.bind(realApi);
				realApi.getRepository = (uri: Uri) => {
					getRepositoryCalls.push(uri.toString());
					if (uri.toString() === workspaceUri.toString()) {
						return mockRepo;
					}
					return origGetRepo(uri);
				};
				return realApi;
			});

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
			getAPIStub.restore();
			changeEmitter.dispose();
		}
	});
});

// Two regression guards sharing one repo and one merge (makeAllConflictKindsRepo)
// rather than a fixture per kind:
//
// 1. A both-added conflict has no Git stage 1 (no common ancestor), so
//    fetching it directly threw "Could not get git content for stage 1 ...
//    Is it in conflict?" performAutoMerge must go through
//    fetchConflictStages, which already substitutes "" for a missing base
//    (the same convention createThreeWayComparison relies on).
// 2. autoMergeAll iterated every conflicted file and called performAutoMerge
//    unconditionally, assuming every conflict is a 3-way text merge.
//    deletedByUs/deletedByThem/bothDeleted conflicts are missing a stage
//    performAutoMerge needs, so it crashed deep in Git's plumbing ("Could
//    not show object") instead of never attempting them in the first place.
//    collectAutoMergeableFiles filters to conflictStatus()'s bothModified
//    (the same classifier handleOpenMeldDiff already uses) before
//    autoMergeAll ever calls performAutoMerge — these kinds were never
//    auto-merge candidates, so they are simply not in its candidate set,
//    not a failure to catch or report.
describe("autoMergeAll conflict classification (VS Code host)", () => {
	it("merges only the auto-mergeable files, leaving the rest untouched", () =>
		withConflictRepo(
			"weld-automerge-all-kinds-",
			makeAllConflictKindsRepo,
			async (repoPath) => {
				await commands.executeCommand("meld-auto-merge.autoMergeAll");

				// Eligible (bothModified) files were genuinely attempted:
				// both sides' real content shows up (the both-added file's
				// fix — no stage-1 crash) rather than the fixture's plain
				// "shared" placeholder, even though neither file's single
				// differing line can auto-resolve without a real edit.
				const addedText = workingTreeContent(repoPath, "added.txt");
				assert.ok(addedText, "expected added.txt to be readable");
				assert.ok(addedText.includes("local version"), addedText);
				assert.ok(addedText.includes("remote version"), addedText);
				const trackedText = workingTreeContent(repoPath, "tracked.txt");
				assert.ok(trackedText, "expected tracked.txt to be readable");
				assert.ok(trackedText.includes("local"), trackedText);
				assert.ok(trackedText.includes("remote"), trackedText);
				// binary.bin is bothModified too (also eligible), so it was
				// attempted rather than silently skipped or crashed on just
				// because its content is not text: the file changed from
				// its pre-merge content instead of being left untouched.
				const binaryText = workingTreeContent(repoPath, "binary.bin");
				assert.ok(binaryText, "expected binary.bin to be readable");
				assert.notEqual(binaryText, "base\0content\n");

				// Ineligible kinds were never attempted: still mid-merge,
				// with no <<<<<<< markers ever written for them either,
				// since Git's own index — not a merge attempt — is what
				// makes them conflicted.
				assert.deepEqual(
					lsFilesStages(repoPath, "local-deletes.txt"),
					new Set([1, 2]),
				);
				assert.deepEqual(
					lsFilesStages(repoPath, "remote-deletes.txt"),
					new Set([1, 3]),
				);
				assert.deepEqual(
					lsFilesStages(repoPath, "both-deleted.txt"),
					new Set([1]),
				);
			},
			{ expectedConflictCount: 6 },
		));
});

// Regression guard: performAutoMerge used to overwrite the live document
// unconditionally, computed only from Git's index stages — an edit already
// made to the file (by hand or another tool) since the conflict was
// created was silently destroyed. It now refuses (single-file — see
// "rejects a clobbering write" in agent-tools.test.ts) or skips (batch)
// instead, comparing the live document against both the raw pre-merge
// conflict markers and the auto-merge result before ever writing.
describe("auto-merge clobber protection (VS Code host)", () => {
	it("autoMergeAll skips a clobbered file instead of aborting the batch", () =>
		withConflictRepo(
			"weld-automerge-clobber-batch-",
			makeAllConflictKindsRepo,
			async (repoPath) => {
				const filePath = join(repoPath, "tracked.txt");
				await writeFile(filePath, "someone's actual edit\n");

				await commands.executeCommand("meld-auto-merge.autoMergeAll");

				// Skipped, not aborted: added.txt and binary.bin (also
				// eligible) were still attempted despite tracked.txt's
				// clobber risk — a would-clobber file never stops the batch.
				assert.equal(
					workingTreeContent(repoPath, "tracked.txt"),
					"someone's actual edit\n",
					"the edit must survive the batch run untouched",
				);
				const addedText = workingTreeContent(repoPath, "added.txt");
				assert.ok(addedText, "expected added.txt to be readable");
				assert.ok(addedText.includes("local version"), addedText);
			},
			{ expectedConflictCount: 6 },
		));
});

// Regression guard for the same-named feature: once a file's merge leaves
// zero remaining conflicts, Weld must stage it (git add) — the point of
// auto-merge is to finish the file, not just edit its text and leave Git
// still reporting it unmerged.
describe("auto-merge staging (VS Code host)", () => {
	it("stages a file once Weld's auto-merge fully resolves it", () =>
		withConflictRepo(
			"weld-automerge-stage-",
			makeWeldResolvableConflict,
			async (repoPath) => {
				assert.deepEqual(
					lsFilesStages(repoPath, "tracked.txt"),
					new Set([1, 2, 3]),
					"expected the file to start unmerged",
				);

				await commands.executeCommand("meld-auto-merge.autoMergeAll");

				assert.deepEqual(
					lsFilesStages(repoPath, "tracked.txt"),
					new Set(),
					"expected Weld to stage the file once it was fully resolved",
				);
			},
		));
});
