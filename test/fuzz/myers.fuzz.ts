// biome-ignore-all lint: fuzz tests are chaotic
import "@jazzer.js/jest-runner";
import {
	findCommonPrefix,
	findCommonSuffix,
	InlineMyersSequenceMatcher,
	MyersSequenceMatcher,
	SyncPointMyersSequenceMatcher,
} from "../../src/matchers/myers.ts";

describe("Myers Fuzzing", () => {
	it.fuzz(
		"findCommonPrefix and findCommonSuffix should not throw",
		(data: Buffer) => {
			const str = data.toString();
			const mid = Math.floor(str.length / 2);
			const s1 = str.substring(0, mid);
			const s2 = str.substring(mid);

			findCommonPrefix(s1, s2);
			findCommonSuffix(s1, s2);
		},
	);

	it.fuzz(
		"MyersSequenceMatcher should handle random strings",
		(data: Buffer) => {
			const str = data.toString();
			const mid = Math.floor(str.length / 2);
			const s1 = str.substring(0, mid);
			const s2 = str.substring(mid);

			const matcher = new MyersSequenceMatcher(null, s1, s2);
			matcher.getOpcodes();
			matcher.getMatchingBlocks();
		},
	);

	it.fuzz(
		"InlineMyersSequenceMatcher should handle random strings",
		(data: Buffer) => {
			const str = data.toString();
			const mid = Math.floor(str.length / 2);
			const s1 = str.substring(0, mid);
			const s2 = str.substring(mid);

			const matcher = new InlineMyersSequenceMatcher(null, s1, s2);
			matcher.getOpcodes();
			matcher.getMatchingBlocks();
		},
	);

	it.fuzz(
		"SyncPointMyersSequenceMatcher should handle random strings and sync points",
		(data: Buffer) => {
			if (data.length < 4) return;
			const syncCount = data[0]! % 5;
			const syncPoints: [number, number][] = [];
			let offset = 1;
			for (let i = 0; i < syncCount; i++) {
				if (offset + 1 >= data.length) break;
				syncPoints.push([data[offset]!, data[offset + 1]!]);
				offset += 2;
			}

			const remaining = data.slice(offset).toString();
			const mid = Math.floor(remaining.length / 2);
			const s1 = remaining.substring(0, mid);
			const s2 = remaining.substring(mid);

			// Clamp sync points to string lengths to avoid out of bounds in slice
			const clampedSyncPoints: [number, number][] = syncPoints
				.map(([a, b]): [number, number] => [
					a % (s1.length + 1),
					b % (s2.length + 1),
				])
				.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

			const matcher = new SyncPointMyersSequenceMatcher(
				null,
				s1,
				s2,
				clampedSyncPoints,
			);
			matcher.getOpcodes();
			matcher.getMatchingBlocks();
		},
	);
});
