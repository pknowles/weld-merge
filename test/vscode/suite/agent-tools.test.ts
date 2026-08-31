// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, it } from "mocha";
import {
	extensions,
	LanguageModelTextPart,
	lm,
	Range,
	Uri,
	WorkspaceEdit,
	workspace,
} from "vscode";
import type {
	ConflictList,
	GetConflictResult,
	ListedConflict,
} from "../../../src/agentConflicts.ts";
import { getGitApi } from "../../../src/repoContext.ts";
import {
	buildBaseDiffPayload,
	buildDiffPayload,
} from "../../../src/webview/diffPayload.ts";
import {
	cleanupTempFixture,
	getConflictedItem,
	makeAdjacentResolvedChangeConflict,
	makeBinaryConflict,
	makeBothAddedConflict,
	makeBothDeletedConflict,
	makeConflict,
	makeContextConflict,
	makeContextConflictWithMarkerStyle,
	makeDeletedByThemConflict,
	makeDeletedByUsConflict,
	makeLargeConflict,
	makeRepo,
	makeSubmoduleConflictFixture,
	makeTwoHunkConflict,
	makeWeldResolvableConflict,
	openRepoInGitExtension,
	waitForMergeChanges,
	waitForRepoClose,
	withConflictRepo,
} from "./helpers.ts";

const ACTIVE_CONFLICT_ERROR_REGEX = /not an active conflict/u;
const CANONICAL_PATH_ERROR_REGEX = /canonical repository-relative path/u;
const CONFLICT_MARKER_REGEX = /<{7} HEAD/u;
const INVALID_REPOSITORY_PATH_REGEX = /invalid repository path/u;
const NO_OPEN_REPOSITORY_ERROR_REGEX = /No open Git repository/u;
const OUT_OF_RANGE_ERROR_REGEX = /out of range/u;
const INVALID_REPOSITORY_ROOT_ERROR_REGEX =
	/repositoryRoot must be a non-empty URI/u;
const INVALID_TOOL_PATH_ERROR_REGEX =
	/path must be a non-empty repository-relative string/u;
const INVALID_CONFLICT_RANGE_ERROR_REGEX = /first, last/u;
const INVALID_CONTEXT_LINES_ERROR_REGEX =
	/contextLines must be a nonnegative safe integer/u;
const INVALID_MAX_SECTION_LINES_ERROR_REGEX =
	/maxSectionLines must be a nonnegative safe integer/u;
const WELD_SENTINEL = "(??)";

async function invokeTextTool(name: string, input: object): Promise<string> {
	const result = await lm.invokeTool(name, {
		input,
		toolInvocationToken: undefined,
	});
	const textParts = result.content.filter(
		(part): part is LanguageModelTextPart =>
			part instanceof LanguageModelTextPart,
	);
	assert.equal(textParts.length, 1, "expected one text result");
	const textPart = textParts[0];
	assert.ok(textPart, "expected text result");
	assert.ok(
		!textPart.value.includes(WELD_SENTINEL),
		"responses must never contain the Weld (??) sentinel",
	);
	return textPart.value;
}

async function invokeListConflicts(input: object = {}): Promise<ConflictList> {
	const parsed: unknown = JSON.parse(
		await invokeTextTool("weld_list_conflicts", input),
	);
	assert.ok(parsed && typeof parsed === "object", "expected result object");
	assert.ok("files" in parsed, "expected files property");
	assert.ok(Array.isArray(parsed.files), "expected files array");
	return parsed as ConflictList;
}

async function invokeGetConflict(input: object): Promise<GetConflictResult> {
	const parsed: unknown = JSON.parse(
		await invokeTextTool("weld_get_conflict", input),
	);
	assert.ok(parsed && typeof parsed === "object", "expected result object");
	assert.ok("type" in parsed && typeof parsed.type === "string");
	return parsed as GetConflictResult;
}

// Narrows to the text/bothAdded result shape and fails loudly otherwise.
function expectTextResult(
	result: GetConflictResult,
): Extract<GetConflictResult, { conflicts: unknown }> {
	if (result.type !== "text" && result.type !== "bothAdded") {
		throw new Error(`expected a text conflict result, got ${result.type}`);
	}
	return result;
}

interface ApplyAutomergeResult {
	repositoryRoot: string;
	path: string;
	remainingConflicts: number;
}

async function invokeApplyAutomerge(
	input: object,
): Promise<ApplyAutomergeResult> {
	const parsed: unknown = JSON.parse(
		await invokeTextTool("weld_apply_automerge", input),
	);
	assert.ok(parsed && typeof parsed === "object", "expected result object");
	assert.ok(
		"remainingConflicts" in parsed &&
			typeof parsed.remainingConflicts === "number",
	);
	return parsed as ApplyAutomergeResult;
}

async function withListToolEnabled(test: () => Promise<void>): Promise<void> {
	await workspace
		.getConfiguration("weld")
		.update("agent.enable", true, false);
	try {
		await test();
	} finally {
		await workspace
			.getConfiguration("weld")
			.update("agent.enable", false, false);
	}
}

