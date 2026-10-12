import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "mocha";
import type { TextDocument, WebviewPanel } from "vscode";
import {
	commands,
	extensions,
	Range,
	TabInputCustom,
	Uri,
	WorkspaceEdit,
	window,
	workspace,
} from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { getGitApi } from "../../../src/repoContext.ts";
import type {
	BaseDiffPayload,
	WebviewPayload,
} from "../../../src/webview/ui/types.ts";
import { runGit } from "../../runGit.ts";
import {
	lsFilesStages,
	makeConflict,
	makeRepo,
	makeSecondConflict,
	makeWeldResolvableConflict,
	openRepoInGitExtension,
	waitForMergeChanges,
	waitForRepoClose,
} from "./helpers.ts";

/* Original prompt:
Three-view merge editor tests
1. start vscode in a repo with conflicts, open the 3-view editor for a conflicted file, open both compare-with-base panes, verify the contents of both bases, local, remote and the file match what is expected, abort the merge, check we detect it and show the message that the file is no longer conflicted, also check the file contents updates to what's on disk
2. same as 1. but then re-create the merge conflict and verify the file updates to the auto-merged content and the message saying it's not conflicted goes away
3. same as 1. but create a NEW conflict in the same repo for the same with different base, local, remote, open both compare-with-base panes and verify all 5 panes contents match what's expected
*/

// ---------------------------------------------------------------------------
// Fake WebviewPanel
//
// Captures all messages sent via postMessage() and lets tests inject messages
// back via send(). The panel's onDidReceiveMessage listener is stored so that
// send() routes messages through the real _handleMessage / _handleReadyMessage
// handlers inside MeldCustomEditorProvider.
//
// Type casting: we use `as unknown as WebviewPanel` at call sites so we don't
// have to stub every property of the VS Code API surface.
// ---------------------------------------------------------------------------

interface CapturedMessage {
	command: string;
	data?: unknown;
}

