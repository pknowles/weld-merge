// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { mapLineAcrossChunks, mapLineAcrossPanes } from "./scrollMapping.ts";
import type { DiffChunk } from "./types.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This is a large test file with many scenarios
describe("mapLineAcrossChunks", () => {
	describe("basic functionality", () => {
		it("maps 1:1 for null or empty chunks", () => {
			const opts = {
				chunks: null,
				sourceIsA: true,
				sourceMaxLines: 20,
				targetMaxLines: 20,
				smooth: true,
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
				smooth: false,
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
				smooth: false,
			};
			expect(() => mapLineAcrossChunks(5, opts)).toThrow();
		});
	});

	describe("discrete mapping scenarios", () => {
		it("maps lines with simple insert", () => {
			const chunks: DiffChunk[] = [
				{ tag: "insert", startA: 5, endA: 5, startB: 5, endB: 10 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 20,
				targetMaxLines: 25,
				smooth: false,
			};

			expect(mapLineAcrossChunks(2, opts)).toBe(2);
			expect(
				mapLineAcrossChunks(2, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 25,
					targetMaxLines: 20,
				}),
			).toBe(2);
			expect(
				mapLineAcrossChunks(7.5, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 25,
					targetMaxLines: 20,
				}),
			).toBe(5);
			expect(mapLineAcrossChunks(10, opts)).toBe(15);
			expect(
				mapLineAcrossChunks(15, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 25,
					targetMaxLines: 20,
				}),
			).toBe(10);
		});

		it("maps lines with complex multi-chunk scenario", () => {
			const chunks: DiffChunk[] = [
				{ tag: "delete", startA: 5, endA: 10, startB: 5, endB: 5 },
				{ tag: "insert", startA: 20, endA: 20, startB: 15, endB: 25 },
				{ tag: "replace", startA: 30, endA: 35, startB: 35, endB: 45 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 50,
				targetMaxLines: 60,
				smooth: false,
			};

			expect(mapLineAcrossChunks(2, opts)).toBe(2);
			expect(mapLineAcrossChunks(7, opts)).toBe(5);
			expect(mapLineAcrossChunks(15, opts)).toBe(10);
			expect(
				mapLineAcrossChunks(10, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 60,
					targetMaxLines: 50,
				}),
			).toBe(15);
			expect(
				mapLineAcrossChunks(20, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 60,
					targetMaxLines: 50,
				}),
			).toBe(20);
			expect(mapLineAcrossChunks(25, opts)).toBe(30);
			expect(mapLineAcrossChunks(32.5, opts)).toBe(40);
			expect(mapLineAcrossChunks(40, opts)).toBe(50);
		});
	});

	describe("smooth mapping", () => {
		const chunks: DiffChunk[] = [
			{ tag: "replace", startA: 10, endA: 20, startB: 10, endB: 30 },
		];
		const opts = {
			chunks,
			sourceIsA: true,
			sourceMaxLines: 40,
			targetMaxLines: 60,
			smooth: true,
		};

		it("is continuous and monotonic across boundaries", () => {
			const points = [0, 5, 10, 15, 20, 30, 40];
			let last = -1;
			for (const p of points) {
				const res = mapLineAcrossChunks(p, opts);
				expect(res).toBeGreaterThanOrEqual(last);
				last = res;
			}
		});

		it("maps the midpoint of a chunk to its counterpart midpoint", () => {
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

		it("maps lines before delete shifted backwards (unsmoothed)", () => {
			const chunks: DiffChunk[] = [
				{ tag: "delete", startA: 5, endA: 15, startB: 5, endB: 5 },
			];
			const opts = {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 30,
				targetMaxLines: 20,
				smooth: false,
			};
			expect(mapLineAcrossChunks(16, opts)).toBe(6);
			expect(
				mapLineAcrossChunks(6, {
					...opts,
					sourceIsA: false,
					sourceMaxLines: 20,
					targetMaxLines: 30,
				}),
			).toBe(16);
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
			diffs,
			paneLineCounts: PaneCounts,
			smooth: false,
			diffIsReversed: [false, false, false, false],
		};
		expect(mapLineAcrossPanes(50, 2, 2, ctx)).toBe(50);
	});

	it("chains mappings across multiple panes (unsmoothed)", () => {
		const ctx = {
			diffs,
			paneLineCounts: PaneCounts,
			smooth: false,
			diffIsReversed: [false, false, false, false],
		};
		expect(mapLineAcrossPanes(15, 0, 3, ctx)).toBe(30);
	});

	it("respects diffIsReversed", () => {
		const ctx = {
			diffs,
			paneLineCounts: PaneCounts,
			smooth: false,
			diffIsReversed: [true, false, false, false],
		};
		expect(mapLineAcrossPanes(20, 0, 1, ctx)).toBe(15);
	});

	describe("complex multi-pane scenarios", () => {
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

		describe("continuity tests", () => {
			const ctx = {
				diffs,
				paneLineCounts,
				smooth: true,
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
						const delta = Math.abs(nextVal - lastVal);
						const expectedDelta = (1 / samples) * tMax;
						expect(delta).toBeLessThan(expectedDelta * 10);
						lastVal = nextVal;
					}
				});
			});
		});

		it("correctly maps middle of the file across complex changes", () => {
			const ctx = {
				diffs,
				paneLineCounts,
				smooth: true,
				diffIsReversed: [false, false, false, false],
			};
			const tMax = paneLineCounts[2] ?? 0;
			expect(mapLineAcrossPanes(100, 1, 2, ctx)).toBe(tMax / 2);
		});
	});
});