function findConflict(
	result: ConflictList,
	repositoryRoot: Uri,
	path: string,
): ListedConflict {
	const conflict = result.files.find(
		(file) =>
			file.repositoryRoot === repositoryRoot.toString() &&
			file.path === path,
	);
	assert.ok(
		conflict,
		`expected conflict ${repositoryRoot.toString()}/${path}`,
	);
	return conflict;
}

// Splits a rendered block into its parts so tests can assert exactly where
// content is allowed to appear. Context is everything outside the markers.
function splitBlock(text: string): {
	before: string[];
	local: string[];
	base: string[];
	remote: string[];
	after: string[];
} {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith("<<<<<<< LOCAL"));
	const middle = lines.indexOf("=======");
	const end = lines.indexOf(">>>>>>> REMOTE");
	assert.ok(start >= 0 && middle > start && end > middle, text);
	const baseMarker = lines.indexOf("||||||| BASE");
	return {
		before: lines.slice(0, start),
		local: lines.slice(start + 1, baseMarker === -1 ? middle : baseMarker),
		base: baseMarker === -1 ? [] : lines.slice(baseMarker + 1, middle),
		remote: lines.slice(middle + 1, end),
		after: lines.slice(end + 1),
	};
}

interface DiskEditCase {
	name: string;
	content: string;
	range: [number, number];
}

const DISK_EDIT_CASES: readonly DiskEditCase[] = [
	{
		name: "deletes the conflict region",
		content: "before one\nbefore two\nafter one\nafter two\n",
		range: [3, 3],
	},
	{
		name: "replaces the conflict region with unrelated text",
		content: "before one\nbefore two\nunrelated\nafter one\nafter two\n",
		range: [3, 4],
	},
	{
		name: "replaces it with copied surrounding text",
		content: "before one\nbefore two\nbefore two\nafter one\nafter two\n",
		range: [3, 4],
	},
	{
		name: "truncates the entire file",
		content: "",
		range: [1, 1],
	},
	{
		name: "replaces the entire file",
		content: "nothing recognizably related\n",
		range: [1, 2],
	},
];

async function assertDiskEditCases(
	uri: Uri,
	repositoryRoot: string,
	cases: readonly DiskEditCase[],
): Promise<void> {
	const [testCase, ...remainingCases] = cases;
	if (!testCase) {
		return;
	}
	await workspace.fs.writeFile(
		uri,
		new TextEncoder().encode(testCase.content),
	);
	const result = expectTextResult(
		await invokeGetConflict({
			repositoryRoot,
			path: "tracked.txt",
			conflicts: [0, 0],
		}),
	);
	const block = result.conflicts[0];
	assert.ok(block, testCase.name);
	assert.deepEqual(block.range, testCase.range, testCase.name);
	if (testCase.range[0] === testCase.range[1]) {
		assert.ok(
			block.text.includes(`inserts before line ${testCase.range[0]}`),
			testCase.name,
		);
	} else {
		assert.ok(
			block.text.includes(
				`replaces lines ${testCase.range[0]}-${testCase.range[1] - 1}`,
			),
			testCase.name,
		);
	}
	await assertDiskEditCases(uri, repositoryRoot, remainingCases);
}

describe("Agent Tools: Settings (VS Code host)", () => {
	it("LM tool setting can be toggled on and off", async () => {
		await workspace
			.getConfiguration("weld")
			.update("agent.enable", true, false);
		let enabled = workspace
			.getConfiguration("weld")
			.get<boolean>("agent.enable");
		assert.equal(enabled, true);
		assert.equal(
			lm.tools.some((tool) => tool.name === "weld_apply_automerge_all"),
			true,
			"expected enabled Weld tool to be registered",
		);
		assert.equal(
			lm.tools.some((tool) => tool.name === "weld_apply_automerge"),
			true,
			"expected enabled Weld single-file automerge tool to be registered",
		);
		assert.equal(
			lm.tools.some((tool) => tool.name === "weld_list_conflicts"),
			true,
			"expected enabled Weld conflict-list tool to be registered",
		);
		assert.equal(
			lm.tools.some((tool) => tool.name === "weld_get_conflict"),
			true,
			"expected enabled Weld conflict-detail tool to be registered",
		);

		await workspace
			.getConfiguration("weld")
			.update("agent.enable", false, false);
		enabled = workspace
			.getConfiguration("weld")
			.get<boolean>("agent.enable");
		assert.equal(enabled, false);
	});

	it("preserves the automerge-all no-conflicts result", async () => {
		await withListToolEnabled(async () => {
			assert.equal(
				await invokeTextTool("weld_apply_automerge_all", {}),
				"No conflicted files found.",
			);
		});
	});

	it("LM tool is discoverable by VS Code Agent Mode", () => {
		const extension = extensions.getExtension("pknowles.meld-auto-merge");
		assert.ok(extension, "expected Weld extension to be installed");
		const tools = extension.packageJSON.contributes
			.languageModelTools as Array<{
			name: string;
			toolReferenceName?: string;
			canBeReferencedInPrompt?: boolean;
		}>;
		for (const expected of [
			{
				name: "weld_apply_automerge_all",
				reference: "weldAutomergeAll",
			},
			{ name: "weld_apply_automerge", reference: "weldAutomerge" },
			{ name: "weld_list_conflicts", reference: "weldListConflicts" },
			{ name: "weld_get_conflict", reference: "weldGetConflict" },
		]) {
			const tool = tools.find(
				(candidate) => candidate.name === expected.name,
			);
			assert.ok(tool, `expected ${expected.name} contribution`);
			assert.equal(tool.toolReferenceName, expected.reference);
			assert.equal(tool.canBeReferencedInPrompt, true);
		}
	});

	it("LM tool setting defaults to false", () => {
		const enabled = workspace
			.getConfiguration("weld")
			.get<boolean>("agent.enable");
		assert.equal(enabled, false);
	});
});

