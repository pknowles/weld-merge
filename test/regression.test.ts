import { Merger } from "../src/matchers/merge.ts";
import { mapLineAcrossChunks } from "../src/webview/ui/scrollMapping.ts";
import type { DiffChunk } from "../src/webview/ui/types.ts";

describe("Regression Tests: merge.ts", () => {
	it("AutoMergeDiffer.changeSequence() correctly shifts unresolved markers", () => {
		const merger = new Merger();
		const differ = merger.differ;

		// Initialize differ state to avoid RangeError during cache updates
		differ.numSequences = 3;
		differ.seqLength = [100, 100, 100, 0, 0];
		// biome-ignore lint/suspicious/noExplicitAny: hacking into internals for regression testing
		(differ as any)._lineCache = [
			new Array(101).fill([null, null, null]),
			new Array(101).fill([null, null, null]),
			new Array(101).fill([null, null, null]),
			[],
			[],
		];

		// Setup initial unresolved markers
		// Note: unresolved markers are indices in the merged text
		differ.unresolved = [10, 20, 30];

		// 1. Delete before markers
		// changeSequence(sequence, startidx, sizechange, texts)
		// sequence 1 is the merged/middle pane in Merger's context usually?
		differ.changeSequence(1, 5, -2, [[], [], []]);
		expect(differ.unresolved).toEqual([8, 18, 28]);

		// 2. Delete overlapping a marker
		// Current: [8, 18, 28]. Delete 5 lines at index 15 (covers 18)
		differ.changeSequence(1, 15, -5, [[], [], []]);
		expect(differ.unresolved).toEqual([8, 23]); // 18 is gone, 28 becomes 28-5=23

		// 3. Insert before markers
		// Current: [8, 23]. Insert 10 lines at index 0
		differ.changeSequence(1, 0, 10, [[], [], []]);
		expect(differ.unresolved).toEqual([18, 33]);

		// 4. Insert exactly at a marker
		// Current: [18, 33]. Insert 0 lines at index 18
		differ.changeSequence(1, 18, 0, [[], [], []]);
		expect(differ.unresolved).toEqual([33]);
	});

	it("Merger helper methods for appending lines", () => {
		// biome-ignore lint/suspicious/noExplicitAny: Accessing protected methods for testing
		const merger = new Merger() as any;
		const mergedText: string[] = [];
		const baseText = ["line0", "line1", "line2", "line3"];

		// Test _appendLines
		merger._appendLines(1, 3, baseText, mergedText);
		expect(mergedText).toEqual(["line1", "line2"]);

		// Test _appendRemainingLines
		merger._appendRemainingLines(3, baseText, mergedText);
		expect(mergedText).toEqual(["line1", "line2", "line3"]);

		// Test _calculateLowMark
		const ch0 = {
			startA: 10,
			endA: 15,
			startB: 10,
			endB: 15,
			tag: "equal",
		} as DiffChunk;
		const ch1 = {
			startA: 20,
			endA: 25,
			startB: 20,
			endB: 25,
			tag: "equal",
		} as DiffChunk;

		expect(merger._calculateLowMark(ch0, ch1, 5)).toBe(20);
		expect(merger._calculateLowMark(ch0, null, 5)).toBe(10);
		expect(merger._calculateLowMark(null, ch1, 5)).toBe(20);
		expect(merger._calculateLowMark(null, null, 5)).toBe(5);
	});
});

describe("Regression Tests: scrollMapping.ts (now exclusively smooth)", () => {
	const chunks: DiffChunk[] = [
		{ tag: "equal", startA: 10, endA: 20, startB: 10, endB: 30 }, // 10 lines A -> 20 lines B
	];

	it("mapLineAcrossChunks implements smooth interpolation", () => {
		// Line 10: midpoint between gap [0,10,0,10]->(5,5) and chunk mid (15,20).
		// midpoint of gap is 5 in A, 5 in B.
		// midpoint of chunk is 15 in A, 20 in B.
		// mapping 10 in [5, 15] -> [5, 20] results in 12.5.
		expect(
			mapLineAcrossChunks(10, {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 100,
				targetMaxLines: 100,
			}),
		).toBe(12.5);

		// At sEnd (20): midpoint between chunk mid (15,20) and gap [20,100,30,100]->(60,65).
		// midpoint of chunk is 15 in A, 20 in B.
		// midpoint of gap is 60 in A, 65 in B.
		// mapping 20 in [15, 60] -> [20, 65] results in 20 + (5/45)*45 = 25.
		expect(
			mapLineAcrossChunks(20, {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 100,
				targetMaxLines: 100,
			}),
		).toBe(25);
	});

	it("mapLineAcrossChunks handles empty chunks", () => {
		expect(
			mapLineAcrossChunks(50, {
				chunks: [],
				sourceIsA: true,
				sourceMaxLines: 100,
				targetMaxLines: 100,
			}),
		).toBe(50);
	});

	it("mapLineAcrossChunks clamps to bounds", () => {
		// If line (250) > sourceMaxLines (200), it's clamped to 200 - eps
		expect(
			mapLineAcrossChunks(250, {
				chunks: [],
				sourceIsA: true,
				sourceMaxLines: 200,
				targetMaxLines: 300,
			}),
		).toBeCloseTo(200);
		// Actually, mapLineAcrossChunks with no chunks returns targetClamp(clampedLine).
		// targetClamp(Math.min(250, 200-eps)) = targetClamp(200-eps) = 200.
	});
});
