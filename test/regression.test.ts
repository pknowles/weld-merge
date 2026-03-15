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
		// In Merger.initialize, sequences are [LOCAL, BASE, REMOTE].
		// AutoMergeDiffer is a Differ. Differ.setSequences(sequences)
		// Merger.initialize calls this.differ.setSequencesIter(sequences)

		// If we change sequence 1 (BASE/Merged) at index 5, sizechange -2
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
		// Current: [18, 33]. Insert 0 lines at index 18 (sizechange 0 is used for some reason in the code?)
		// Code says: else if (sizechange === 0 && startidx === this.unresolved[lo]) { hi++; }
		// This seems to delete a marker if an empty change happens exactly at it.
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

describe("Regression Tests: scrollMapping.ts", () => {
	const chunks: DiffChunk[] = [
		{ tag: "equal", startA: 10, endA: 20, startB: 10, endB: 30 }, // 10 lines A -> 20 lines B
	];

	it("mapLineAcrossChunks kills boundary mutants (smooth=false)", () => {
		// Exact start boundary
		expect(mapLineAcrossChunks(10, chunks, true, 100, 100, false)).toBe(10);
		// Just inside start
		expect(mapLineAcrossChunks(10.1, chunks, true, 100, 110, false)).toBe(
			10.2,
		);

		// Exact end boundary
		// sEnd is 20. B end is 30.
		// If line < sEnd (20), it's in the chunk.
		expect(
			mapLineAcrossChunks(19.9, chunks, true, 100, 110, false),
		).toBeCloseTo(29.8);

		// At sEnd (20), it should be in the gap AFTER the chunk
		// Gap starts at sEnd=20, tEnd=30. Offset is tEnd - sEnd = 10.
		// result = line + offset = 20 + 10 = 30.
		expect(mapLineAcrossChunks(20, chunks, true, 100, 110, false)).toBe(30);
	});

	it("mapLineAcrossChunks handles empty chunks and large offsets", () => {
		// Empty chunks should be 1:1 but clamped
		expect(mapLineAcrossChunks(50, [], true, 100, 100, false)).toBe(50);
		// If line (250) > sourceMaxLines (200), it's clamped to 200 - eps
		expect(mapLineAcrossChunks(250, [], true, 200, 300, false)).toBeCloseTo(
			200,
		);
	});

	it("mapLineAcrossChunks trailing gap offset logic", () => {
		const trailingChunks: DiffChunk[] = [
			{ tag: "equal", startA: 0, endA: 10, startB: 0, endB: 20 },
		];
		// Line 15. Offset from last chunk is 20 - 10 = 10.
		// Result 15 + 10 = 25.
		expect(
			mapLineAcrossChunks(15, trailingChunks, true, 100, 100, false),
		).toBe(25);
	});
});
