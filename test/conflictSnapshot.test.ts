// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it } from "@jest/globals";
import {
	createConflictSnapshot,
	getConflictRegion,
	getCurrentConflictRegion,
	rangesOverlap,
} from "../src/conflictSnapshot.ts";

const NONNEGATIVE_ERROR_REGEX = /nonnegative/u;
const OUT_OF_RANGE_ERROR_REGEX = /out of range/u;

function regionLines(
	content: string[],
	range: { start: number; end: number },
): string[] {
	return content.slice(range.start, range.end);
}

function expectExpandedRegion(testCase: {
	base: readonly string[];
	local: readonly string[];
	remote: readonly string[];
	expected: {
		base: readonly string[];
		local: readonly string[];
		remote: readonly string[];
	};
}): void {
	const snapshot = createConflictSnapshot({
		base: testCase.base.join("\n"),
		local: testCase.local.join("\n"),
		remote: testCase.remote.join("\n"),
	});
	const region = getConflictRegion(snapshot, 0);

	expect(regionLines(snapshot.lines.base, region.base)).toEqual(
		testCase.expected.base,
	);
	expect(regionLines(snapshot.lines.local, region.local)).toEqual(
		testCase.expected.local,
	);
	expect(regionLines(snapshot.lines.remote, region.remote)).toEqual(
		testCase.expected.remote,
	);
	expect(region.changes.local.startA).toBeGreaterThanOrEqual(
		region.base.start,
	);
	expect(region.changes.remote.endA).toBeLessThanOrEqual(region.base.end);
}

describe("createConflictSnapshot", () => {
	it("counts independent overlapping edits as separate conflicts", () => {
		const snapshot = createConflictSnapshot({
			base: "alpha\none\nmiddle\ntwo\nomega\n",
			local: "alpha\nlocal one\nmiddle\nlocal two\nomega\n",
			remote: "alpha\nremote one\nmiddle\nremote two\nomega\n",
		});

		expect(snapshot.conflictChangeIndexes).toHaveLength(2);
		for (const index of snapshot.conflictChangeIndexes) {
			const change = snapshot.changes[index];
			expect(change).toBeDefined();
			expect(change?.some((chunk) => chunk?.tag === "conflict")).toBe(
				true,
			);
		}
	});

	it("does not count independent non-overlapping edits as conflicts", () => {
		const snapshot = createConflictSnapshot({
			base: "alpha\none\nmiddle\ntwo\nomega\n",
			local: "alpha\nlocal one\nmiddle\ntwo\nomega\n",
			remote: "alpha\none\nmiddle\nremote two\nomega\n",
		});

		expect(snapshot.conflictChangeIndexes).toHaveLength(0);
		expect(snapshot.mergedContent).toContain("local one");
		expect(snapshot.mergedContent).toContain("remote two");
	});

	it("analyzes both-added content with an empty base", () => {
		const snapshot = createConflictSnapshot({
			base: "",
			local: "local addition\n",
			remote: "remote addition\n",
		});

		expect(snapshot.conflictChangeIndexes).toHaveLength(1);
	});
});

describe("getConflictRegion", () => {
	for (const testCase of [
		{
			name: "same-span replacements",
			base: ["A", "B", "D"],
			local: ["A", "LOCAL", "D"],
			remote: ["A", "REMOTE", "D"],
			expected: {
				base: ["B"],
				local: ["LOCAL"],
				remote: ["REMOTE"],
			},
		},
		{
			name: "narrow local and wide remote replacements",
			base: ["A", "B", "C", "D"],
			local: ["A", "LOCAL", "C", "D"],
			remote: ["A", "REMOTE", "D"],
			expected: {
				base: ["B", "C"],
				local: ["LOCAL", "C"],
				remote: ["REMOTE"],
			},
		},
		{
			name: "wide local and narrow remote replacements",
			base: ["A", "B", "C", "D"],
			local: ["A", "LOCAL", "D"],
			remote: ["A", "REMOTE", "C", "D"],
			expected: {
				base: ["B", "C"],
				local: ["LOCAL"],
				remote: ["REMOTE", "C"],
			},
		},
		{
			name: "local deletion and wide remote replacement",
			base: ["A", "B", "C", "D"],
			local: ["A", "C", "D"],
			remote: ["A", "REMOTE", "D"],
			expected: {
				base: ["B", "C"],
				local: ["C"],
				remote: ["REMOTE"],
			},
		},
		{
			name: "wide local replacement and remote deletion",
			base: ["A", "B", "C", "D"],
			local: ["A", "LOCAL", "D"],
			remote: ["A", "C", "D"],
			expected: {
				base: ["B", "C"],
				local: ["LOCAL"],
				remote: ["C"],
			},
		},
		{
			name: "competing insertions",
			base: ["A", "D"],
			local: ["A", "LOCAL", "D"],
			remote: ["A", "REMOTE", "D"],
			expected: { base: [], local: ["LOCAL"], remote: ["REMOTE"] },
		},
	] as const) {
		it(`expands ${testCase.name} into complete alternatives`, () => {
			expectExpandedRegion(testCase);
		});
	}

	it("selects independent conflicts by their public conflict index", () => {
		const snapshot = createConflictSnapshot({
			base: "A\nB\nMIDDLE\nC\nD",
			local: "A\nLOCAL-B\nMIDDLE\nLOCAL-C\nD",
			remote: "A\nREMOTE-B\nMIDDLE\nREMOTE-C\nD",
		});

		expect(
			regionLines(
				snapshot.lines.base,
				getConflictRegion(snapshot, 0).base,
			),
		).toEqual(["B"]);
		expect(
			regionLines(
				snapshot.lines.base,
				getConflictRegion(snapshot, 1).base,
			),
		).toEqual(["C"]);
	});

	it("rejects invalid and out-of-range indexes", () => {
		const snapshot = createConflictSnapshot({
			base: "base",
			local: "local",
			remote: "remote",
		});

		expect(() => getConflictRegion(snapshot, -1)).toThrow(
			NONNEGATIVE_ERROR_REGEX,
		);
		expect(() => getConflictRegion(snapshot, 1)).toThrow(
			OUT_OF_RANGE_ERROR_REGEX,
		);
	});
});