describe("Agent Tools: Single-file auto-merge", () => {
	it("reports remaining conflicts the merge could not resolve", () =>
		withConflictRepo(
			"weld-agent-automerge-",
			makeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const result = await invokeApplyAutomerge({
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
					});
					assert.equal(result.path, "tracked.txt");
					assert.equal(result.remainingConflicts, 1);

					const document = await workspace.openTextDocument(
						Uri.file(`${repoPath}/tracked.txt`),
					);
					assert.match(document.getText(), CONFLICT_MARKER_REGEX);
				});
			},
			{ closeBeforeCleanup: true },
		));

	it("reports the count across multiple independent conflicts in one file", () =>
		withConflictRepo(
			"weld-agent-automerge-two-hunk-",
			makeTwoHunkConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const result = await invokeApplyAutomerge({
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
					});
					assert.equal(result.remainingConflicts, 2);
				});
			},
			{ closeBeforeCleanup: true },
		));

	it("rejects a path that is not an active conflict", () =>
		withConflictRepo(
			"weld-agent-automerge-stale-",
			makeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					await assert.rejects(
						invokeApplyAutomerge({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "does-not-exist.txt",
						}),
						ACTIVE_CONFLICT_ERROR_REGEX,
					);
				});
			},
			{ closeBeforeCleanup: true },
		));
});

describe("Agent Tools: Conflict listing", () => {
	it("lists a text conflict with commit identifiers and disk markers", () =>
		withConflictRepo("weld-agent-text-", makeConflict, async (repoPath) => {
			await withListToolEnabled(async () => {
				const conflict = findConflict(
					await invokeListConflicts(),
					Uri.file(repoPath),
					"tracked.txt",
				);
				assert.equal(conflict.conflictCount, 1);
				assert.equal(conflict.kind, "text");
				assert.equal(conflict.commits.local.title, "local change");
				assert.ok(conflict.commits.local.hash.length > 0);
				assert.ok((conflict.commits.local.ref ?? "").length > 0);
				assert.equal(conflict.commits.remote?.title, "remote change");
				assert.equal(conflict.commits.remote?.ref, "other");
				assert.equal(conflict.commits.base?.title, "init");
				// The merge's own markers are on disk and reported; after
				// resolution any remaining entry is stray.
				assert.equal(
					conflict.strayMarkers?.some(
						(marker) => marker.kind === "gitMarker",
					),
					true,
				);
			});
		}));

	it("inlines small conflicts with the listing", () =>
		withConflictRepo(
			"weld-agent-inline-",
			makeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const conflict = findConflict(
						await invokeListConflicts(),
						Uri.file(repoPath),
						"tracked.txt",
					);
					assert.equal(conflict.conflicts?.length, 1);
					const block = conflict.conflicts?.[0];
					assert.ok(block, "expected one inline conflict block");
					assert.ok(block.range, "expected a mapped disk range");
					assert.ok(
						block.text.includes(
							`replaces lines ${block.range[0]}-${block.range[1] - 1}`,
						),
					);

					const budgeted = findConflict(
						await invokeListConflicts({ inlineConflictLines: 1 }),
						Uri.file(repoPath),
						"tracked.txt",
					);
					assert.equal(budgeted.conflicts, undefined);
				});
			},
		));

	it("lists a Weld-resolvable Git conflict with zero conflicts to decide", () =>
		withConflictRepo(
			"weld-agent-resolvable-",
			makeWeldResolvableConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const conflict = findConflict(
						await invokeListConflicts(),
						Uri.file(repoPath),
						"tracked.txt",
					);
					assert.equal(conflict.kind, "text");
					assert.equal(conflict.conflictCount, 0);
					assert.equal(conflict.conflicts, undefined);
					// Git's markers are still on disk until auto-merge runs.
					assert.equal(
						conflict.strayMarkers?.some(
							(marker) => marker.kind === "gitMarker",
						),
						true,
					);

					const detail = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
						}),
					);
					assert.equal(detail.conflictCount, 0);
					assert.deepEqual(detail.conflicts, []);
				});
			},
		));
});

