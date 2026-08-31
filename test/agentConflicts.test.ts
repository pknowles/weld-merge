// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it } from "@jest/globals";
import {
	createNonTextConflictResult,
	normalizeGetConflictInput,
} from "../src/agentConflicts.ts";

const NONNEGATIVE_SAFE_INTEGER_REGEX = /nonnegative safe integer/u;
const CONFLICT_RANGE_ERROR_REGEX = /first, last/u;

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
