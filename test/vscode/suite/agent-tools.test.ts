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
	cleanupTempFixture,
	makeBinaryConflict,
	makeBothAddedConflict,
	makeBothDeletedConflict,
	makeConflict,
	makeContextConflict,
	makeDeletedByThemConflict,
	makeDeletedByUsConflict,
	makeRepo,
	makeSubmoduleConflictFixture,
	makeTwoHunkConflict,
	openRepoInGitExtension,
	waitForMergeChanges,
	waitForRepoClose,
	withConflictRepo,
} from "./helpers.ts";

const ACTIVE_CONFLICT_ERROR_REGEX = /not an active conflict/u;
const CANONICAL_PATH_ERROR_REGEX = /canonical repository-relative path/u;
const INVALID_REPOSITORY_PATH_REGEX = /invalid repository path/u;
const NO_OPEN_REPOSITORY_ERROR_REGEX = /No open Git repository/u;
const OUT_OF_RANGE_ERROR_REGEX = /out of range/u;

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
	return textPart.value;
}

async function invokeListConflicts(): Promise<ConflictList> {
	const parsed: unknown = JSON.parse(
		await invokeTextTool("weld_list_conflicts", {}),
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

describe("Agent Tools: Text conflict detection", () => {
	it("lists a text conflict with its three-way hunk count", () =>
		withConflictRepo("weld-agent-text-", makeConflict, async (repoPath) => {
			await withListToolEnabled(async () => {
				const conflict = findConflict(
					await invokeListConflicts(),
					Uri.file(repoPath),
					"tracked.txt",
				);
				assert.equal(conflict.conflictCount, 1);
				assert.equal(conflict.kind, "text");
			});
		}));

	it("classifies a both-added text conflict", () =>
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
					assert.equal(conflict.conflictCount, 1);
					assert.equal(conflict.kind, "text");
					const detail = await invokeGetConflict({
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "conflict.txt",
						conflictIndex: 0,
					});
					assert.equal(detail.type, "text");
					if (detail.type !== "text") {
						throw new Error("expected both-added text conflict");
					}
					assert.equal(detail.base.present, false);
					assert.deepEqual(detail.base.lines, []);
				});
			},
		));
});

describe("Agent Tools: Conflict stage details", () => {
	it("returns complete stage regions, exact changes, and requested context", () =>
		withConflictRepo(
			"weld-agent-get-context-",
			makeContextConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const result = await invokeGetConflict({
						repositoryRoot: Uri.file(repoPath).toString(),
						path: "tracked.txt",
						conflictIndex: 0,
						contextLines: 1,
					});
					assert.equal(result.type, "text");
					if (result.type !== "text") {
						throw new Error("expected text conflict");
					}
					assert.deepEqual(result.base.lines, [
						{ lineNumber: 3, text: "base" },
					]);
					assert.deepEqual(result.local.lines, [
						{ lineNumber: 3, text: "local" },
					]);
					assert.deepEqual(result.remote.lines, [
						{ lineNumber: 3, text: "remote" },
					]);
					assert.deepEqual(result.base.contextBefore, [
						{ lineNumber: 2, text: "before two" },
					]);
					assert.deepEqual(result.base.contextAfter, [
						{ lineNumber: 4, text: "after one" },
					]);
					assert.deepEqual(
						result.changes.local.baseRange,
						result.base.range,
					);
					assert.deepEqual(
						result.changes.local.stageRange,
						result.local.range,
					);
					assert.equal(
						result.currentDocument.matchesWeldMergedContent,
						false,
					);
					assert.ok("current" in result);
					assert.ok(result.current.lines.length > 0);
				});
			},
		));
});

describe("Agent Tools: Current conflict details", () => {
	it("uses the live unsaved document and accepts unbounded explicit context", () =>
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
					await withListToolEnabled(async () => {
						const result = await invokeGetConflict({
							repositoryRoot: Uri.file(repoPath).toString(),
							path: "tracked.txt",
							conflictIndex: 0,
							contextLines: Number.MAX_SAFE_INTEGER,
						});
						assert.equal(result.type, "text");
						if (result.type !== "text" || !("current" in result)) {
							throw new Error("expected mapped current text");
						}
						assert.equal(result.currentDocument.isDirty, true);
						assert.deepEqual(result.current.lines, [
							{ lineNumber: 1, text: "completely unrelated" },
						]);
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
					assert.equal(await document.save(), true);
				}
			},
		));
});

describe("Agent Tools: Stale conflict requests", () => {
	it("rejects stale repository, path, and conflict index inputs", () =>
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
							conflictIndex: 0,
						}),
						NO_OPEN_REPOSITORY_ERROR_REGEX,
					);
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "missing.txt",
							conflictIndex: 0,
						}),
						ACTIVE_CONFLICT_ERROR_REGEX,
					);
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "../outside.txt",
							conflictIndex: 0,
						}),
						INVALID_REPOSITORY_PATH_REGEX,
					);
					await assert.rejects(
						invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflictIndex: 1,
						}),
						OUT_OF_RANGE_ERROR_REGEX,
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
							conflictIndex: 0,
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
						conflictIndex: 0,
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
					conflictIndex: 0,
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

describe("Agent Tools: Multi-hunk conflict indexing", () => {
	it("returns stage content for each independent conflict index", () =>
		withConflictRepo(
			"weld-agent-two-hunk-",
			makeTwoHunkConflict,
			async (repoPath) => {
				await withListToolEnabled(async () => {
					const repositoryRoot = Uri.file(repoPath).toString();
					const [result0, result1] = await Promise.all([
						invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflictIndex: 0,
						}),
						invokeGetConflict({
							repositoryRoot,
							path: "tracked.txt",
							conflictIndex: 1,
						}),
					]);
					assert.equal(result0.type, "text");
					assert.equal(result1.type, "text");
					if (result0.type !== "text" || result1.type !== "text") {
						throw new Error("expected text conflicts");
					}
					assert.deepEqual(
						result0.base.lines.map((l) => l.text),
						["B"],
					);
					assert.deepEqual(
						result1.base.lines.map((l) => l.text),
						["C"],
					);
				});
			},
		));
});

describe("Agent Tools: Canonical path guard", () => {
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
							conflictIndex: 0,
						}),
						CANONICAL_PATH_ERROR_REGEX,
					);
				});
			},
		));
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