describe("Agent Tools: Conflict block format", () => {
	it("renders the conflict as a located diff3 block with disk context", () =>
		withConflictRepo(
			"weld-agent-get-context-",
			makeContextConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const result = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
							conflicts: [0, 0],
							contextLines: 1,
						}),
					);
					assert.equal(result.conflictCount, 1);
					const block = result.conflicts[0];
					assert.ok(block, "expected one conflict block");
					assert.equal(block.index, 0);
					assert.equal(block.autoMergeView, undefined);
					assert.equal(block.note, undefined);

					// The generated alternatives and disk context come from
					// the Git stages and the real file on disk, not a
					// hand-computed line count: the local marker-conflict
					// style (merge/diff3/zdiff3, whatever this environment's
					// git.conflictStyle produces) changes how many lines the
					// disk block occupies, so `range` must never be a
					// hardcoded literal here.
					assert.ok(block.range, "expected a mapped disk range");
					const parts = splitBlock(block.text);
					assert.deepEqual(parts.before, ["before two"]);
					assert.deepEqual(parts.local, ["local"]);
					assert.deepEqual(parts.base, ["base"]);
					assert.deepEqual(parts.remote, ["remote"]);
					assert.deepEqual(parts.after, ["after one"]);
					assert.ok(
						block.text.includes(
							`replaces lines ${block.range[0]}-${block.range[1] - 1}`,
						),
					);

					// GUI parity: the block's alternatives are the same stage
					// content the merge editor's panes show.
					const payload = await buildDiffPayload(
						getConflictedItem(repoPath, "tracked.txt"),
					);
					const [localFile, , remoteFile] = payload.files;
					assert.ok(localFile && remoteFile);
					assert.equal(
						localFile.content,
						"before one\nbefore two\nlocal\nafter one\nafter two\n",
					);
					assert.equal(
						remoteFile.content,
						"before one\nbefore two\nremote\nafter one\nafter two\n",
					);
					assert.equal(block.localDiff, undefined);
					assert.equal(block.remoteDiff, undefined);
				});
			},
		));
});

describe("Agent Tools: Optional base diffs", () => {
	it("adds base diffs only when requested, matching the UI's base panels", () =>
		withConflictRepo(
			"weld-agent-base-diffs-",
			makeContextConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const repositoryRoot = Uri.file(repoPath).toString();
					const item = getConflictedItem(repoPath, "tracked.txt");
					const [localBase, remoteBase] = await Promise.all([
						buildBaseDiffPayload(item, item.uri, "left"),
						buildBaseDiffPayload(item, item.uri, "right"),
					]);

					const result = expectTextResult(
						await invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflicts: [0, 0],
							contextLines: 1,
							includeBaseDiffs: true,
						}),
					);
					const block = result.conflicts[0];
					assert.ok(block, "expected one conflict block");
					assert.equal(
						block.localDiff,
						"@@ -2,3 +2,3 @@\n before two\n-base\n+local\n after one",
					);
					assert.equal(
						block.remoteDiff,
						"@@ -2,3 +2,3 @@\n before two\n-base\n+remote\n after one",
					);
					// GUI parity: the same replace opcode the UI's compare-with-base
					// panels compute for this file.
					assert.deepEqual(localBase.data.diffs, [
						{
							tag: "replace",
							startA: 2,
							endA: 3,
							startB: 2,
							endB: 3,
						},
					]);
					assert.deepEqual(remoteBase.data.diffs, [
						{
							tag: "replace",
							startA: 2,
							endA: 3,
							startB: 2,
							endB: 3,
						},
					]);
				});
			},
		));
});

describe("Agent Tools: Conflict block format", () => {
	it("renders a both-added conflict without a base section", () =>
		withConflictRepo(
			"weld-agent-both-added-",
			makeBothAddedConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const conflict = findConflict(
						await invokeListConflicts(),
						Uri.file(repoPath),
						"conflict.txt",
					);
					assert.equal(conflict.kind, "bothAdded");
					const detail = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "conflict.txt",
							conflicts: [0, 0],
						}),
					);
					assert.equal(detail.type, "bothAdded");
					const block = detail.conflicts[0];
					assert.ok(block, "expected one conflict block");
					const parts = splitBlock(block.text);
					assert.deepEqual(parts.local, ["local version"]);
					assert.deepEqual(parts.remote, ["remote version"]);
					assert.ok(!block.text.includes("|||||||"));
				});
			},
		));
});

describe("Agent Tools: Diverged disk state", () => {
	it("shows the auto-merge view only when the disk context differs", () =>
		withConflictRepo(
			"weld-agent-diverged-",
			makeContextConflict,
			async (repoPath) => {
				const uri = Uri.file(`${repoPath}/tracked.txt`);
				// Edits "after two" — well outside the conflict's own hunk —
				// so it lands in the disk context, not swallowed into the
				// mapped conflict region itself.
				await workspace.fs.writeFile(
					uri,
					new TextEncoder().encode(
						[
							"before one",
							"before two",
							"<<<<<<< HEAD",
							"local",
							"=======",
							"remote",
							">>>>>>> other",
							"after one",
							"EDITED",
							"",
						].join("\n"),
					),
				);
				await withListToolEnabled(async () => {
					const result = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
							conflicts: [0, 0],
							contextLines: 2,
						}),
					);
					const block = result.conflicts[0];
					assert.ok(block, "expected one conflict block");
					assert.ok(
						block.text.includes("EDITED"),
						`DIAGNOSTIC range=${JSON.stringify(block.range)} note=${block.note} text=${JSON.stringify(block.text)}`,
					);
					assert.ok(
						block.autoMergeView,
						"expected an auto-merge view",
					);
					assert.ok(block.autoMergeView.includes("after two"));
					assert.ok(!block.autoMergeView.includes("EDITED"));
					assert.ok(
						!block.autoMergeView.includes("replaces lines"),
						"the auto-merge view has no file location",
					);
				});
			},
		));
});

