// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it } from "@jest/globals";
import {
	createNonTextConflictResult,
	createTextConflictResult,
	normalizeGetConflictInput,
} from "../src/agentConflicts.ts";
import {
	createConflictSnapshot,
	getConflictRegion,
} from "../src/conflictSnapshot.ts";

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

describe("createTextConflictResult", () => {
	const request = {
		repositoryRoot: "file:///repo",
		path: "tracked.txt",
		conflictIndex: 0,
		contextLines: 1,
	};
	const currentDocument = {
		uri: "file:///repo/tracked.txt",
		version: 7,
		isDirty: true,
	};

	it("serializes complete stage alternatives and a mapped current region", () => {
		const snapshot = createConflictSnapshot({
			base: "before\nbase\nafter",
			local: "before\nlocal\nafter",
			remote: "before\nremote\nafter",
		});
		const result = createTextConflictResult({
			request,
			snapshot,
			region: getConflictRegion(snapshot, 0),
			baseStagePresent: true,
			currentDocument: {
				...currentDocument,
				content: "before\nresolved\nafter",
			},
		});

		expect(result.type).toBe("text");
		expect(result.base).toEqual({
			present: true,
			range: { startLine: 2, endLineExclusive: 3 },
			lines: [{ lineNumber: 2, text: "base" }],
			contextBefore: [{ lineNumber: 1, text: "before" }],
			contextAfter: [{ lineNumber: 3, text: "after" }],
		});
		expect(result.changes.local).toEqual({
			tag: "conflict",
			baseRange: result.base.range,
			stageRange: result.local.range,
		});
		expect(result.currentDocument).toEqual({
			...currentDocument,
			matchesWeldMergedContent: false,
		});
		expect("current" in result && result.current.lines).toEqual([
			{ lineNumber: 2, text: "resolved" },
		]);
	});

	it("distinguishes an absent base and omits an unchanged current region", () => {
		const snapshot = createConflictSnapshot({
			base: "",
			local: "local",
			remote: "remote",
		});
		const result = createTextConflictResult({
			request,
			snapshot,
			region: getConflictRegion(snapshot, 0),
			baseStagePresent: false,
			currentDocument: {
				...currentDocument,
				content: snapshot.mergedContent,
			},
		});

		expect(result.base.present).toBe(false);
		expect(result.base.range).toEqual({
			startLine: 1,
			endLineExclusive: 1,
		});
		expect(result.base.lines).toEqual([]);
		expect(result.base.contextBefore).toEqual([]);
		expect(result.base.contextAfter).toEqual([]);
		expect(result.currentDocument.matchesWeldMergedContent).toBe(true);
		expect("current" in result).toBe(false);
	});
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
