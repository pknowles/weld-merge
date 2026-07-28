// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it } from "@jest/globals";
import {
	createNonTextConflictResult,
	normalizeGetConflictInput,
} from "../src/agentConflicts.ts";

const NONNEGATIVE_SAFE_INTEGER_REGEX = /nonnegative safe integer/u;

describe("normalizeGetConflictInput", () => {
	it("defaults omitted context to five lines", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflictIndex: 0,
			}),
		).toEqual({
			repositoryRoot: "file:///repo",
			path: "tracked.txt",
			conflictIndex: 0,
			contextLines: 5,
			maxStageLines: 80,
			maxResultItems: 80,
		});
	});

	it("accepts an explicitly unbounded safe context size", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflictIndex: 2,
				contextLines: Number.MAX_SAFE_INTEGER,
			}).contextLines,
		).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("accepts a tool-runtime null for an omitted conflict index", () => {
		expect(
			normalizeGetConflictInput({
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflictIndex: null,
			}),
		).toMatchObject({ conflictIndex: null });
	});

	for (const testCase of [
		{ name: "negative conflict index", conflictIndex: -1, contextLines: 0 },
		{
			name: "fractional conflict index",
			conflictIndex: 0.5,
			contextLines: 0,
		},
		{ name: "negative context", conflictIndex: 0, contextLines: -1 },
		{
			name: "unsafe context",
			conflictIndex: 0,
			contextLines: Number.MAX_SAFE_INTEGER + 1,
		},
	]) {
		it(`rejects ${testCase.name}`, () => {
			expect(() =>
				normalizeGetConflictInput({
					repositoryRoot: "file:///repo",
					path: "tracked.txt",
					conflictIndex: testCase.conflictIndex,
					contextLines: testCase.contextLines,
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
				{
					repositoryRoot: "file:///repo",
					path: "tracked.txt",
					conflictIndex: 0,
					contextLines: 5,
					maxStageLines: 80,
					maxResultItems: 80,
				},
				testCase.type,
			);

			expect(result).toMatchObject({
				type: testCase.type,
				repositoryRoot: "file:///repo",
				path: "tracked.txt",
				conflictIndex: 0,
				conflictCount: 1,
			});
			expect(result.message).toContain(testCase.message);
		});
	}
});