describe("Agent Tools: Marker styles", () => {
	for (const testCase of [
		{ style: "merge", markerLength: 4 },
		{ style: "diff3", markerLength: 9 },
		{ style: "zdiff3", markerLength: 10 },
	] as const) {
		it(`maps Git's ${testCase.style} markers at length ${testCase.markerLength}`, () =>
			withConflictRepo(
				`weld-agent-${testCase.style}-markers-`,
				makeContextConflictWithMarkerStyle(
					testCase.style,
					testCase.markerLength,
				),
				async (repoPath) => {
					await withListToolEnabled(async () => {
						const result = expectTextResult(
							await invokeGetConflict({
								repositoryRoot: Uri.file(repoPath).toString(),
								path: "tracked.txt",
								conflicts: [0, 0],
							}),
						);
						const block = result.conflicts[0];
						assert.ok(block, "expected one conflict block");
						assert.ok(block.range, "expected a mapped disk range");
						assert.ok(block.text.includes("replaces lines"));
					});
				},
			));
	}
});

describe("Agent Tools: Giant conflict summaries", () => {
	it("elides section interiors with clear line numbers", () =>
		withConflictRepo(
			"weld-agent-large-",
			makeLargeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const result = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
							conflicts: [0, 0],
							maxSectionLines: 4,
						}),
					);
					const block = result.conflicts[0];
					assert.ok(block, "expected one conflict block");
					for (const side of ["local", "base", "remote"] as const) {
						assert.ok(
							block.text.includes(
								`... 36 lines elided (${side} 3-38) ...`,
							),
							`expected ${side} elision in:\n${block.text}`,
						);
					}
					assert.ok(block.text.includes("local 01"));
					assert.ok(block.text.includes("local 40"));
					assert.ok(!block.text.includes("local 03"));
				});
			},
		));
});

describe("Agent Tools: Current conflict details", () => {
	it("maps disk edits that remove or replace every conflict line", () =>
		withConflictRepo(
			"weld-agent-disk-edits-",
			makeContextConflict,
			async (repoPath) => {
				const uri = Uri.file(`${repoPath}/tracked.txt`);
				const repositoryRoot = Uri.file(repoPath).toString();
				await withListToolEnabled(async () => {
					await assertDiskEditCases(
						uri,
						repositoryRoot,
						DISK_EDIT_CASES,
					);
				});
			},
		));

	it("reads disk rather than a dirty in-memory document", () =>
		withConflictRepo(
			"weld-agent-get-live-",
			makeContextConflict,
			async (repoPath) => {
				const uri = Uri.file(`${repoPath}/tracked.txt`);
				const document = await workspace.openTextDocument(uri);
				const original = document.getText();
				const edit = new WorkspaceEdit();
				edit.replace(
					uri,
					new Range(
						document.positionAt(0),
						document.positionAt(original.length),
					),
					"completely unrelated",
				);
				assert.equal(await workspace.applyEdit(edit), true);
				try {
					await workspace.fs.writeFile(
						uri,
						new TextEncoder().encode(
							`${original}\n<<<<<<< stray marker`,
						),
					);
					await withListToolEnabled(async () => {
						const result = expectTextResult(
							await invokeGetConflict({
								repositoryRoot: Uri.file(repoPath).toString(),
								path: "tracked.txt",
								conflicts: [0, 0],
							}),
						);
						const block = result.conflicts[0];
						assert.ok(block?.range, "expected a mapped disk range");
						const listed = findConflict(
							await invokeListConflicts(),
							Uri.file(repoPath),
							"tracked.txt",
						);
						const lastLine =
							`${original}\n<<<<<<< stray marker`.split(
								"\n",
							).length;
						assert.equal(
							listed.strayMarkers?.some(
								(marker) =>
									marker.kind === "gitMarker" &&
									marker.range[0] === lastLine,
							),
							true,
							"expected the appended stray marker to be reported",
						);
					});
				} finally {
					const restore = new WorkspaceEdit();
					restore.replace(
						uri,
						new Range(
							document.positionAt(0),
							document.positionAt(document.getText().length),
						),
						original,
					);
					assert.equal(await workspace.applyEdit(restore), true);
					await workspace.fs.writeFile(
						uri,
						new TextEncoder().encode(original),
					);
					assert.equal(await document.save(), true);
				}
			},
		));
});

