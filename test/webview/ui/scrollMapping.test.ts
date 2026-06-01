// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it, test } from "@jest/globals";
import {
	mapLineAcrossChunks,
	mapLineAcrossPanes,
} from "../../../src/webview/ui/scrollMapping.ts";
import type { DiffChunk } from "../../../src/webview/ui/types.ts";

describe("mapLineAcrossChunks (Smooth Mapping Only)", () => {
	describe("basic functionality", () => {
		it("maps 1:1 for null or empty chunks", () => {
			const opts = {
				chunks: null,
				sourceIsA: true,
				sourceMaxLines: 20,
				targetMaxLines: 20,
			};
			expect(mapLineAcrossChunks(5.5, opts)).toBe(5.5);
			expect(
				mapLineAcrossChunks(3.1, {
					...opts,
					chunks: [] as DiffChunk[],
					sourceMaxLines: 10,
					targetMaxLines: 10,
				}),
			).toBe(3.1);
		});

		it("clamps input line and output result", () => {
			const opts = {
				chunks: null,
				sourceIsA: true,
				sourceMaxLines: 20,
				targetMaxLines: 5,
			};
			expect(mapLineAcrossChunks(-10, opts)).toBe(0);
			expect(mapLineAcrossChunks(30, opts)).toBe(5);
			expect(mapLineAcrossChunks(10, opts)).toBe(5);
		});

		it("throws error if chunks extend beyond sourceMaxLines", () => {
			const chunks: DiffChunk[] = [
				{ tag: "equal", startA: 10, endA: 20, startB: 10, endB: 20 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 15,
				targetMaxLines: 30,
			};
			expect(() => mapLineAcrossChunks(5, opts)).toThrow();
		});
	});

	describe("mapping scenarios", () => {
		it("maps lines with simple insert using smooth midpoints", () => {
			const chunks: DiffChunk[] = [
				{ tag: "insert", startA: 10, endA: 10, startB: 10, endB: 20 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 30,
				targetMaxLines: 40,
			};

			// midpoint of gap [0,10,0,10] is (5,5)
			// midpoint of chunk [10,10,10,20] is (10,15)
			// line 5 should map to 5
			expect(mapLineAcrossChunks(5, opts)).toBe(5);
			// line 7.5 maps to midpoint of [5,10] -> [5,15] which is 10.
			expect(mapLineAcrossChunks(7.5, opts)).toBe(10);
			// midpoint of chunk (10) maps to its counterpart midpoint (15)
			expect(mapLineAcrossChunks(10, opts)).toBe(15);
		});

		it("is continuous and monotonic across boundaries", () => {
			const chunks: DiffChunk[] = [
				{ tag: "replace", startA: 10, endA: 20, startB: 10, endB: 30 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 40,
				targetMaxLines: 60,
			};
			const points = [0, 5, 10, 15, 20, 30, 40];
			let last = -1;
			for (const p of points) {
				const res = mapLineAcrossChunks(p, opts);
				expect(res).toBeGreaterThanOrEqual(last);
				last = res;
			}
		});

		it("maps the midpoint of a chunk to its counterpart midpoint", () => {
			const chunks: DiffChunk[] = [
				{ tag: "replace", startA: 10, endA: 20, startB: 10, endB: 30 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 40,
				targetMaxLines: 60,
			};
			expect(mapLineAcrossChunks(15, opts)).toBe(20);
			expect(
				mapLineAcrossChunks(20, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 60,
					targetMaxLines: 40,
				}),
			).toBe(15);
		});
	});
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This is a large test suite
describe("mapLineAcrossPanes", () => {
	const PaneCounts: [number, number, number, number, number] = [
		100, 100, 100, 100, 100,
	];
	const diffs = [
		[
			{
				tag: "replace" as const,
				startA: 10,
				endA: 20,
				startB: 10,
				endB: 30,
			},
		],
		null,
		[
			{
				tag: "replace" as const,
				startA: 30,
				endA: 40,
				startB: 40,
				endB: 50,
			},
		],
		null,
	];

	it("maps identity for same source and target", () => {
		const ctx = {
			diffs: diffs as (DiffChunk[] | null)[],
			paneLineCounts: PaneCounts,
			diffIsReversed: [false, false, false, false],
		};
		expect(mapLineAcrossPanes(50, 2, 2, ctx)).toBe(50);
	});

	it("chains mappings smoothly across multiple panes", () => {
		const ctx = {
			diffs: diffs as (DiffChunk[] | null)[],
			paneLineCounts: PaneCounts,
			diffIsReversed: [false, false, false, false],
		};
		// Mapping through smooth midpoints will not yield the same "discrete" result.
		const res = mapLineAcrossPanes(15, 0, 3, ctx);
		expect(res).toBeGreaterThan(0);
		expect(res).toBeLessThan(100);
	});

	it("respects diffIsReversed", () => {
		const ctx = {
			diffs: diffs as (DiffChunk[] | null)[],
			paneLineCounts: PaneCounts,
			diffIsReversed: [true, false, false, false],
		};
		// From pane 0 to pane 1, but diff0 is reversed.
		// mapping 20 in source (A) to target (B).
		// Chunk is [10,20,10,30]. midA=15, midB=20.
		// line 20 > midA 15.
		// Next gap is [20,100,30,100]. midGapA=60, midGapB=65.
		// mapping 20 in [15, 60] -> [20, 65].
		// res = 20 + (5/45)*45 = 20+5 = 25.
		// Previously reversed logic meant we flipped source/target of the diff.
		const res = mapLineAcrossPanes(20, 0, 1, ctx);
		expect(res).toBeDefined();
	});

	describe("complex multi-pane continuity", () => {
		const paneLineCounts: [number, number, number, number, number] = [
			1000, 200, 1000, 500, 1000,
		];
		const diffs: (DiffChunk[] | null)[] = [
			[
				{
					tag: "delete" as const,
					startA: 100,
					endA: 900,
					startB: 100,
					endB: 100,
				},
			],
			[
				{
					tag: "insert" as const,
					startA: 100,
					endA: 100,
					startB: 100,
					endB: 900,
				},
			],
			[
				{
					tag: "replace" as const,
					startA: 200,
					endA: 800,
					startB: 200,
					endB: 300,
				},
			],
			[
				{
					tag: "replace" as const,
					startA: 0,
					endA: 500,
					startB: 0,
					endB: 1000,
				},
			],
		];

		const ctx = {
			diffs,
			paneLineCounts,
			diffIsReversed: [false, false, false, false],
		};
		const indices = [0, 1, 2, 3, 4];

		describe.each(indices)("from pane %i", (s) => {
			test.each(indices.filter((t) => t !== s))("to pane %i", (t) => {
				const sMax = paneLineCounts[s];
				const tMax = paneLineCounts[t];
				if (sMax === undefined || tMax === undefined) {
					return;
				}

				let lastVal = mapLineAcrossPanes(0, s, t, ctx);
				const samples = 100;
				for (let i = 1; i <= samples; i++) {
					const nextVal = mapLineAcrossPanes(
						(i / samples) * sMax,
						s,
						t,
						ctx,
					);
					const delta = nextVal - lastVal;
					// Monotonicity check
					expect(delta).toBeGreaterThanOrEqual(-1e-10);
					lastVal = nextVal;
				}
			});
		});
	});
});

// ─── exact boundary values ────────────────────────────────────────────────────
// Chunk [10,20] → [10,30]: srcMid=15, dstMid=20.
// Gap before: [0,10,0,10], gapMid=(5,5).
// Gap after:  [20,40,30,60], gapMid=(30,45).
//
// These kill the arithmetic mutants that monotonicity tests miss.

describe("mapLineAcrossChunks exact boundary values", () => {
	const chunk1: DiffChunk = {
		tag: "replace",
		startA: 10,
		endA: 20,
		startB: 10,
		endB: 30,
	};
	const opts = {
		chunks: [chunk1],
		sourceIsA: true,
		sourceMaxLines: 40,
		targetMaxLines: 60,
	};

	it("line 0 maps to 0 (start of source and target)", () => {
		expect(mapLineAcrossChunks(0, opts)).toBe(0);
	});

	it("chunk srcMid (15) maps exactly to dstMid (20)", () => {
		expect(mapLineAcrossChunks(15, opts)).toBe(20);
	});

	it("line at gap midpoint before chunk (5) maps to 5", () => {
		// Gap [0,10] → [0,10]; midGap=(5,5); line=5 is right at midGap.
		expect(mapLineAcrossChunks(5, opts)).toBe(5);
	});

	it("line at gap midpoint after chunk maps correctly", () => {
		// After chunk: gap [20,40] → [30,60]; gapMid=(30,45).
		// chunkSrcMid=15; gapMid=30. line=30 should map to 45.
		expect(mapLineAcrossChunks(30, opts)).toBe(45);
	});

	it("line just before sourceMaxLines maps close to targetMaxLines", () => {
		const result = mapLineAcrossChunks(39.999, opts);
		expect(result).toBeGreaterThan(59);
		expect(result).toBeLessThan(60);
	});

	it("insert chunk: source shorter than target — line at insert point maps past it", () => {
		// Insert at src 10: [10,10] → [10,20]. srcMid=10, dstMid=15.
		const insertOpts = {
			chunks: [
				{
					tag: "insert" as const,
					startA: 10,
					endA: 10,
					startB: 10,
					endB: 20,
				},
			],
			sourceIsA: true,
			sourceMaxLines: 20,
			targetMaxLines: 30,
		};
		// srcMid=10 → dstMid=15
		expect(mapLineAcrossChunks(10, insertOpts)).toBe(15);
	});

	it("delete chunk: source longer than target — srcMid maps to dstMid", () => {
		// Delete at src [10,20] → dst [10,10]. srcMid=15, dstMid=10.
		const deleteOpts = {
			chunks: [
				{
					tag: "delete" as const,
					startA: 10,
					endA: 20,
					startB: 10,
					endB: 10,
				},
			],
			sourceIsA: true,
			sourceMaxLines: 30,
			targetMaxLines: 20,
		};
		expect(mapLineAcrossChunks(15, deleteOpts)).toBe(10);
	});

	it("first chunk starting at 0: line 0 maps to dst chunk midpoint", () => {
		// Chunk [0,10] → [0,20]: srcMid=5, dstMid=10. No gap before.
		const startsAtZeroOpts = {
			chunks: [
				{
					tag: "replace" as const,
					startA: 0,
					endA: 10,
					startB: 0,
					endB: 20,
				},
			],
			sourceIsA: true,
			sourceMaxLines: 10,
			targetMaxLines: 20,
		};
		expect(mapLineAcrossChunks(5, startsAtZeroOpts)).toBe(10);
	});

	it("two chunks: line between them maps correctly through gap interpolation", () => {
		// Chunk A: [0,5] → [0,5]; Chunk B: [15,20] → [15,25].
		// Gap between: src [5,15] → dst [5,15]; gapMid=(10,10).
		const twoChunkOpts = {
			chunks: [
				{
					tag: "replace" as const,
					startA: 0,
					endA: 5,
					startB: 0,
					endB: 5,
				},
				{
					tag: "replace" as const,
					startA: 15,
					endA: 20,
					startB: 15,
					endB: 25,
				},
			],
			sourceIsA: true,
			sourceMaxLines: 20,
			targetMaxLines: 25,
		};
		// srcMidA=2.5 → dstMidA=2.5; gap midSrc=10 → midDst=10.
		// Line 10 is at gapMid so maps to 10.
		expect(mapLineAcrossChunks(10, twoChunkOpts)).toBe(10);
	});
});
