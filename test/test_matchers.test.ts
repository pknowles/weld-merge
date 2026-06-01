import { describe, expect, it } from "@jest/globals";
import {
	findCommonPrefix,
	findCommonSuffix,
	InlineMyersSequenceMatcher,
	MyersSequenceMatcher,
	SyncPointMyersSequenceMatcher,
} from "../src/matchers/myers.ts";

// Returns a matcher over string line arrays (the production use-case).
function lineMatcher(a: string[], b: string[]) {
	return new MyersSequenceMatcher(null, a, b);
}

// ─── opcode fixture matrix ────────────────────────────────────────────────────
// Each case asserts the *exact* opcode sequence for a small known input.
// These kill boundary/index mutants that "does not throw" fuzz tests miss.

describe("MyersSequenceMatcher getOpcodes line arrays", () => {
	it("identical files produce a single equal opcode", () => {
		const lines = ["a", "b", "c"];
		expect(lineMatcher(lines, lines).getOpcodes()).toEqual([
			{ tag: "equal", startA: 0, endA: 3, startB: 0, endB: 3 },
		]);
	});

	it("insert at start", () => {
		expect(lineMatcher(["b", "c"], ["a", "b", "c"]).getOpcodes()).toEqual([
			{ tag: "insert", startA: 0, endA: 0, startB: 0, endB: 1 },
			{ tag: "equal", startA: 0, endA: 2, startB: 1, endB: 3 },
		]);
	});

	it("insert at end", () => {
		expect(lineMatcher(["a", "b"], ["a", "b", "c"]).getOpcodes()).toEqual([
			{ tag: "equal", startA: 0, endA: 2, startB: 0, endB: 2 },
			{ tag: "insert", startA: 2, endA: 2, startB: 2, endB: 3 },
		]);
	});

	it("insert in middle", () => {
		expect(lineMatcher(["a", "c"], ["a", "b", "c"]).getOpcodes()).toEqual([
			{ tag: "equal", startA: 0, endA: 1, startB: 0, endB: 1 },
			{ tag: "insert", startA: 1, endA: 1, startB: 1, endB: 2 },
			{ tag: "equal", startA: 1, endA: 2, startB: 2, endB: 3 },
		]);
	});

	it("delete at start", () => {
		expect(lineMatcher(["a", "b", "c"], ["b", "c"]).getOpcodes()).toEqual([
			{ tag: "delete", startA: 0, endA: 1, startB: 0, endB: 0 },
			{ tag: "equal", startA: 1, endA: 3, startB: 0, endB: 2 },
		]);
	});

	it("delete at end", () => {
		expect(lineMatcher(["a", "b", "c"], ["a", "b"]).getOpcodes()).toEqual([
			{ tag: "equal", startA: 0, endA: 2, startB: 0, endB: 2 },
			{ tag: "delete", startA: 2, endA: 3, startB: 2, endB: 2 },
		]);
	});

	it("delete in middle", () => {
		expect(lineMatcher(["a", "b", "c"], ["a", "c"]).getOpcodes()).toEqual([
			{ tag: "equal", startA: 0, endA: 1, startB: 0, endB: 1 },
			{ tag: "delete", startA: 1, endA: 2, startB: 1, endB: 1 },
			{ tag: "equal", startA: 2, endA: 3, startB: 1, endB: 2 },
		]);
	});

	it("replace same line count", () => {
		expect(
			lineMatcher(["a", "b", "c"], ["a", "X", "c"]).getOpcodes(),
		).toEqual([
			{ tag: "equal", startA: 0, endA: 1, startB: 0, endB: 1 },
			{ tag: "replace", startA: 1, endA: 2, startB: 1, endB: 2 },
			{ tag: "equal", startA: 2, endA: 3, startB: 2, endB: 3 },
		]);
	});

	it("replace with fewer lines", () => {
		expect(
			lineMatcher(["a", "b", "c", "d"], ["a", "X", "d"]).getOpcodes(),
		).toEqual([
			{ tag: "equal", startA: 0, endA: 1, startB: 0, endB: 1 },
			{ tag: "replace", startA: 1, endA: 3, startB: 1, endB: 2 },
			{ tag: "equal", startA: 3, endA: 4, startB: 2, endB: 3 },
		]);
	});

	it("replace with more lines", () => {
		expect(
			lineMatcher(["a", "b", "c"], ["a", "X", "Y", "c"]).getOpcodes(),
		).toEqual([
			{ tag: "equal", startA: 0, endA: 1, startB: 0, endB: 1 },
			{ tag: "replace", startA: 1, endA: 2, startB: 1, endB: 3 },
			{ tag: "equal", startA: 2, endA: 3, startB: 3, endB: 4 },
		]);
	});

	it("delete all lines", () => {
		expect(lineMatcher(["a", "b", "c"], []).getOpcodes()).toEqual([
			{ tag: "delete", startA: 0, endA: 3, startB: 0, endB: 0 },
		]);
	});

	it("empty a with non-empty b (pure insert)", () => {
		expect(lineMatcher([], ["a", "b"]).getOpcodes()).toEqual([
			{ tag: "insert", startA: 0, endA: 0, startB: 0, endB: 2 },
		]);
	});

	it("getDifferenceOpcodes omits equal chunks", () => {
		const opcodes = lineMatcher(
			["a", "b", "c"],
			["a", "X", "c"],
		).getDifferenceOpcodes();
		expect(opcodes.every((c) => c.tag !== "equal")).toBe(true);
		expect(opcodes).toHaveLength(1);
		expect(opcodes[0]).toEqual({
			tag: "replace",
			startA: 1,
			endA: 2,
			startB: 1,
			endB: 2,
		});
	});

	it("repeated equal lines around a change produce correct boundaries", () => {
		// Ensures equal-block index arithmetic is correct across repeats.
		const a = ["x", "x", "A", "x", "x"];
		const b = ["x", "x", "B", "x", "x"];
		const ops = lineMatcher(a, b).getOpcodes();
		expect(ops[0]).toEqual({
			tag: "equal",
			startA: 0,
			endA: 2,
			startB: 0,
			endB: 2,
		});
		expect(ops[1]).toEqual({
			tag: "replace",
			startA: 2,
			endA: 3,
			startB: 2,
			endB: 3,
		});
		expect(ops[2]).toEqual({
			tag: "equal",
			startA: 3,
			endA: 5,
			startB: 3,
			endB: 5,
		});
	});
});

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