describe("Agent Tools: Multi-conflict selection", () => {
	it("does not leak an adjacent change both sides already resolved", () =>
		withConflictRepo(
			"weld-agent-adjacent-resolved-",
			makeAdjacentResolvedChangeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const result = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
						}),
					);
					for (const block of result.conflicts) {
						const parts = splitBlock(block.text);
						// RESOLVED was deleted by both sides. It may only
						// appear inside the BASE section when Weld's region
						// legitimately spans it — never as context and never
						// as a local/remote alternative.
						for (const section of [
							parts.before,
							parts.local,
							parts.remote,
							parts.after,
						]) {
							assert.ok(
								!section.some((line) =>
									line.includes("RESOLVED"),
								),
								`unexpected RESOLVED outside base in:\n${block.text}`,
							);
						}
					}
				});
			},
		));

	it("returns every conflict when the range is omitted", () =>
		withConflictRepo(
			"weld-agent-two-hunk-",
			makeTwoHunkConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const all = expectTextResult(
						await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
						}),
					);
					assert.equal(all.conflictCount, 2);
					assert.deepEqual(
						all.conflicts.map((block) => block.index),
						[0, 1],
					);
					const [first, second] = all.conflicts;
					assert.ok(first && second);
					const firstParts = splitBlock(first.text);
					assert.deepEqual(firstParts.local, ["LOCAL-B"]);
					assert.deepEqual(firstParts.base, ["B"]);
					assert.deepEqual(firstParts.remote, ["REMOTE-B"]);
					const secondParts = splitBlock(second.text);
					assert.deepEqual(secondParts.local, ["LOCAL-C"]);
					// The neighboring conflict's disk markers are not context:
					// context stops at marker lines.
					assert.ok(
						!first.text.includes("LOCAL-C"),
						`unexpected second-conflict content in:\n${first.text}`,
					);
					assert.notDeepEqual(first.range, second.range);
				});
			},
		));

	it("selects a single conflict by range and rejects out-of-range", () =>
		withConflictRepo(
			"weld-agent-two-hunk-range-",
			makeTwoHunkConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const repositoryRoot = Uri.file(repoPath).toString();
					const single = expectTextResult(
						await invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflicts: [1, 1],
						}),
					);
					assert.equal(single.conflicts.length, 1);
					assert.equal(single.conflicts[0]?.index, 1);
					assert.deepEqual(
						splitBlock(single.conflicts[0]?.text ?? "").local,
						["LOCAL-C"],
					);

					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflicts: [0, 2],
						}),
						OUT_OF_RANGE_ERROR_REGEX,
					);
				});
			},
		));
});

function normalizeWireValue(
	value: unknown,
	repositoryUri: string,
	repositoryPath: string,
): unknown {
	if (typeof value === "string") {
		return value
			.replaceAll(repositoryUri, "file:///repository")
			.replaceAll(repositoryPath, "/repository");
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			normalizeWireValue(item, repositoryUri, repositoryPath),
		);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				normalizeWireValue(item, repositoryUri, repositoryPath),
			]),
		);
	}
	return value;
}

function normalizedWireResponse(raw: string): string {
	const response = JSON.parse(raw) as {
		repositoryRoot?: unknown;
		files?: Array<{ repositoryRoot?: unknown }>;
	};
	const repositoryRoot =
		typeof response.repositoryRoot === "string"
			? response.repositoryRoot
			: response.files?.find(
					(file) => typeof file.repositoryRoot === "string",
				)?.repositoryRoot;
	if (typeof repositoryRoot !== "string") {
		throw new Error(
			"Expected a repositoryRoot in the response for byte normalization.",
		);
	}
	return JSON.stringify(
		normalizeWireValue(
			response,
			repositoryRoot,
			Uri.parse(repositoryRoot).fsPath,
		),
	);
}

const USEFUL_RESPONSE_FIELDS = new Set([
	"text",
	"autoMergeView",
	"note",
	"range",
	"message",
	"hash",
	"ref",
	"title",
	"kind",
	"path",
	"type",
	"conflictCount",
]);

function usefulResponseBytes(value: unknown, fieldName: string): number {
	if (typeof value === "string") {
		return USEFUL_RESPONSE_FIELDS.has(fieldName)
			? new TextEncoder().encode(value).length
			: 0;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return USEFUL_RESPONSE_FIELDS.has(fieldName)
			? new TextEncoder().encode(JSON.stringify(value)).length
			: 0;
	}
	if (Array.isArray(value)) {
		return value.reduce(
			(total, item) => total + usefulResponseBytes(item, fieldName),
			0,
		);
	}
	if (value && typeof value === "object") {
		return Object.entries(value).reduce(
			(total, [entryKey, item]) =>
				total + usefulResponseBytes(item, entryKey),
			0,
		);
	}
	return 0;
}

function assertResponseBudget(
	raw: string,
	maxBytes: number,
	minUsefulResponsePercent: number,
): void {
	const normalized = normalizedWireResponse(raw);
	const wireBytes = new TextEncoder().encode(normalized).length;
	assert.ok(
		wireBytes <= maxBytes,
		`response was ${wireBytes} bytes; budget is ${maxBytes}`,
	);
	const usefulPercent =
		(usefulResponseBytes(JSON.parse(normalized), "response") / wireBytes) *
		100;
	assert.ok(
		usefulPercent >= minUsefulResponsePercent,
		`useful response content was ${usefulPercent.toFixed(1)}%; minimum is ${minUsefulResponsePercent}%`,
	);
}

