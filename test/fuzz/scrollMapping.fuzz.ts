// biome-ignore-all lint: fuzz tests are chaotic
import "@jazzer.js/jest-runner";
import type { DiffChunkTag } from "../../src/matchers/myers.ts";
import {
	mapLineAcrossChunks,
	mapLineAcrossPanes,
} from "../../src/webview/ui/scrollMapping.ts";
import type { DiffChunk } from "../../src/webview/ui/types.ts";

describe("ScrollMapping Fuzzing", () => {
	it.fuzz("mapLineAcrossChunks should not throw", (data: Buffer) => {
		if (data.length < 12) return;

		const line = Math.abs(data.readFloatBE(0)) % 2000;
		if (Number.isNaN(line)) return;
		const sourceIsA = data[4]! % 2 === 0;
		const sourceMaxLines = (data[5]! % 500) + 1;
		const targetMaxLines = (data[6]! % 500) + 1;

		const chunkCount = data[8]! % 10;
		const chunks: DiffChunk[] = [];
		let offset = 9;

		const tags: DiffChunkTag[] = ["equal", "replace", "delete", "insert"];

		for (let i = 0; i < chunkCount; i++) {
			if (offset + 4 >= data.length) break;
			const tag = tags[data[offset]! % tags.length]!;
			const s1 = data[offset + 1]! % sourceMaxLines;
			const s2 = s1 + (data[offset + 2]! % (sourceMaxLines - s1 + 1));
			const t1 = data[offset + 3]! % targetMaxLines;
			const t2 = t1 + (data[offset + 4]! % (targetMaxLines - t1 + 1));

			// Enforce structural invariants on the chunks we build
			// This ensures the fuzzer doesn't just hit trivial validation errors
			if (sourceIsA) {
				chunks.push({
					tag,
					startA: s1,
					endA: s2,
					startB: t1,
					endB: t2,
				});
			} else {
				chunks.push({
					tag,
					startA: t1,
					endA: t2,
					startB: s1,
					endB: s2,
				});
			}
			offset += 5;
		}

		chunks.sort((a, b) => a.startA - b.startA);

		// Sanitize chunks: remove overlaps and ensure bi-monotonicity
		// to meet input expectations (meld always produces monotonic chunks)
		const validChunks: DiffChunk[] = [];
		let lastEndA = 0;
		let lastEndB = 0;
		for (const c of chunks) {
			if (c.startA >= lastEndA && c.startB >= lastEndB) {
				validChunks.push(c);
				lastEndA = c.endA;
				lastEndB = c.endB;
			}
		}

		const params = {
			chunks: validChunks,
			sourceIsA,
			sourceMaxLines,
			targetMaxLines,
		};

		const res1 = mapLineAcrossChunks(line, params);
		expect(res1).toBeGreaterThanOrEqual(0);
		expect(res1).toBeLessThanOrEqual(targetMaxLines);

		// Operational Equivalence: Monotonicity
		if (line + 1 < sourceMaxLines) {
			const res2 = mapLineAcrossChunks(line + 1, params);
			expect(res2).toBeGreaterThanOrEqual(res1);
		}

		// Operational Equivalence: Identity
		if (sourceMaxLines === targetMaxLines && validChunks.length === 0) {
			expect(mapLineAcrossChunks(line, params)).toBeCloseTo(
				Math.min(line, sourceMaxLines),
			);
		}
	});

	it.fuzz("mapLineAcrossPanes should not throw", (data: Buffer) => {
		if (data.length < 30) return;

		const sourceLine = Math.abs(data.readFloatBE(0)) % 1000;
		if (Number.isNaN(sourceLine)) return;
		const sourceIdx = data[4]! % 5;
		const targetIdx = data[5]! % 5;

		const paneLineCounts = [
			(data[6]! % 100) + 1,
			(data[7]! % 100) + 1,
			(data[8]! % 100) + 1,
			(data[9]! % 100) + 1,
			(data[10]! % 100) + 1,
		];

		const diffIsReversed = [
			data[11]! % 2 === 0,
			data[12]! % 2 === 0,
			data[13]! % 2 === 0,
			data[14]! % 2 === 0,
		];

		// For simplicity, we use empty diffs (1:1 mapping) or simple 1-chunk diffs
		const diffs: (DiffChunk[] | null)[] = [null, null, null, null];

		const res = mapLineAcrossPanes(sourceLine, sourceIdx, targetIdx, {
			diffs,
			paneLineCounts: paneLineCounts as [
				number,
				number,
				number,
				number,
				number,
			],
			diffIsReversed,
		});

		expect(res).toBeGreaterThanOrEqual(0);
		expect(res).toBeLessThanOrEqual(paneLineCounts[targetIdx]!);
	});
});
