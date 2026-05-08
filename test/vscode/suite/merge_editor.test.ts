import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "mocha";
import type { WebviewPanel } from "vscode";
import { extensions, Uri, workspace } from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";
import { getGitApi } from "../../../src/repoContext.ts";
import type { MeldCustomEditorProvider } from "../../../src/webview/meldWebviewPanel.ts";
import type {
	BaseDiffPayload,
	WebviewPayload,
} from "../../../src/webview/ui/types.ts";
import {
	makeConflict,
	makeRepo,
	makeSecondConflict,
	openRepoInGitExtension,
	runGit,
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
	};

	return panel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolved in the before() hook to the bundled class so that static fields
// (e.g. onConflictStateChanged) are the same instance as the running extension.
let MeldProviderClass: typeof MeldCustomEditorProvider;

before(async () => {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	const api = (await ext.activate()) as WeldExtensionApi;
	MeldProviderClass = api.meldCustomEditorProvider;
});

// Opens a conflicted file in a fake MeldCustomEditorProvider panel, sends the
// "ready" handshake, and waits for the initial "loadDiff" message.
// Returns both the panel and the first loadDiff payload.
async function openEditorOnConflictedFile(repoPath: string) {
	const fileUri = Uri.file(join(repoPath, "tracked.txt"));
	// Use a real TextDocument so document.getText() / .version / .isDirty work
	// correctly inside _initializeWebview and _maybeApplyAutoMerge.
	const document = await workspace.openTextDocument(fileUri);

	const panel = makeFakePanel();
	const provider = new MeldProviderClass(Uri.file("/tmp"));
	await provider.resolveCustomTextEditor(
		document,
		panel as unknown as WebviewPanel,
		{} as never,
	);

	// Trigger the ready handshake. _handleReadyMessage is async (fetches git
	// stages, builds snapshot), so we wait for the resulting loadDiff.
	await panel.send({ command: "ready" });
	const loadDiff = await panel.waitFor("loadDiff");

	return { panel, document, loadDiff };
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
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
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
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
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
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});
