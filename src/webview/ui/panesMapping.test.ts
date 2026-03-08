// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { mapLineAcrossPanes } from "./scrollMapping.ts";
import type { DiffChunk } from "./types.ts";

const LINE_COUNT_STANDARD = 100;
const LINE_COUNT_SHORT = 10;
const LINE_COUNT_VERY_SHORT = 1;
const LINE_COUNT_COMPLEX = 30;

const SOURCE_LINE_MIDDLE = 5;
const SOURCE_LINE_COMPLEX = 15;
const TARGET_LINE_EXPECTED_50 = 50;
const TARGET_LINE_EXPECTED_55 = 55;

const PANE_LOCAL = 1;
const PANE_MERGED = 2;
const PANE_REMOTE = 3;

const PANE_COUNTS = [
	LINE_COUNT_STANDARD,
	LINE_COUNT_SHORT,
	LINE_COUNT_STANDARD,
	LINE_COUNT_SHORT,
	LINE_COUNT_STANDARD,
];

const STANDARD_DIFFS: (DiffChunk[] | null)[] = [
	null,
	[{ tag: "replace", startA: 0, endA: 100, startB: 0, endB: 10 }],
	null,
	null,
];

describe("5-Pane Scroll Mapping Basic Tests", () => {
	it("should map from Local to Merged without throwing even if Merged is longer", () => {
		expect(() => {
			mapLineAcrossPanes(
				SOURCE_LINE_MIDDLE,
				PANE_LOCAL,
				PANE_MERGED,
				STANDARD_DIFFS,
				PANE_COUNTS,
				true,
				[false, true, false, false],
			);
		}).not.toThrow();
	});

	it("should throw if the reversal is NOT specified (repro of the bug)", () => {
		expect(() => {
			mapLineAcrossPanes(
				SOURCE_LINE_MIDDLE,
				PANE_LOCAL,
				PANE_MERGED,
				STANDARD_DIFFS,
				PANE_COUNTS,
				true,
				[false, false, false, false],
			);
		}).toThrow("last chunk outside _sourceMaxLines");
	});

	it("handles mapping into a single-line file side gracefully", () => {
		const emptyDiffs: (DiffChunk[] | null)[] = [
			null,
			[{ tag: "delete", startA: 0, endA: 10, startB: 0, endB: 0 }],
			null,
			null,
		];
		const counts = [
			LINE_COUNT_SHORT,
			LINE_COUNT_VERY_SHORT,
			LINE_COUNT_SHORT,
			LINE_COUNT_SHORT,
			LINE_COUNT_SHORT,
		];
		const res = mapLineAcrossPanes(
			SOURCE_LINE_MIDDLE,
			PANE_MERGED,
			PANE_LOCAL,
			emptyDiffs,
			counts,
			true,
			[false, true, false, false],
		);
		expect(res).toBeLessThan(1);
		expect(res).toBeGreaterThanOrEqual(0);
	});
});

describe("5-Pane Scroll Mapping Advanced Tests", () => {
	it("maps correctly from Local to Merged with disproportionate sizes", () => {
		const result = mapLineAcrossPanes(
			SOURCE_LINE_MIDDLE,
			PANE_LOCAL,
			PANE_MERGED,
			STANDARD_DIFFS,
			PANE_COUNTS,
			true,
			[false, true, false, true],
		);
		expect(result).toBeCloseTo(TARGET_LINE_EXPECTED_50, 0);
	});

	it("handles multiple chunks across panes with mixed reversal states", () => {
		const complexDiffs: (DiffChunk[] | null)[] = [
			null,
			[
				{ tag: "replace", startA: 0, endA: 50, startB: 0, endB: 10 },
				{ tag: "equal", startA: 50, endA: 60, startB: 10, endB: 20 },
				{ tag: "replace", startA: 60, endA: 100, startB: 20, endB: 30 },
			],
			[{ tag: "equal", startA: 0, endA: 100, startB: 0, endB: 100 }],
			null,
		];
		const counts = [
			LINE_COUNT_STANDARD,
			LINE_COUNT_COMPLEX,
			LINE_COUNT_STANDARD,
			LINE_COUNT_STANDARD,
			LINE_COUNT_STANDARD,
		];
		const res = mapLineAcrossPanes(
			SOURCE_LINE_COMPLEX,
			PANE_LOCAL,
			PANE_REMOTE,
			complexDiffs,
			counts,
			true,
			[false, true, false, false],
		);
		expect(res).toBeCloseTo(TARGET_LINE_EXPECTED_55, 0);
	});
});
