import { mapLineAcrossPanes } from "./scrollMapping";
import type { DiffChunk } from "./types";

describe("5-Pane Scroll Mapping Regression Test", () => {
	// The setup that caused the bug:
	// Pane 1 (Local): 10 lines
	// Pane 2 (Merged): 100 lines
	// diffs[1] (Local-Merged): A=Merged(100 lines), B=Local(10 lines)
	// Note: Our scrollMapping utility expects diffs[i] to connect Pane i and Pane i+1.
	// In our case:
	// diffs[1] connects Pane 1 (Local) and Pane 2 (Merged).
	// By original convention (A=left, B=right), it SHOULD have been A=Local, B=Merged.
	// BUT the data payload provides it as A=Merged, B=Local.
	// So diffIsReversed[1] must be true.

	const paneCounts = [100, 10, 100, 10, 100]; // Base, Local, Merged, Remote, BaseR

	// A replacement chunk that covers the whole file.
	// In Merged (Pane 2, Side A), it's lines 0-100.
	// In Local (Pane 1, Side B), it's lines 0-10.
	const diffs: (DiffChunk[] | null)[] = [
		null, // diffs[0] (Base - Local)
		[{ tag: "replace", start_a: 0, end_a: 100, start_b: 0, end_b: 10 }], // diffs[1] (Local - Merged)
		null, // diffs[2] (Merged - Remote)
		null, // diffs[3] (Remote - BaseR)
	];

	it("should map from Local to Merged without throwing even if Merged is longer", () => {
		const sourceIdx = 1; // Local
		const targetIdx = 2; // Merged
		const sourceLine = 5; // Middle of Local

		expect(() => {
			mapLineAcrossPanes(
				sourceLine,
				sourceIdx,
				targetIdx,
				diffs,
				paneCounts,
				true, // smooth
				[false, true, false, false],
			);
		}).not.toThrow();
	});

	it("should throw if the reversal is NOT specified (repro of the bug)", () => {
		const sourceIdx = 1; // Local
		const targetIdx = 2; // Merged
		const sourceLine = 5;

		expect(() => {
			mapLineAcrossPanes(
				sourceLine,
				sourceIdx,
				targetIdx,
				diffs,
				paneCounts,
				true,
				[false, false, false, false],
			);
		}).toThrow("last chunk outside _sourceMaxLines");
	});

	it("maps correctly from Local to Merged with disproportionate sizes", () => {
		const sourceIdx = 1; // Local
		const targetIdx = 2; // Merged
		const sourceLine = 5; // 50% through Local

		const result = mapLineAcrossPanes(
			sourceLine,
			sourceIdx,
			targetIdx,
			diffs,
			paneCounts,
			true,
			[false, true, false, true],
		);

		expect(result).toBeCloseTo(50, 0);
	});

	it("handles mapping into a single-line file side gracefully", () => {
		const emptyDiffs: (DiffChunk[] | null)[] = [
			null,
			[{ tag: "delete", start_a: 0, end_a: 10, start_b: 0, end_b: 0 }],
			null,
			null,
		];
		const counts = [10, 1, 10, 10, 10]; // 1 line minimum for "empty"

		const res = mapLineAcrossPanes(5, 2, 1, emptyDiffs, counts, true, [
			false,
			true,
			false,
			false,
		]);
		expect(res).toBeLessThan(1);
		expect(res).toBeGreaterThanOrEqual(0);
	});

	it("handles multiple chunks across panes with mixed reversal states", () => {
		const complexDiffs: (DiffChunk[] | null)[] = [
			null,
			[
				{ tag: "replace", start_a: 0, end_a: 50, start_b: 0, end_b: 10 },
				{ tag: "equal", start_a: 50, end_a: 60, start_b: 10, end_b: 20 },
				{ tag: "replace", start_a: 60, end_a: 100, start_b: 20, end_b: 30 },
			],
			[{ tag: "equal", start_a: 0, end_a: 100, start_b: 0, end_b: 100 }],
			null,
		];
		const counts = [100, 30, 100, 100, 100];

		// Complex case: Local(1) to Remote(3) through Merged(2)
		const res = mapLineAcrossPanes(15, 1, 3, complexDiffs, counts, true, [
			false,
			true,
			false,
			false,
		]);
		expect(res).toBeCloseTo(55, 0);
	});
});