describe("getCurrentConflictRegion", () => {
	const stages = {
		base: "A\nB\nD",
		local: "A\nLOCAL\nD",
		remote: "A\nREMOTE\nD",
	};

	for (const testCase of [
		{
			name: "local alternative through only the remote-side diff",
			current: "A\nLOCAL\nD",
			expectedLines: ["LOCAL"],
			expectedLocalChanges: 0,
			expectedRemoteChanges: 1,
		},
		{
			name: "remote alternative through only the local-side diff",
			current: "A\nREMOTE\nD",
			expectedLines: ["REMOTE"],
			expectedLocalChanges: 1,
			expectedRemoteChanges: 0,
		},
		{
			name: "third alternative through both side diffs",
			current: "A\nTHIRD\nD",
			expectedLines: ["THIRD"],
			expectedLocalChanges: 1,
			expectedRemoteChanges: 1,
		},
		{
			name: "completely different document through both side diffs",
			current: "UNRELATED",
			expectedLines: ["UNRELATED"],
			expectedLocalChanges: 1,
			expectedRemoteChanges: 1,
		},
		{
			name: "empty document through both side diffs",
			current: "",
			expectedLines: [""],
			expectedLocalChanges: 1,
			expectedRemoteChanges: 1,
		},
	] as const) {
		it(`maps a ${testCase.name}`, () => {
			const snapshot = createConflictSnapshot(stages);
			const region = getConflictRegion(snapshot, 0);
			const current = getCurrentConflictRegion(
				snapshot,
				region,
				testCase.current,
			);

			expect(current).not.toBeNull();
			if (!current) {
				throw new Error("Expected a current conflict region.");
			}
			expect(regionLines(current.lines, current.range)).toEqual(
				testCase.expectedLines,
			);
			expect(current.changes.local).toHaveLength(
				testCase.expectedLocalChanges,
			);
			expect(current.changes.remote).toHaveLength(
				testCase.expectedRemoteChanges,
			);
		});
	}

	it("omits current data when the document equals Weld's merged content", () => {
		const snapshot = createConflictSnapshot(stages);
		const region = getConflictRegion(snapshot, 0);

		expect(
			getCurrentConflictRegion(snapshot, region, snapshot.mergedContent),
		).toBeNull();
	});

	it("maps the selected conflict after unrelated lines are inserted", () => {
		const snapshot = createConflictSnapshot(stages);
		const region = getConflictRegion(snapshot, 0);
		const current = getCurrentConflictRegion(
			snapshot,
			region,
			"PREFIX\nA\nLOCAL\nD",
		);

		expect(current).not.toBeNull();
		if (!current) {
			throw new Error("Expected a current conflict region.");
		}
		expect(regionLines(current.lines, current.range)).toEqual(["LOCAL"]);
	});
});

describe("rangesOverlap", () => {
	it("treats the upper bound as exclusive for a point on either side", () => {
		expect(rangesOverlap({ start: 4, end: 4 }, { start: 3, end: 4 })).toBe(
			false,
		);
		expect(rangesOverlap({ start: 3, end: 4 }, { start: 4, end: 4 })).toBe(
			false,
		);
	});

	it("maps points at the inclusive start and matching empty ranges", () => {
		expect(rangesOverlap({ start: 3, end: 3 }, { start: 3, end: 4 })).toBe(
			true,
		);
		expect(rangesOverlap({ start: 3, end: 4 }, { start: 3, end: 3 })).toBe(
			true,
		);
		expect(rangesOverlap({ start: 3, end: 3 }, { start: 3, end: 3 })).toBe(
			true,
		);
	});

	it("returns false for two non-matching empty ranges", () => {
		expect(rangesOverlap({ start: 2, end: 2 }, { start: 3, end: 3 })).toBe(
			false,
		);
		expect(rangesOverlap({ start: 3, end: 3 }, { start: 2, end: 2 })).toBe(
			false,
		);
	});

	it("overlaps non-empty ranges that share only interior content", () => {
		expect(rangesOverlap({ start: 1, end: 3 }, { start: 2, end: 5 })).toBe(
			true,
		);
		expect(rangesOverlap({ start: 2, end: 5 }, { start: 1, end: 3 })).toBe(
			true,
		);
	});

	it("returns false for non-empty ranges that are strictly adjacent", () => {
		expect(rangesOverlap({ start: 1, end: 3 }, { start: 3, end: 5 })).toBe(
			false,
		);
		expect(rangesOverlap({ start: 3, end: 5 }, { start: 1, end: 3 })).toBe(
			false,
		);
	});
});
