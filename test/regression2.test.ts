import { Differ } from "../src/matchers/diffutil.ts";
import { SyncPointMyersSequenceMatcher } from "../src/matchers/myers.ts";
import { mapLineAcrossChunks } from "../src/webview/ui/scrollMapping.ts";
import type { DiffChunk } from "../src/webview/ui/types.ts";

describe("More Regression Tests: diffutil & myers", () => {
	it("SyncPointMyersSequenceMatcher getOpcodes resolves with syncpoints", () => {
		const seqA = ["A", "B", "C", "D", "E"];
		const seqB = ["A", "X", "C", "Y", "E"];
		const matcher = new SyncPointMyersSequenceMatcher(null, seqA, seqB, [
			[2, 2], // Sync on "C"
			[4, 4], // Sync on "E"
		]);
		const it = matcher.initialize();
		for (const _ of it) {
			// consume
		}

		const opcodes = matcher.getOpcodes();
		expect(opcodes).toBeDefined();
		expect(opcodes.length).toBeGreaterThan(0);
	});

	it("Differ clear() resets state", () => {
		const diff = new Differ();
		const it = diff.setSequencesIter([["A"], ["B"]]);
		for (const _ of it) {
			/* consume */
		}
		expect(diff.diffs[0].length).toBeGreaterThan(0);
		diff.clear();
		expect(diff.diffs[0].length).toBe(0);
	});

	it("Differ handles syncPoints properly", () => {
		const diff = new Differ();
		const p: [() => number, () => number] = [() => 2, () => 2];
		diff.syncPoints = [[p]];
		const it = diff.setSequencesIter([
			["A", "B", "C"],
			["A", "X", "C"],
			["A", "Y", "C"],
		]);
		for (const _ of it) {
			/* consume */
		}
		expect(diff.diffs[0]).toBeDefined();
	});
});

describe("More Regression Tests: scrollMapping.ts", () => {
	it("mapLineAcrossChunks proportional mapping before first chunk", () => {
		// Chunk at index 0
		const chunks: DiffChunk[] = [
			{ tag: "equal", startA: 10, endA: 20, startB: 10, endB: 20 },
		];
		// upperBound = 0 (line < 10)
		// line = 2.
		// prev implicit chunk for 0 is [0, 10, 0, 10]. mid is 5.
		// line (2) < mid (5).
		const res = mapLineAcrossChunks(2, {
			chunks,
			sourceIsA: true,
			sourceMaxLines: 30,
			targetMaxLines: 30,
		});
		expect(res).toBe(2);
	});

	it("mapLineAcrossChunks proportional mapping inside gap", () => {
		const chunks: DiffChunk[] = [
			{ tag: "equal", startA: 0, endA: 10, startB: 0, endB: 10 },
			{ tag: "equal", startA: 20, endA: 30, startB: 20, endB: 30 },
		];
		// upperBound = 1, chunk is 20..30
		// curUpper srcMid is 25.
		// line = 28 -> > srcMid(25).
		// Should hit the branch taking `next` implicit chunk.
		const res = mapLineAcrossChunks(28, {
			chunks,
			sourceIsA: true,
			sourceMaxLines: 40,
			targetMaxLines: 40,
		});
		expect(res).toBeGreaterThan(25);
	});

	it("mapLineAcrossChunks smooth interpolation in leading/intermediate gap", () => {
		const chunks: DiffChunk[] = [
			{ tag: "equal", startA: 10, endA: 20, startB: 15, endB: 25 },
			{ tag: "equal", startA: 30, endA: 40, startB: 35, endB: 45 },
		];
		// Line in leading gap (0 to 10)
		// Now uses smooth interpolation. line=5 -> gap mid is 5, maps to 7.5.
		expect(
			mapLineAcrossChunks(5, {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 50,
				targetMaxLines: 50,
			}),
		).toBe(7.5);
		// Line in intermediate gap (24) -> upper = 1.
		// Gap is [20, 30, 25, 35]. offset is 25 - 20 = 5.
		// Mapping 24 in [15, 25] -> [20, 30] results in 29.
		expect(
			mapLineAcrossChunks(24, {
				chunks,
				sourceIsA: true,
				sourceMaxLines: 50,
				targetMaxLines: 50,
			}),
		).toBe(29);
	});
});
