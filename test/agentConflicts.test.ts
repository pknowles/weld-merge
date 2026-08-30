// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it } from "@jest/globals";
import {
	type BaseDiffInput,
	createNonTextConflictResult,
	normalizeGetConflictInput,
	renderBaseDiff,
} from "../src/agentConflicts.ts";
import type { DiffChunk } from "../src/matchers/myers.ts";

const NONNEGATIVE_SAFE_INTEGER_REGEX = /nonnegative safe integer/u;
const CONFLICT_RANGE_ERROR_REGEX = /first, last/u;
const MISSING_CONFLICT_CHANGE_REGEX = /Could not find the conflict change/u;

describe("normalizeGetConflictInput", () => {
	it("defaults omitted options and selects all conflicts", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
			}),
		).toEqual({
			repositoryRoot: "file:///repo",
			path: "tracked.txt",
			conflicts: null,
			contextLines: 5,
			maxSectionLines: 40,
			includeBaseDiffs: false,
		});
	});

	it("accepts an explicitly unbounded safe context size", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflicts: [2, 2],
				contextLines: Number.MAX_SAFE_INTEGER,
			}).contextLines,
		).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("accepts a tool-runtime null for an omitted conflict range", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflicts: null,
			}),
		).toMatchObject({ conflicts: null });
	});

	it("only enables includeBaseDiffs when explicitly true", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				includeBaseDiffs: true,
			}),
		).toMatchObject({ includeBaseDiffs: true });
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				includeBaseDiffs: false,
			}),
		).toMatchObject({ includeBaseDiffs: false });
	});

	for (const testCase of [
		{ name: "a negative conflict range", conflicts: [-1, 0] },
		{ name: "a fractional conflict range", conflicts: [0.5, 1] },
		{ name: "a reversed conflict range", conflicts: [2, 1] },
	] as const) {
		it(`rejects ${testCase.name}`, () => {
			expect(() =>
				normalizeGetConflictInput({
					repositoryRoot: "file:///repo",
					path: "tracked.txt",
					conflicts: testCase.conflicts as [number, number],
				}),
			).toThrow(CONFLICT_RANGE_ERROR_REGEX);
		});
	}

	for (const testCase of [
		{ name: "negative context", contextLines: -1 },
		{ name: "unsafe context", contextLines: Number.MAX_SAFE_INTEGER + 1 },
		{ name: "negative section limit", maxSectionLines: -1 },
	]) {
		it(`rejects ${testCase.name}`, () => {
			expect(() =>
				normalizeGetConflictInput({
					repositoryRoot: "file:///repo",
					path: "tracked.txt",
					...testCase,
				}),
			).toThrow(NONNEGATIVE_SAFE_INTEGER_REGEX);
		});
	}
});

describe("createNonTextConflictResult", () => {
	for (const testCase of [
		{ type: "binary", message: "Binary conflicts" },
		{ type: "deletedByUs", message: "local side deleted" },
		{ type: "deletedByThem", message: "remote side deleted" },
		{ type: "bothDeleted", message: "Both sides deleted" },
		{ type: "submodule", message: "Git commit references" },
	] as const) {
		it(`serializes a ${testCase.type} conflict`, () => {
			const result = createNonTextConflictResult(
				{ repositoryRoot: "file:///repo", path: "tracked.txt" },
				testCase.type,
			);

			expect(result).toMatchObject({
				type: testCase.type,
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflictCount: 1,
			});
			expect(result.message).toContain(testCase.message);
		});
	}
});

// Minimal helper: builds a BaseDiffInput from a single change opcode plus
// optional equal opcodes immediately before/after it, mirroring the shape
// createTwoWayComparison produces.
function diffInput(options: {
	before?: string[];
	baseChange: string[];
	targetChange: string[];
	after?: string[];
	contextLines?: number;
}): BaseDiffInput {
	const before = options.before ?? [];
	const after = options.after ?? [];
	const baseLines = [...before, ...options.baseChange, ...after];
	const targetLines = [...before, ...options.targetChange, ...after];
	const opcodes: DiffChunk[] = [];
	if (before.length > 0) {
		opcodes.push({
			tag: "equal",
			startA: 0,
			endA: before.length,
			startB: 0,
			endB: before.length,
		});
	}
	const changeTag =
		options.baseChange.length === 0
			? "insert"
			: options.targetChange.length === 0
				? "delete"
				: "replace";
	opcodes.push({
		tag: changeTag,
		startA: before.length,
		endA: before.length + options.baseChange.length,
		startB: before.length,
		endB: before.length + options.targetChange.length,
	});
	if (after.length > 0) {
		opcodes.push({
			tag: "equal",
			startA: before.length + options.baseChange.length,
			endA: baseLines.length,
			startB: before.length + options.targetChange.length,
			endB: targetLines.length,
		});
	}
	return {
		opcodes,
		baseLines,
		targetLines,
		baseRange: {
			start: before.length,
			end: before.length + options.baseChange.length,
		},
		targetRange: {
			start: before.length,
			end: before.length + options.targetChange.length,
		},
		contextLines: options.contextLines ?? 5,
	};
}

describe("renderBaseDiff", () => {
	it("renders context on both sides for a mid-file replace", () => {
		const diff = renderBaseDiff(
			diffInput({
				before: ["before"],
				baseChange: ["base"],
				targetChange: ["local"],
				after: ["after"],
			}),
		);
		expect(diff).toBe("@@ -1,3 +1,3 @@\n before\n-base\n+local\n after");
	});

	it("omits leading context when the change is at the start of the file", () => {
		const diff = renderBaseDiff(
			diffInput({
				baseChange: ["base"],
				targetChange: ["local"],
				after: ["after"],
			}),
		);
		expect(diff).toBe("@@ -1,2 +1,2 @@\n-base\n+local\n after");
	});

	it("omits trailing context when the change is at the end of the file", () => {
		const diff = renderBaseDiff(
			diffInput({
				before: ["before"],
				baseChange: ["base"],
				targetChange: ["local"],
			}),
		);
		expect(diff).toBe("@@ -1,2 +1,2 @@\n before\n-base\n+local");
	});

	it("renders a pure deletion with no + lines", () => {
		const diff = renderBaseDiff(
			diffInput({
				before: ["before"],
				baseChange: ["removed"],
				targetChange: [],
				after: ["after"],
			}),
		);
		expect(diff).toBe("@@ -1,3 +1,2 @@\n before\n-removed\n after");
	});

	it("renders a pure insertion with no - lines", () => {
		const diff = renderBaseDiff(
			diffInput({
				before: ["before"],
				baseChange: [],
				targetChange: ["added"],
				after: ["after"],
			}),
		);
		expect(diff).toBe("@@ -1,2 +1,3 @@\n before\n+added\n after");
	});

	it("throws when the region does not map to any change opcode", () => {
		expect(() =>
			renderBaseDiff({
				opcodes: [
					{ tag: "equal", startA: 0, endA: 1, startB: 0, endB: 1 },
				],
				baseLines: ["only"],
				targetLines: ["only"],
				baseRange: { start: 0, end: 1 },
				targetRange: { start: 0, end: 1 },
				contextLines: 5,
			}),
		).toThrow(MISSING_CONFLICT_CHANGE_REGEX);
	});
});
