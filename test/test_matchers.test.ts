import {
	findCommonPrefix,
	findCommonSuffix,
	InlineMyersSequenceMatcher,
	MyersSequenceMatcher,
	SyncPointMyersSequenceMatcher,
} from "../src/matchers/myers.ts";

describe("MyersSequenceMatcher", () => {
	describe("Prefix/Suffix matching", () => {
		it("finds common prefix", () => {
			expect(findCommonPrefix("abcdef", "abcfed")).toBe(3);
			expect(findCommonPrefix("abcdef", "abcdef")).toBe(6);
			expect(findCommonPrefix("abcdef", "")).toBe(0);
		});

		it("finds common suffix", () => {
			expect(findCommonSuffix("abcdef", "feddef")).toBe(3);
			expect(findCommonSuffix("abcdef", "abcdef")).toBe(6);
			expect(findCommonSuffix("abcdef", "")).toBe(0);
		});
	});

	describe("Sequence matching", () => {
		it("matches identical sequences", () => {
			const matcher = new MyersSequenceMatcher(null, "abcdef", "abcdef");
			expect(matcher.getOpcodes()).toEqual([
				{ tag: "equal", startA: 0, endA: 6, startB: 0, endB: 6 },
			]);
		});

		it("handles complete replacements", () => {
			const matcher = new MyersSequenceMatcher(null, "abc", "def");
			expect(matcher.getOpcodes()).toEqual([
				{ tag: "replace", startA: 0, endA: 3, startB: 0, endB: 3 },
			]);
		});
	});
	describe("Matching blocks", () => {
		it("handles basic matcher sequences", () => {
			const a = Array.from("abcbdefgabcdefg");
			const b = Array.from("gfabcdefcd");
			const r = [
				[0, 2, 3],
				[4, 5, 3],
				[10, 8, 2],
				[15, 10, 0],
			];
			const matcher = new MyersSequenceMatcher(null, a, b);
			const blocks = matcher.getMatchingBlocks();
			expect(blocks).toEqual(r);
		});

		it("handles postprocessing cleanup", () => {
			const a = Array.from("abcfabgcd");
			const b = Array.from("afabcgabgcabcd");
			const r = [
				[0, 2, 3],
				[4, 6, 3],
				[7, 12, 2],
				[9, 14, 0],
			];
			const matcher = new MyersSequenceMatcher(null, a, b);
			const blocks = matcher.getMatchingBlocks();
			expect(blocks).toEqual(r);
		});
	});
});

describe("InlineMyersSequenceMatcher", () => {
	it("uses k-mers for better inline matching", () => {
		const a = "red, blue, yellow, white";
		const b = "black green, hue, white";
		const r = [
			[17, 16, 7],
			[24, 23, 0],
		];
		const matcher = new InlineMyersSequenceMatcher(null, a, b);
		const blocks = matcher.getMatchingBlocks();
		expect(blocks).toEqual(r);
	});
});

describe("SyncPointMyersSequenceMatcher", () => {
	it("handles sync point matcher 0", () => {
		const a = Array.from("012a3456c789");
		const b = Array.from("0a3412b5678");
		const r = [
			[0, 0, 1],
			[3, 1, 3],
			[6, 7, 2],
			[9, 9, 2],
			[12, 11, 0],
		];
		const matcher = new SyncPointMyersSequenceMatcher(null, a, b);
		const blocks = matcher.getMatchingBlocks();
		expect(blocks).toEqual(r);
	});

	it("handles sync point matcher 2", () => {
		const a = Array.from("012a3456c789");
		const b = Array.from("0a3412b5678");
		const r = [
			[0, 0, 1],
			[1, 4, 2],
			[6, 7, 2],
			[9, 9, 2],
			[12, 11, 0],
		];
		const matcher = new SyncPointMyersSequenceMatcher(null, a, b, [[3, 6]]);
		const blocks = matcher.getMatchingBlocks();
		expect(blocks).toEqual(r);
	});

	it("handles sync point matcher 3", () => {
		const a = Array.from("012a3456c789");
		const b = Array.from("02a341b5678");
		const r = [
			[0, 0, 1],
			[2, 1, 1],
			[3, 2, 3],
			[9, 9, 2],
			[12, 11, 0],
		];
		const matcher = new SyncPointMyersSequenceMatcher(null, a, b, [
			[3, 2],
			[8, 6],
		]);
		const blocks = matcher.getMatchingBlocks();
		expect(blocks).toEqual(r);
	});
});