describe("Agent Tools: Response size budgets", () => {
	it("keeps a minimal conflict within the response budget", () =>
		withConflictRepo(
			"weld-agent-size-min-",
			makeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const raw = await invokeTextTool("weld_get_conflict", {
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
					});
					assertResponseBudget(raw, 450, 40);
				});
			},
		));

	it("keeps a contextual conflict within the response budget", () =>
		withConflictRepo(
			"weld-agent-size-context-",
			makeContextConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const raw = await invokeTextTool("weld_get_conflict", {
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
					});
					assertResponseBudget(raw, 550, 45);
				});
			},
		));

	it("keeps one of several conflicts within the response budget", () =>
		withConflictRepo(
			"weld-agent-size-multi-",
			makeTwoHunkConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const raw = await invokeTextTool("weld_get_conflict", {
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
						conflicts: [0, 0],
					});
					assertResponseBudget(raw, 450, 40);
				});
			},
		));

	it("keeps a both-added conflict within the response budget", () =>
		withConflictRepo(
			"weld-agent-size-both-added-",
			makeBothAddedConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const raw = await invokeTextTool("weld_get_conflict", {
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "conflict.txt",
					});
					assertResponseBudget(raw, 450, 40);
				});
			},
		));

	it("keeps an elided giant conflict within the response budget", () =>
		withConflictRepo(
			"weld-agent-size-large-",
			makeLargeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const raw = await invokeTextTool("weld_get_conflict", {
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
						maxSectionLines: 4,
					});
					assertResponseBudget(raw, 800, 55);
				});
			},
		));

	it("keeps a single-conflict listing within the response budget", () =>
		withConflictRepo("weld-agent-size-list-", makeConflict, async () => {
			await withListToolEnabled(async () => {
				const raw = await invokeTextTool("weld_list_conflicts", {});
				assertResponseBudget(raw, 1200, 45);
			});
		}));
});

describe("Agent Tools: Invalid and stale requests", () => {
	it("fails fast for invalid conflict-detail inputs", () =>
		withConflictRepo(
			"weld-agent-invalid-input-",
			makeConflict,
			async (repoPath) => {
				const repositoryRoot = Uri.file(repoPath).toString();
				const valid = { repositoryRoot, path: "tracked.txt" };
				await withListToolEnabled(async () => {
					const invalidInputs = [
						{
							input: { ...valid, repositoryRoot: "" },
							error: INVALID_REPOSITORY_ROOT_ERROR_REGEX,
						},
						{
							input: { ...valid, repositoryRoot: null },
							error: INVALID_REPOSITORY_ROOT_ERROR_REGEX,
						},
						{
							input: { ...valid, path: "" },
							error: INVALID_TOOL_PATH_ERROR_REGEX,
						},
						{
							input: { ...valid, path: null },
							error: INVALID_TOOL_PATH_ERROR_REGEX,
						},
						{
							input: { ...valid, conflicts: [-1, 0] },
							error: INVALID_CONFLICT_RANGE_ERROR_REGEX,
						},
						{
							input: { ...valid, conflicts: [0.5, 1] },
							error: INVALID_CONFLICT_RANGE_ERROR_REGEX,
						},
						{
							input: { ...valid, conflicts: [1, 0] },
							error: INVALID_CONFLICT_RANGE_ERROR_REGEX,
						},
						{
							input: { ...valid, contextLines: -1 },
							error: INVALID_CONTEXT_LINES_ERROR_REGEX,
						},
						{
							input: { ...valid, contextLines: 0.5 },
							error: INVALID_CONTEXT_LINES_ERROR_REGEX,
						},
						{
							input: { ...valid, maxSectionLines: -1 },
							error: INVALID_MAX_SECTION_LINES_ERROR_REGEX,
						},
						{
							input: { ...valid, maxSectionLines: 0.5 },
							error: INVALID_MAX_SECTION_LINES_ERROR_REGEX,
						},
					];
					await Promise.all(
						invalidInputs.map((testCase) =>
							assert.rejects(
								invokeTextTool(
									"weld_get_conflict",
									testCase.input,
								),
								testCase.error,
							),
						),
					);
				});
			},
		));

	it("rejects stale repository, path, and conflict range inputs", () =>
		withConflictRepo(
			"weld-agent-get-errors-",
			makeConflict,
			async (repoPath) => {
				const repositoryRoot = Uri.file(repoPath).toString();
				await withListToolEnabled(async () => {
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot: "file:///not-open",
							path: "tracked.txt",
						}),
						NO_OPEN_REPOSITORY_ERROR_REGEX,
					);
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "missing.txt",
						}),
						ACTIVE_CONFLICT_ERROR_REGEX,
					);
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "../outside.txt",
						}),
						INVALID_REPOSITORY_PATH_REGEX,
					);
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflicts: [1, 1],
						}),
						OUT_OF_RANGE_ERROR_REGEX,
					);
				});
			},
		));

	it("rejects a non-canonical repository-relative path", () =>
		withConflictRepo(
			"weld-agent-canonical-",
			makeConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt/../tracked.txt",
						}),
						CANONICAL_PATH_ERROR_REGEX,
					);
				});
			},
		));
});