function makeFakePanel() {
	const messages: CapturedMessage[] = [];
	const receiveListeners: Array<(msg: unknown) => unknown> = [];
	const disposeListeners: Array<() => void> = [];
	let disposed = false;

	const panel = {
		webview: {
			html: "",
			options: {} as {
				enableScripts?: boolean;
				localResourceRoots?: Uri[];
			},
			postMessage(msg: unknown): Thenable<boolean> {
				messages.push(msg as CapturedMessage);
				return Promise.resolve(true);
			},
			onDidReceiveMessage(listener: (e: unknown) => unknown): {
				dispose: () => void;
			} {
				receiveListeners.push(listener);
				return { dispose: () => undefined };
			},
			// asWebviewUri is called when building the webview HTML; return the
			// uri as-is since we never actually render the HTML in tests.
			asWebviewUri(uri: Uri): Uri {
				return uri;
			},
			cspSource: "none",
		},
		// Stubs for the remainder of the WebviewPanel interface
		viewType: "weld.mergeEditor",
		title: "Test",
		options: {},
		viewColumn: undefined,
		active: true,
		visible: true,
		onDidChangeViewState(_listener: () => void): { dispose: () => void } {
			return { dispose: () => undefined };
		},
		onDidDispose(listener: () => void): { dispose: () => void } {
			disposeListeners.push(listener);
			return { dispose: () => undefined };
		},
		dispose() {
			disposed = true;
			for (const h of disposeListeners) {
				h();
			}
		},

		// ------------------------------------------------------------------
		// Test helpers
		// ------------------------------------------------------------------

		// Route a message from the "webview" through all registered listeners.
		// Awaits each listener so async handlers (ready, requestBaseDiff, …)
		// complete before the caller continues.
		async send(msg: unknown): Promise<void> {
			await Promise.all(
				receiveListeners.map((listener) => listener(msg)),
			);
		},

		// Poll messages until one matching command (and optional predicate)
		// appears, or reject after timeoutMs.
		waitFor(
			command: string,
			predicate?: (m: CapturedMessage) => boolean,
			timeoutMs = 5000,
		): Promise<CapturedMessage> {
			return new Promise((resolve, reject) => {
				const deadline = Date.now() + timeoutMs;
				const check = () => {
					const found = messages
						.filter((m) => m.command === command)
						.find((m) => !predicate || predicate(m));
					if (found) {
						resolve(found);
						return;
					}
					if (Date.now() > deadline) {
						reject(
							new Error(
								`Timeout waiting for webview message "${command}"`,
							),
						);
						return;
					}
					setTimeout(check, 50);
				};
				check();
			});
		},

		get allMessages(): CapturedMessage[] {
			return messages;
		},
		get wasDisposed(): boolean {
			return disposed;
		},
	};

	return panel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolved in the before() hook to the bundled class so that static fields
// (e.g. onConflictStateChanged) are the same instance as the running extension.
let MeldProviderClass: WeldExtensionApi["meldCustomEditorProvider"];
let extensionApi: WeldExtensionApi;
const WELD_RESOLVABLE_RESULT = "A\nB\nREMOTE\nD\n";
const AUTO_MERGE_REFUSED = /Refusing to auto-merge/;

function stagedFileContent(repoPath: string, path: string): string {
	return runGit(["show", `:0:${path}`], repoPath);
}

before(async () => {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	extensionApi = (await ext.activate()) as WeldExtensionApi;
	MeldProviderClass = extensionApi.meldCustomEditorProvider;
});

// Opens a conflicted file in a fake MeldCustomEditorProvider panel, sends the
// "ready" handshake, and waits for the initial "loadDiff" message, then for
// _maybeApplyAutoMerge's fire-and-forget run (see its docstring) to settle
// and — since it writes to disk, not to `document` directly — for VS Code's
// external-change handling to bring `document` back in sync with that write,
// if the write changed anything. Returns the panel and the first loadDiff
// payload.
async function openEditorOnConflictedFile(repoPath: string) {
	const fileUri = Uri.file(join(repoPath, "tracked.txt"));
	// Use a real TextDocument so document.getText() / .version / .isDirty work
	// correctly inside _initializeWebview and _maybeApplyAutoMerge.
	const document = await workspace.openTextDocument(fileUri);
	const initialVersion = document.version;

	const panel = makeFakePanel();
	const provider = new MeldProviderClass(Uri.file("/tmp"));
	const autoMergeSettled = waitForAutoMergeOnOpenSettled(fileUri);
	await provider.resolveCustomTextEditor(
		document,
		panel as unknown as WebviewPanel,
		{} as never,
	);

	// Trigger the ready handshake. _handleReadyMessage is async (fetches git
	// stages, builds snapshot), so we wait for the resulting loadDiff.
	await panel.send({ command: "ready" });
	const loadDiff = await panel.waitFor("loadDiff");
	await autoMergeSettled;
	await waitForDocumentToMatchDisk(document, initialVersion);

	return { panel, document, loadDiff };
}

// Awaits MeldCustomEditorProvider.onAutoMergeOnOpenSettled for a specific
// document, the real completion signal for _maybeApplyAutoMerge's
// fire-and-forget run — not a document-change event, which never fires for
// some outcomes (e.g. skippedWouldClobber).
function waitForAutoMergeOnOpenSettled(documentUri: Uri): Promise<void> {
	return new Promise((resolve) => {
		const sub = MeldProviderClass.onAutoMergeOnOpenSettled.event((uri) => {
			if (uri.toString() === documentUri.toString()) {
				sub.dispose();
				resolve();
			}
		});
	});
}

// Only call after the disk-oriented write this document is waiting on has
// already happened (e.g. after onAutoMergeOnOpenSettled): VS Code's own
// external-file-change handling is what reloads an open, non-dirty document
// after such a write, and this only resolves once that has actually landed.
// No timeout: since the write is already known to have happened, a matching
// change event is guaranteed unless the document already held that text
// (the "already applied"/no-op outcomes), which the version check catches.
async function waitForDocumentToMatchDisk(
	document: TextDocument,
	priorVersion: number,
): Promise<void> {
	if (document.version !== priorVersion) {
		return;
	}
	const diskText = await workspace.fs
		.readFile(document.uri)
		.then((bytes) => new TextDecoder().decode(bytes));
	if (document.getText() === diskText) {
		return;
	}
	await new Promise<void>((resolve) => {
		const sub = workspace.onDidChangeTextDocument((event) => {
			if (
				event.document.uri.toString() === document.uri.toString() &&
				event.document.version !== priorVersion
			) {
				sub.dispose();
				resolve();
			}
		});
	});
}

async function closeRepoAndRemove(repoPath: string): Promise<void> {
	const repo = getGitApi().getRepository(Uri.file(repoPath));
	if (repo) {
		await commands.executeCommand("git.close", repo);
	}
	await rm(repoPath, {
		recursive: true,
		force: true,
		maxRetries: 3,
		retryDelay: 100,
	});
}

// Extract typed payload from a captured loadDiff message.
function asLoadDiff(msg: CapturedMessage): WebviewPayload["data"] {
	return msg.data as WebviewPayload["data"];
}

// Extract typed payload from a captured loadBaseDiff message.
function asBaseDiff(msg: CapturedMessage): BaseDiffPayload {
	return msg.data as BaseDiffPayload;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeldCustomEditorProvider — initial pane contents and merge abort (VS Code host)", () => {
	it("shows correct pane contents, detects merge abort via conflictStateLost, and reflects disk state", async () => {
		// Merge editor test 1:
		//   - Open the 3-view editor for a conflicted file
		//   - Open both compare-with-base panes (requestBaseDiff left + right)
		//   - Verify local, remote, merged (working), and both base pane contents
		//   - Run `git merge --abort`
		//   - Verify the webview receives "conflictStateLost"
		//   - Verify the file on disk is back to the pre-merge local content
		const repoPath = await makeRepo("weld-me-abort-");
		try {
			// Conflict: stage1=base, stage2=local, stage3=remote
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const { panel, loadDiff: loadDiffMsg } =
				await openEditorOnConflictedFile(repoPath);

			const diff = asLoadDiff(loadDiffMsg);

			// Local and remote panes come directly from git stages 2 and 3.
			assert.equal(diff.files[0].content, "local\n", "local pane");
			assert.equal(diff.files[2].content, "remote\n", "remote pane");

			// The working/merged pane reflects what's on disk. With the default
			// git conflict style (no |||||||  diff3 markers), _maybeApplyAutoMerge
			// exits early, so the file still has raw conflict markers.
			assert.ok(
				diff.files[1].content.includes("<<<<<<<"),
				"merged pane should contain conflict markers",
			);

			// --- Open left compare-with-base pane (base vs local) ---
			await panel.send({ command: "requestBaseDiff", side: "left" });
			const leftMsg = await panel.waitFor(
				"loadBaseDiff",
				(m) => (m.data as BaseDiffPayload)?.side === "left",
			);
			assert.equal(
				asBaseDiff(leftMsg).file.content,
				"base\n",
				"left base pane content",
			);

			// --- Open right compare-with-base pane (base vs remote) ---
			await panel.send({ command: "requestBaseDiff", side: "right" });
			const rightMsg = await panel.waitFor(
				"loadBaseDiff",
				(m) => (m.data as BaseDiffPayload)?.side === "right",
			);
			assert.equal(
				asBaseDiff(rightMsg).file.content,
				"base\n",
				"right base pane content (same base as left)",
			);

			// --- Abort the merge ---
			runGit(["merge", "--abort"], repoPath);
			await waitForMergeChanges(repo, 0);
			await panel.waitFor("conflictStateLost");

			// The file on disk should now be the local-branch content ("local\n")
			// since merge --abort restores the working tree to the pre-merge state.
			const diskContent = await readFile(
				join(repoPath, "tracked.txt"),
				"utf8",
			);
			assert.equal(
				diskContent,
				"local\n",
				"disk content after merge --abort",
			);

			panel.dispose();
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

describe("MeldCustomEditorProvider — conflict reload after new merge (VS Code host)", () => {
	it("reloads with updated stages and clears conflictStateLost when a new conflict is created", async () => {
		// Merge editor test 2:
		//   - Same setup as test 1 through the conflictStateLost step
		//   - Then recreate a merge conflict in the same repo
		//   - Fire onConflictStateChanged with a new stateKey
		//   - Verify the panel receives a fresh "loadDiff" (not another conflictStateLost)
		//   - Verify the new payload reflects the new conflict stages
		const repoPath = await makeRepo("weld-me-recreate-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const { panel } = await openEditorOnConflictedFile(repoPath);

			// Abort first conflict (same as test 1)
			runGit(["merge", "--abort"], repoPath);
			await waitForMergeChanges(repo, 0);
			await panel.waitFor("conflictStateLost");

			// Count before creating the second conflict so the reload's loadDiff
			// is guaranteed to arrive after this snapshot (watchRepo fires within
			// the debounce window, before waitForMergeChanges resolves).
			const loadDiffsBefore = panel.allMessages.filter(
				(m) => m.command === "loadDiff",
			).length;

			// Create a second conflict: stage1=local, stage2=local2, stage3=remote2
			makeSecondConflict(repoPath);
			await waitForMergeChanges(repo, 1);

			// Wait for a second loadDiff (the reload)
			await panel.waitFor(
				"loadDiff",
				() =>
					panel.allMessages.filter((m) => m.command === "loadDiff")
						.length > loadDiffsBefore,
			);
			// waitFor returns the first match; we need the newly-arrived one.
			const newLoadDiff = panel.allMessages
				.filter((m) => m.command === "loadDiff")
				.at(-1);
			assert.ok(newLoadDiff);
			const diff = asLoadDiff(newLoadDiff);

			// New conflict stages: local2 and remote2
			assert.equal(diff.files[0].content, "local2\n", "new local pane");
			assert.equal(diff.files[2].content, "remote2\n", "new remote pane");

			// The "message saying it's not conflicted" (conflictStateLost) should
			// not be the most recent command — a loadDiff came after it.
			const lastCommand =
				panel.allMessages.at(-1)?.command ??
				panel.allMessages.at(-2)?.command;
			assert.notEqual(
				lastCommand,
				"conflictStateLost",
				"conflictStateLost should not be the final message",
			);

			panel.dispose();
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

describe("MeldCustomEditorProvider — all 5 panes after conflict switch (VS Code host)", () => {
	it("shows correct content in all 5 panes after switching to a new conflict with different stages", async () => {
		// Merge editor test 3:
		//   - Open editor on conflict #1 (base="base\n", local="local\n", remote="remote\n")
		//   - Abort, then create conflict #2 (base="local\n", local="local2\n", remote="remote2\n")
		//   - Fire onConflictStateChanged to reload the editor
		//   - Open both compare-with-base panes
		//   - Verify all 5 pane contents match the new conflict's expected values:
		//       left-base, local, merged(working), remote, right-base
		const repoPath = await makeRepo("weld-me-new-conflict-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const { panel } = await openEditorOnConflictedFile(repoPath);

			// Abort conflict #1 and create conflict #2
			runGit(["merge", "--abort"], repoPath);
			await waitForMergeChanges(repo, 0);
			await panel.waitFor("conflictStateLost");

			// Count before creating the second conflict (see test 2 for rationale).
			const loadDiffsBefore = panel.allMessages.filter(
				(m) => m.command === "loadDiff",
			).length;

			makeSecondConflict(repoPath);
			await waitForMergeChanges(repo, 1);

			await panel.waitFor(
				"loadDiff",
				() =>
					panel.allMessages.filter((m) => m.command === "loadDiff")
						.length > loadDiffsBefore,
			);
			// waitFor returns the first match; we need the newly-arrived one.
			const newLoadDiff = panel.allMessages
				.filter((m) => m.command === "loadDiff")
				.at(-1);
			assert.ok(newLoadDiff);
			const diff = asLoadDiff(newLoadDiff);

			// --- Pane 2: local (git stage 2 = "local2\n") ---
			assert.equal(diff.files[0].content, "local2\n", "local pane");

			// --- Pane 4: remote (git stage 3 = "remote2\n") ---
			assert.equal(diff.files[2].content, "remote2\n", "remote pane");

			// --- Pane 1: left base (base vs local) → base = git stage 1 = "local\n" ---
			await panel.send({ command: "requestBaseDiff", side: "left" });
			const leftMsg = await panel.waitFor(
				"loadBaseDiff",
				(m) => (m.data as BaseDiffPayload)?.side === "left",
			);
			assert.equal(
				asBaseDiff(leftMsg).file.content,
				"local\n",
				"left base pane (conflict #2 base = former local content)",
			);

			// --- Pane 5: right base (base vs remote) → same base ---
			await panel.send({ command: "requestBaseDiff", side: "right" });
			const rightMsg = await panel.waitFor(
				"loadBaseDiff",
				(m) => (m.data as BaseDiffPayload)?.side === "right",
			);
			assert.equal(
				asBaseDiff(rightMsg).file.content,
				"local\n",
				"right base pane (same base as left)",
			);

			panel.dispose();
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

describe("MeldCustomEditorProvider — real editor coexistence (VS Code host)", () => {
	it("opens the actual three-view tab from a file already open in the default editor", async () => {
		const repoPath = await makeRepo("weld-open-default-then-three-view-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const fileUri = Uri.file(join(repoPath, "tracked.txt"));
			const defaultDocument = await workspace.openTextDocument(fileUri);
			const defaultEditor =
				await window.showTextDocument(defaultDocument);
			assert.equal(defaultEditor.document, defaultDocument);
			assert.ok(
				defaultDocument.getText().includes("<<<<<<<"),
				"the normal editor should expose Git's unresolved working-tree text",
			);

			await commands.executeCommand(
				"vscode.openWith",
				fileUri,
				MeldProviderClass.viewType,
			);
			const customTab = window.tabGroups.all
				.flatMap((group) => group.tabs)
				.find(
					(tab) =>
						tab.input instanceof TabInputCustom &&
						tab.input.uri.toString() === fileUri.toString() &&
						tab.input.viewType === MeldProviderClass.viewType,
				);
			assert.ok(customTab, "expected an actual Weld custom-editor tab");
			assert.equal(
				defaultDocument.getText(),
				(await workspace.openTextDocument(fileUri)).getText(),
				"the normal editor must retain the same live document",
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
				"opening the three-view editor must not resolve an ordinary conflict",
			);
			await commands.executeCommand("workbench.action.closeAllEditors");
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});

	it("opening the real three-view tab preserves a dirty default-editor buffer", async () => {
		const repoPath = await makeRepo("weld-open-three-view-dirty-buffer-");
		try {
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);
			const uri = Uri.file(join(repoPath, "tracked.txt"));
			const document = await workspace.openTextDocument(uri);
			await window.showTextDocument(document);
			const userBuffer = "user's unsaved three-view edit\n";
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				userBuffer,
			);
			assert.equal(await workspace.applyEdit(edit), true);
			await commands.executeCommand(
				"vscode.openWith",
				uri,
				MeldProviderClass.viewType,
			);

			assert.equal(document.getText(), userBuffer);
			assert.equal(document.isDirty, true);
			assert.ok((await readFile(uri.fsPath, "utf8")).includes("<<<<<<<"));
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
			);
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

describe("MeldCustomEditorProvider — clean default editor auto-merge (VS Code host)", () => {
	it("updates and stages a default editor's document when Weld resolves a Git conflict", async () => {
		const repoPath = await makeRepo("weld-open-default-then-automerge-");
		try {
			// Local deletes C while remote adds a neighboring line. Git leaves this
			// unmerged, but Weld can retain the deletion and addition together.
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const document = await workspace.openTextDocument(
				Uri.file(join(repoPath, "tracked.txt")),
			);
			await window.showTextDocument(document);
			assert.ok(
				document.getText().includes("<<<<<<<"),
				"Git must leave the fixture conflicted before Weld runs",
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
			);

			await commands.executeCommand("meld-auto-merge.autoMerge");
			await waitForMergeChanges(repo, 0);

			assert.equal(
				document.getText(),
				"A\nB\nREMOTE\nD\n",
				"the already-open default editor must show Weld's combined resolution",
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set(),
				"Weld's complete resolution must be staged",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

describe("MeldCustomEditorProvider — Command Palette disk authority (VS Code host)", () => {
	it("uses the real tree item path and stages the disk candidate", async () => {
		const repoPath = await makeRepo("weld-tree-automerge-authority-");
		try {
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);
			const uri = Uri.file(join(repoPath, "tracked.txt"));
			const item = (
				await extensionApi.conflictedFilesProvider.getChildren()
			).find(
				(candidate) =>
					"uri" in candidate &&
					candidate.uri.toString() === uri.toString(),
			);
			assert.ok(
				item,
				"expected the Git tree's real conflicted-file item",
			);

			await commands.executeCommand("meld-auto-merge.autoMerge", item);

			assert.equal(
				await readFile(uri.fsPath, "utf8"),
				WELD_RESOLVABLE_RESULT,
			);
			assert.equal(
				stagedFileContent(repoPath, "tracked.txt"),
				WELD_RESOLVABLE_RESULT.trim(),
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

describe("MeldCustomEditorProvider — active-editor command authority (VS Code host)", () => {
	it("refuses to replace a dirty active editor", async () => {
		const repoPath = await makeRepo("weld-command-automerge-dirty-buffer-");
		try {
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const document = await workspace.openTextDocument(
				Uri.file(join(repoPath, "tracked.txt")),
			);
			await window.showTextDocument(document);
			const diskBefore = await readFile(document.uri.fsPath, "utf8");
			const userBuffer = "user's unsaved Command Palette resolution\n";
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				userBuffer,
			);
			assert.equal(await workspace.applyEdit(edit), true);
			assert.equal(document.isDirty, true);

			await assert.rejects(
				Promise.resolve(
					commands.executeCommand("meld-auto-merge.autoMerge"),
				),
				AUTO_MERGE_REFUSED,
			);

			assert.equal(document.getText(), userBuffer);
			assert.equal(document.isDirty, true);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				diskBefore,
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

describe("MeldCustomEditorProvider — batch disk authority (VS Code host)", () => {
	it("does not auto-merge a disk edit made after the conflict when no editor is open", async () => {
		const repoPath = await makeRepo("weld-automerge-disk-change-closed-");
		try {
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const externalEdit = "resolved outside vscode\n";
			await writeFile(join(repoPath, "tracked.txt"), externalEdit);
			await commands.executeCommand("meld-auto-merge.autoMergeAll");

			assert.equal(
				await readFile(join(repoPath, "tracked.txt"), "utf8"),
				externalEdit,
				"auto-merge must preserve an external disk edit",
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
				"a changed file must remain unresolved",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

describe("MeldCustomEditorProvider — external-save handling (VS Code host)", () => {
	it("uses VS Code's save-conflict handling after a real three-view tab has an external disk change", async () => {
		const repoPath = await makeRepo("weld-three-view-external-save-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const document = await workspace.openTextDocument(
				Uri.file(join(repoPath, "tracked.txt")),
			);
			await window.showTextDocument(document);
			const autoMergeSettled = waitForAutoMergeOnOpenSettled(
				document.uri,
			);
			await commands.executeCommand(
				"vscode.openWith",
				document.uri,
				MeldProviderClass.viewType,
			);
			// Opening the custom editor triggers auto-merge-on-open, which reads
			// disk (still the raw conflict at this point) and may write its own
			// candidate back to disk. Wait for that fire-and-forget run to settle
			// before this test makes its own disk/document edits below, or the two
			// writes race.
			await autoMergeSettled;
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				"resolved in VS Code\n",
			);
			assert.equal(await workspace.applyEdit(edit), true);
			const externalEdit = "resolved outside vscode\n";
			await writeFile(document.uri.fsPath, externalEdit);

			assert.equal(
				await document.save(),
				false,
				"VS Code must reject saving over a newer on-disk file",
			);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				externalEdit,
				"VS Code must preserve the external file content",
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
				"a rejected save must not stage the file",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

// Regression: handleActiveEditorSmartAdd and readSavedDocument (used by the
// tree/URI "Git Add" command) used to ignore document.save()'s return value,
// so a rejected save (external disk change) fell through to reading the
// stale in-memory text and staging whatever was actually on disk as if it
// had been verified. Both must now throw instead of silently proceeding.
describe("MeldCustomEditorProvider — smart-add save-conflict handling (VS Code host)", () => {
	it("fails loudly instead of staging unverified disk content when save is rejected", async () => {
		const repoPath = await makeRepo("weld-smart-add-save-conflict-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const document = await workspace.openTextDocument(
				Uri.file(join(repoPath, "tracked.txt")),
			);
			await window.showTextDocument(document);
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				"resolved in VS Code\n",
			);
			assert.equal(await workspace.applyEdit(edit), true);
			const externalEdit = "resolved outside vscode differently\n";
			await writeFile(document.uri.fsPath, externalEdit);

			// The contract, not the wording: a rejected save must fail the
			// command loudly rather than stage the disk content as if the
			// in-memory text had been verified — the disk/stage assertions
			// below are what actually prove that held.
			await assert.rejects(
				Promise.resolve(
					commands.executeCommand("meld-auto-merge.smartAdd"),
				),
			);

			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				externalEdit,
				"the rejected save must leave the external disk content untouched",
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
				"a rejected save must never be followed by git add",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

// VS Code's public API cannot inject a click into a real webview. This drives
// the provider's registered webview message handler with a real TextDocument;
// the real-tab test above separately establishes VS Code's save-conflict
// behavior. It verifies the completion boundary after that save returns false.
describe("MeldCustomEditorProvider — completeMerge message handling", () => {
	it("completes a conflict Weld resolved when the three-view editor opened", async () => {
		const repoPath = await makeRepo("weld-automerge-open-then-complete-");
		try {
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			// This is the same provider message the real button posts. The
			// document, Git repository, and filesystem are real; FakeWebviewPanel
			// is used only because VS Code exposes no API to inject a click into a
			// live webview.
			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);
			await window.showTextDocument(document);
			assert.equal(document.getText(), WELD_RESOLVABLE_RESULT);
			await panel.send({ command: "completeMerge" });

			assert.equal(panel.wasDisposed, true);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				WELD_RESOLVABLE_RESULT,
			);
			assert.equal(
				stagedFileContent(repoPath, "tracked.txt"),
				WELD_RESOLVABLE_RESULT.trim(),
			);
			assert.deepEqual(lsFilesStages(repoPath, "tracked.txt"), new Set());
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

describe("MeldCustomEditorProvider — completeMerge outcomes", () => {
	it("saves, stages, and disposes a clean resolution", async () => {
		const repoPath = await makeRepo("weld-complete-merge-success-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);
			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);
			await window.showTextDocument(document);
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				"resolved in the three-way editor\n",
			);
			assert.equal(await workspace.applyEdit(edit), true);
			await panel.send({ command: "completeMerge" });
			assert.equal(panel.wasDisposed, true);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				"resolved in the three-way editor\n",
			);
			assert.equal(
				stagedFileContent(repoPath, "tracked.txt"),
				"resolved in the three-way editor",
			);
			assert.deepEqual(lsFilesStages(repoPath, "tracked.txt"), new Set());
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});

	it("does not save, stage, or dispose unresolved markers", async () => {
		const repoPath = await makeRepo("weld-complete-merge-unresolved-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);
			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);
			await window.showTextDocument(document);
			const before = await readFile(document.uri.fsPath, "utf8");
			await panel.send({ command: "completeMerge" });
			assert.equal(panel.wasDisposed, false);
			assert.equal(await readFile(document.uri.fsPath, "utf8"), before);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
			);
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

describe("MeldCustomEditorProvider — completeMerge external disk changes", () => {
	it("does not stage or dispose an externally changed clean disk file", async () => {
		const repoPath = await makeRepo(
			"weld-complete-merge-clean-save-conflict-",
		);
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);
			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);
			await window.showTextDocument(document);
			const resolvedBuffer = "resolved in the three-way editor\n";
			const externalDiskText = "resolved outside VS Code\n";
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				resolvedBuffer,
			);
			assert.equal(await workspace.applyEdit(edit), true);
			await writeFile(document.uri.fsPath, externalDiskText);
			await panel.send({ command: "completeMerge" });
			assert.equal(panel.wasDisposed, false);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				externalDiskText,
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
			);
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});

	it("does not stage or dispose an externally changed disk file with markers", async () => {
		const repoPath = await makeRepo("weld-complete-merge-save-conflict-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);
			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);
			await window.showTextDocument(document);
			const resolvedBuffer = "resolved in the three-way editor\n";
			// The external write changes disk after the panel opens, but leaves the
			// original conflict markers there. This is the marker-staging failure
			// reported by users.
			const externalDiskText = `${await readFile(
				document.uri.fsPath,
				"utf8",
			)}external writer changed this file\n`;
			assert.ok(externalDiskText.includes("<<<<<<<"));
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				resolvedBuffer,
			);
			assert.equal(await workspace.applyEdit(edit), true);
			await writeFile(document.uri.fsPath, externalDiskText);

			await panel.send({ command: "completeMerge" });

			assert.equal(panel.wasDisposed, false);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				externalDiskText,
			);
			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
			);
		} finally {
			await closeRepoAndRemove(repoPath);
		}
	});
});

// Regression guard: opening the merge editor on a Weld-resolvable conflict
// (git cannot auto-resolve it, but Weld's algorithm can) used to replace the
// document content via its own separate implementation that never staged
// the result — Git kept reporting the file unmerged even though the editor
// had already "fixed" it. _maybeApplyAutoMerge now goes through
// performAutoMerge, the same shared function extension.ts's commands and
// agent tools use, so the editor path gets staging for free.
describe("MeldCustomEditorProvider — auto-merge on open (VS Code host)", () => {
	it("stages the file once opening the editor auto-merges it", async () => {
		const repoPath = await makeRepo("weld-editor-automerge-");
		try {
			makeWeldResolvableConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			if (!repo) {
				throw new Error(`Expected git repository at ${repoPath}`);
			}
			await waitForMergeChanges(repo, 1);

			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set([1, 2, 3]),
				"expected the file to start unmerged",
			);

			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);
			// _maybeApplyAutoMerge runs fire-and-forget from
			// resolveCustomTextEditor (see its call site's "Note:" comment) —
			// openEditorOnConflictedFile only awaits the initial loadDiff, not
			// the auto-merge itself, so wait for git to actually observe the
			// stage drop before asserting on it.
			await waitForMergeChanges(repo, 0);
			panel.dispose();

			assert.deepEqual(
				lsFilesStages(repoPath, "tracked.txt"),
				new Set(),
				"expected the editor's auto-merge to stage the file",
			);
			assert.equal(
				document.getText(),
				WELD_RESOLVABLE_RESULT,
				"the open document must reflect Weld's auto-merge result, not just the disk file",
			);
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});

// Regression: the webview's "save" message handler used to ignore
// document.save()'s return value and, separately, _handleMessage never
// awaited the queued edit/save step at all (deliberately, to keep typing
// responsive — see _setupPerEditorListeners), so a failure there had no path
// back to the webview's own "error" message channel. Worse, because the
// queued step just chained onto editState.editQueue via .then(), a rejected
// step poisoned that promise forever: every later message chained onto the
// same queue would silently no-op, since .then() on a rejected promise
// skips its callback. This verifies both: the webview is told about a
// rejected save, and the queue keeps working afterward.
describe("MeldCustomEditorProvider — webview save-conflict handling (VS Code host)", () => {
	it("reports a rejected save to the webview and keeps the edit queue alive", async () => {
		const repoPath = await makeRepo("weld-webview-save-conflict-");
		try {
			makeConflict(repoPath);
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo);
			await waitForMergeChanges(repo, 1);

			const { panel, document } =
				await openEditorOnConflictedFile(repoPath);

			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				"resolved in VS Code\n",
			);
			assert.equal(await workspace.applyEdit(edit), true);
			const externalEdit = "resolved outside vscode differently\n";
			await writeFile(document.uri.fsPath, externalEdit);

			await panel.send({
				command: "save",
				lastExternalChangeVersion: document.version,
			});
			// Matched by which command failed, not by the failure's wording:
			// the title names the message type that was being handled
			// ("save"), which is the stable, implementation-independent
			// signal that this is the error this test is waiting for.
			await panel.waitFor("error", (m) =>
				String(
					(m as unknown as { title?: string }).title ?? "",
				).includes("'save'"),
			);
			assert.equal(
				await readFile(document.uri.fsPath, "utf8"),
				externalEdit,
				"a rejected save must leave the external disk content untouched",
			);

			// The queue must still be usable: fix the conflict, then confirm a
			// later save actually goes through instead of silently no-op'ing.
			const resolvingEdit = new WorkspaceEdit();
			resolvingEdit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
				externalEdit,
			);
			assert.equal(await workspace.applyEdit(resolvingEdit), true);
			const saved = new Promise<void>((resolve) => {
				const sub = workspace.onDidSaveTextDocument((saved) => {
					if (saved.uri.toString() === document.uri.toString()) {
						sub.dispose();
						resolve();
					}
				});
			});
			await panel.send({
				command: "save",
				lastExternalChangeVersion: document.version,
			});
			await saved;
			assert.equal(
				document.isDirty,
				false,
				"a later save on the same queue must still succeed",
			);

			panel.dispose();
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});
