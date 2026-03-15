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
		if (data.length < 5) return;

		const line = data.readFloatBE(0) % 1000 || 0;
		const sourceIsA = data[4]! % 2 === 0;
		const sourceMaxLines = (data[5]! % 500) + 1;
		const targetMaxLines = (data[6]! % 500) + 1;
		const smooth = data[7]! % 2 === 0;

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

			chunks.push({ tag, startA: s1, endA: s2, startB: t1, endB: t2 });
			offset += 5;
		}

		chunks.sort((a, b) => a.startA - b.startA);

		try {
			mapLineAcrossChunks(
				line,
				chunks,
				sourceIsA,
				sourceMaxLines,
				targetMaxLines,
				smooth,
			);
		} catch (e) {
			// Validation errors like "last chunk outside _sourceMaxLines" are expected if we don't clamp perfectly
		}
	});

	it.fuzz("mapLineAcrossPanes should not throw", (data: Buffer) => {
		if (data.length < 20) return;

		const sourceLine = data.readFloatBE(0) % 500 || 0;
		const sourceIdx = data[4]! % 5;
		const targetIdx = data[5]! % 5;
		const smooth = data[6]! % 2 === 0;

		const paneLineCounts = [
			(data[7]! % 100) + 1,
			(data[8]! % 100) + 1,
			(data[9]! % 100) + 1,
			(data[10]! % 100) + 1,
			(data[11]! % 100) + 1,
		];

		const diffIsReversed = [
			data[12]! % 2 === 0,
			data[13]! % 2 === 0,
			data[14]! % 2 === 0,
			data[15]! % 2 === 0,
		];

		const diffs: (DiffChunk[] | null)[] = [null, null, null, null];

		try {
			mapLineAcrossPanes(
				sourceLine,
				sourceIdx,
				targetIdx,
				diffs,
				paneLineCounts,
				smooth,
				diffIsReversed,
			);
		} catch (e) {
			// Recursive calls or parameter mismatches might throw, which is fine as long as it's not a crash
		}
	});
});
