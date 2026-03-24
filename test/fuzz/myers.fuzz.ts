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

			const prefixLen = findCommonPrefix(s1, s2);
			expect(s1.substring(0, prefixLen)).toBe(s2.substring(0, prefixLen));
			if (prefixLen < s1.length && prefixLen < s2.length) {
				expect(s1[prefixLen]).not.toBe(s2[prefixLen]);
			}

			const suffixLen = findCommonSuffix(s1, s2);
			expect(s1.substring(s1.length - suffixLen)).toBe(
				s2.substring(s2.length - suffixLen),
			);
			if (suffixLen < s1.length && suffixLen < s2.length) {
				expect(s1[s1.length - suffixLen - 1]).not.toBe(
					s2[s2.length - suffixLen - 1],
				);
			}
		},
	);

	function verifyMatcher(
		matcher: MyersSequenceMatcher<string>,
		s1: string,
		s2: string,
	) {
		const blocks = matcher.getMatchingBlocks();
		const opcodes = matcher.getOpcodes();

		// Structural Invariants: Matching blocks
		for (const [ai, bj, size] of blocks) {
			expect(ai).toBeGreaterThanOrEqual(0);
			expect(bj).toBeGreaterThanOrEqual(0);
			expect(size).toBeGreaterThanOrEqual(0);
			expect(s1.substring(ai, ai + size)).toBe(
				s2.substring(bj, bj + size),
			);
		}

		// Structural Invariants: Opcodes
		let lastEndA = 0;
		let lastEndB = 0;
		for (const chunk of opcodes) {
			expect(chunk.startA).toBeGreaterThanOrEqual(0);
			expect(chunk.endA).toBeGreaterThanOrEqual(chunk.startA);
			expect(chunk.startB).toBeGreaterThanOrEqual(0);
			expect(chunk.endB).toBeGreaterThanOrEqual(chunk.startB);

			// Continuity
			expect(chunk.startA).toBe(lastEndA);
			expect(chunk.startB).toBe(lastEndB);
			lastEndA = chunk.endA;
			lastEndB = chunk.endB;

			if (chunk.tag === "equal") {
				expect(s1.substring(chunk.startA, chunk.endA)).toBe(
					s2.substring(chunk.startB, chunk.endB),
				);
			} else {
				// Non-equal segments should not be identical (though they could share substrings)
				// but let's at least check they are within bounds
				expect(lastEndA).toBeLessThanOrEqual(s1.length);
				expect(lastEndB).toBeLessThanOrEqual(s2.length);
			}
		}
		expect(lastEndA).toBe(s1.length);
		expect(lastEndB).toBe(s2.length);

		// Operational Equivalence: Identity
		const selfMatcher = new MyersSequenceMatcher<string>(null, s1, s1);
		const selfOpcodes = selfMatcher.getOpcodes();
		if (s1.length > 0) {
			// One catch: if s1 is very long, it might be split into multiple equal blocks?
			// MyersSequenceMatcher usually joins them in postprocess.
			const totalEqual = selfOpcodes
				.filter((o) => o.tag === "equal")
				.reduce((prev, curr) => prev + (curr.endA - curr.startA), 0);
			expect(totalEqual).toBe(s1.length);
			expect(selfOpcodes.every((o) => o.tag === "equal")).toBe(true);
		}
	}

	it.fuzz(
		"MyersSequenceMatcher should handle random strings",
		(data: Buffer) => {
			const str = data.toString();
			const mid = Math.floor(str.length / 2);
			const s1 = str.substring(0, mid);
			const s2 = str.substring(mid);

			const matcher = new MyersSequenceMatcher<string>(null, s1, s2);
			verifyMatcher(matcher, s1, s2);
		},
	);

	it.fuzz(
		"InlineMyersSequenceMatcher should handle random strings",
		(data: Buffer) => {
			const str = data.toString();
			const mid = Math.floor(str.length / 2);
			const s1 = str.substring(0, mid);
			const s2 = str.substring(mid);

			const matcher = new InlineMyersSequenceMatcher<string>(
				null,
				s1,
				s2,
			);
			verifyMatcher(matcher, s1, s2);
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

			const matcher = new SyncPointMyersSequenceMatcher<string>(
				null,
				s1,
				s2,
				clampedSyncPoints,
			);
			verifyMatcher(matcher, s1, s2);
		},
	);
});