describe("Agent Tools: Whole-file conflict detection", () => {
	for (const testCase of [
		{
			name: "deleted-by-us",
			make: makeDeletedByUsConflict,
			kind: "deletedByUs" as const,
		},
		{
			name: "deleted-by-them",
			make: makeDeletedByThemConflict,
			kind: "deletedByThem" as const,
		},
		{
			name: "both-deleted",
			make: makeBothDeletedConflict,
			kind: "bothDeleted" as const,
		},
	]) {
		it(`classifies ${testCase.name} as a whole-file conflict`, () =>
			withConflictRepo(
				`weld-agent-${testCase.name}-`,
				testCase.make,
				async (repoPath) => {
					await withListToolEnabled(async () => {
						const conflict = findConflict(
							await invokeListConflicts(),
							Uri.file(repoPath),
							"tracked.txt",
						);
						assert.equal(conflict.conflictCount, 1);
						assert.equal(conflict.kind, testCase.kind);
						const detail = await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
						});
						assert.equal(detail.type, testCase.kind);
					});
				},
			));
	}
});

describe("Agent Tools: Special conflict detection", () => {
	it("classifies a binary conflict without reading it as text", () =>
		withConflictRepo(
			"weld-agent-binary-",
			makeBinaryConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const conflict = findConflict(
						await invokeListConflicts(),
						Uri.file(repoPath),
						"conflict.bin",
					);
					assert.equal(conflict.conflictCount, 1);
					assert.equal(conflict.kind, "binary");
					const detail = await invokeGetConflict({
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "conflict.bin",
					});
					assert.equal(detail.type, "binary");
				});
			},
		));

	it("classifies a submodule conflict", async () => {
		const fixture = await makeSubmoduleConflictFixture(
			"weld-agent-submodule-",
		);
		try {
			await openRepoInGitExtension(fixture.repoPath);
			const repo = getGitApi().getRepository(Uri.file(fixture.repoPath));
			assert.ok(repo, "expected submodule parent repository");
			await waitForMergeChanges(repo, 1);
			await withListToolEnabled(async () => {
				const conflict = findConflict(
					await invokeListConflicts(),
					Uri.file(fixture.repoPath),
					"sub",
				);
				assert.equal(conflict.conflictCount, 1);
				assert.equal(conflict.kind, "submodule");
				const detail = await invokeGetConflict({
					repositoryRoot: Uri.file(fixture.repoPath).toString(),
					path: "sub",
				});
				assert.equal(detail.type, "submodule");
			});
		} finally {
			const closePromise = waitForRepoClose(fixture.repoPath);
			await cleanupTempFixture(fixture);
			await closePromise;
		}
	});
});

describe("Agent Tools: Repository aggregation", () => {
	it("reports conflicts from multiple repositories", async () => {
		const textRepoPath = await makeRepo("weld-agent-multi-text-");
		const deletedRepoPath = await makeRepo("weld-agent-multi-deleted-");
		makeConflict(textRepoPath);
		makeDeletedByUsConflict(deletedRepoPath);
		try {
			await Promise.all([
				openRepoInGitExtension(textRepoPath),
				openRepoInGitExtension(deletedRepoPath),
			]);
			const textRepo = getGitApi().getRepository(Uri.file(textRepoPath));
			const deletedRepo = getGitApi().getRepository(
				Uri.file(deletedRepoPath),
			);
			assert.ok(textRepo, "expected text-conflict repository");
			assert.ok(deletedRepo, "expected deleted-conflict repository");
			await Promise.all([
				waitForMergeChanges(textRepo, 1),
				waitForMergeChanges(deletedRepo, 1),
			]);

			await withListToolEnabled(async () => {
				const result = await invokeListConflicts();
				const textConflict = findConflict(
					result,
					Uri.file(textRepoPath),
					"tracked.txt",
				);
				const deletedConflict = findConflict(
					result,
					Uri.file(deletedRepoPath),
					"tracked.txt",
				);
				assert.equal(textConflict.conflictCount, 1);
				assert.equal(deletedConflict.kind, "deletedByUs");
			});
		} finally {
			const closePromises = [
				waitForRepoClose(textRepoPath),
				waitForRepoClose(deletedRepoPath),
			];
			await Promise.all([
				rm(textRepoPath, { recursive: true, force: true }),
				rm(deletedRepoPath, { recursive: true, force: true }),
			]);
			await Promise.all(closePromises);
		}
	});

	it("reports zero conflicts when none exist", async () => {
		const repoPath = await makeRepo("weld-agent-no-conflict-");
		try {
			await openRepoInGitExtension(repoPath);
			const repo = getGitApi().getRepository(Uri.file(repoPath));
			assert.ok(repo, "expected repository to be registered");

			await withListToolEnabled(async () => {
				const result = await invokeListConflicts();
				assert.equal(result.files.length, 0);
			});
		} finally {
			const closePromise = waitForRepoClose(repoPath);
			await rm(repoPath, { recursive: true, force: true });
			await closePromise;
		}
	});
});
