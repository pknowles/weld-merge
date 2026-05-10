import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "@jest/globals";
import { Differ } from "../src/matchers/diffutil.ts";
import { getPaneHighlights } from "../src/webview/ui/highlightUtil.ts";
import type { DiffChunk, FileState } from "../src/webview/ui/types.ts";

const f = (content: string): FileState => ({ label: "", content });

const chunk = (
	tag: DiffChunk["tag"],
	startA: number,
	endA: number,
	startB: number,
	endB: number,
): DiffChunk => ({ tag, startA, endA, startB, endB });

const parseMeldTestCases = (): [string[], string[], string[]][] => {
	const raw = readFileSync(
		join(process.cwd(), "test/test_cases.txt"),
		"utf-8",
	);
	return raw
		.trim()
		.split("---")
		.filter((s) => s.trim() !== "")
		.map((c) => {
			const parts = c.trim().split("===");
			const extract = (p: string | undefined) =>
				(p ?? "")
					.trim()
					.split("\n")
					.filter((l) => l !== "");
			return [
				extract(parts[0]),
				extract(parts[1]),
				extract(parts[2]),
			] as [string[], string[], string[]];
		});
};

describe("getPaneHighlights: equal chunks produce no highlights", () => {
	it("pane 0: all-equal diff", () => {
		const files = [f("a\nb\nc"), f("a\nb\nc")];
		const diffs = [[chunk("equal", 0, 3, 0, 3)], null];
		expect(getPaneHighlights(0, files, diffs, false, false)).toEqual([]);
	});

	it("pane 1: all-equal diff", () => {
		const files = [f("a"), f("a"), f("a")];
		const diffs = [
			[chunk("equal", 0, 1, 0, 1)],
			[chunk("equal", 0, 1, 0, 1)],
		];
		expect(getPaneHighlights(1, files, diffs, false, false)).toEqual([]);
	});
});

describe("getPaneHighlights: delete chunks produce whole-line highlights", () => {
	it("pane 0: delete on first line", () => {
		const files = [f("a\nb\nc"), f("b\nc")];
		const diffs = [[chunk("delete", 0, 1, 0, 0)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		expect(h).toHaveLength(1);
		expect(h[0]).toMatchObject({
			startLine: 1,
			endLine: 1,
			isWholeLine: true,
			tag: "delete",
		});
	});

	it("pane 0: delete on third line", () => {
		const files = [f("a\nb\nc"), f("a\nb")];
		const diffs = [[chunk("delete", 2, 3, 2, 2)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		expect(h).toHaveLength(1);
		expect(h[0]).toMatchObject({ startLine: 3, endLine: 3 });
	});

	it("pane 0: delete of two consecutive lines", () => {
		const files = [f("a\nb\nc\nd"), f("a\nd")];
		const diffs = [[chunk("delete", 1, 3, 1, 1)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		const whole = h.filter((x) => x.isWholeLine);
		expect(whole).toHaveLength(1);
		expect(whole[0]).toMatchObject({ startLine: 2, endLine: 3 });
	});
});

describe("getPaneHighlights: replace chunks produce whole-line highlights", () => {
	it("pane 0: replace on first line", () => {
		const files = [f("hello\nworld"), f("goodbye\nworld")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		const whole = h.filter((x) => x.isWholeLine);
		expect(whole).toHaveLength(1);
		expect(whole[0]).toMatchObject({
			startLine: 1,
			endLine: 1,
			isWholeLine: true,
			tag: "replace",
		});
	});

	it("pane 0: replace on third line", () => {
		const files = [f("a\nb\nX\nd"), f("a\nb\nY\nd")];
		const diffs = [[chunk("replace", 2, 3, 2, 3)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		const whole = h.filter((x) => x.isWholeLine);
		expect(whole[0]).toMatchObject({ startLine: 3, endLine: 3 });
	});
});

describe("getPaneHighlights: replace chunks produce character-level sub-highlights", () => {
	it("pane 0: single character difference produces a sub-highlight in the right position", () => {
		const files = [f("abc"), f("axc")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		const sub = h.filter((x) => !x.isWholeLine);
		expect(sub).toHaveLength(1);
		expect(sub[0]).toMatchObject({
			startLine: 1,
			startColumn: 2,
			endLine: 1,
			endColumn: 3,
			isWholeLine: false,
			tag: "replace",
		});
	});

	it("pane 0: identical content produces no sub-highlights", () => {
		const files = [f("same"), f("same")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		expect(h.filter((x) => !x.isWholeLine)).toHaveLength(0);
	});

	it("pane 0: sub-highlights stay within the whole-line highlight bounds", () => {
		const files = [f("line0\nABCDE\nline2"), f("line0\nAXCYE\nline2")];
		const diffs = [[chunk("replace", 1, 2, 1, 2)], null];
		const h = getPaneHighlights(0, files, diffs, false, false);
		const whole = h.find((x) => x.isWholeLine);
		const sub = h.filter((x) => !x.isWholeLine);
		expect(whole).toBeDefined();
		if (whole) {
			for (const s of sub) {
				expect(s.startLine).toBeGreaterThanOrEqual(whole.startLine);
				expect(s.endLine).toBeLessThanOrEqual(whole.endLine);
			}
		}
	});
});

describe("getPaneHighlights: pane 1 uses the correct diff based on isLBC", () => {
	it("isLBC=false uses diffs[1] (right diff)", () => {
		const files = [f("a"), f("X"), f("a")];
		const diffs = [[], [chunk("replace", 0, 1, 0, 1)]];
		const h = getPaneHighlights(1, files, diffs, false, false);
		expect(h.some((x) => x.isWholeLine && x.tag === "replace")).toBe(true);
	});

	it("isLBC=false ignores diffs[0]", () => {
		const files = [f("X"), f("a"), f("a")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], []];
		expect(getPaneHighlights(1, files, diffs, false, false)).toHaveLength(
			0,
		);
	});

	it("isLBC=true uses diffs[0] (left diff)", () => {
		const files = [f("X"), f("a"), f("a")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], []];
		const h = getPaneHighlights(1, files, diffs, true, false);
		expect(h.some((x) => x.isWholeLine && x.tag === "replace")).toBe(true);
	});

	it("isLBC=true ignores diffs[1]", () => {
		const files = [f("a"), f("a"), f("X")];
		const diffs = [[], [chunk("replace", 0, 1, 0, 1)]];
		expect(getPaneHighlights(1, files, diffs, true, false)).toHaveLength(0);
	});
});

describe("getPaneHighlights: all coordinates are valid", () => {
	it("no NaN in any coordinate", () => {
		const files = [f("a\nb\nc"), f("x\ny\nz")];
		const diffs = [[chunk("replace", 0, 3, 0, 3)], null];
		for (const hl of getPaneHighlights(0, files, diffs, false, false)) {
			expect(Number.isNaN(hl.startLine)).toBe(false);
			expect(Number.isNaN(hl.endLine)).toBe(false);
			expect(Number.isNaN(hl.startColumn)).toBe(false);
			expect(Number.isNaN(hl.endColumn)).toBe(false);
		}
	});

	it("startLine is always >= 1 (1-indexed)", () => {
		const files = [f("a\nb\nc"), f("x\ny\nz")];
		const diffs = [[chunk("replace", 0, 3, 0, 3)], null];
		for (const hl of getPaneHighlights(0, files, diffs, false, false)) {
			expect(hl.startLine).toBeGreaterThanOrEqual(1);
		}
	});

	it("startColumn is always >= 1", () => {
		const files = [f("hello world"), f("hello earth")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], null];
		for (const hl of getPaneHighlights(0, files, diffs, false, false)) {
			expect(hl.startColumn).toBeGreaterThanOrEqual(1);
		}
	});
});

describe("getPaneHighlights: trailing newlines in file content", () => {
	it("produces the same highlights with or without trailing newline", () => {
		const withNewline = [f("abc\n"), f("axc\n")];
		const withoutNewline = [f("abc"), f("axc")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], null];
		expect(getPaneHighlights(0, withNewline, diffs, false, false)).toEqual(
			getPaneHighlights(0, withoutNewline, diffs, false, false),
		);
	});

	it("sub-highlight column positions are correct when content ends with newline", () => {
		const files = [f("abc\n"), f("axc\n")];
		const diffs = [[chunk("replace", 0, 1, 0, 1)], null];
		const sub = getPaneHighlights(0, files, diffs, false, false).filter(
			(x) => !x.isWholeLine,
		);
		expect(sub).toHaveLength(1);
		expect(sub[0]).toMatchObject({
			startLine: 1,
			startColumn: 2,
			endLine: 1,
			endColumn: 3,
		});
	});
});

describe("getPaneHighlights: validity across all test_cases.txt Meld inputs", () => {
	it("no NaN and no out-of-bounds coordinates for any case", () => {
		const differ = new Differ();
		for (const [local, base, remote] of parseMeldTestCases()) {
			differ.setSequences([local, base, remote]);
			const files = [local, base, remote].map((lines, i) => ({
				label: ["local", "base", "remote"][i] ?? "",
				content: lines.join("\n"),
			}));
			for (let p = 0; p < 3; p++) {
				for (const hl of getPaneHighlights(
					p,
					files,
					differ.diffs,
					false,
					false,
				)) {
					expect(Number.isNaN(hl.startLine)).toBe(false);
					expect(Number.isNaN(hl.endLine)).toBe(false);
					expect(hl.startLine).toBeGreaterThanOrEqual(1);
					expect(hl.startColumn).toBeGreaterThanOrEqual(1);
				}
			}
		}
	});
});

describe("getPaneHighlights: modify+restore on Meld test cases restores initial highlights", () => {
	const toFiles = (local: string[], base: string[], remote: string[]) =>
		[local, base, remote].map((lines, i) => ({
			label: ["local", "base", "remote"][i] ?? "",
			content: lines.join("\n"),
		}));

	it("replace first base line then restore: highlights match initial", () => {
		for (const [local, base, remote] of parseMeldTestCases()) {
			if (base.length === 0) {
				continue;
			}
			const initialD = new Differ();
			initialD.setSequences([local, base, remote]);
			const initialH = [0, 1, 2].map((p) =>
				getPaneHighlights(
					p,
					toFiles(local, base, remote),
					initialD.diffs,
					false,
					false,
				),
			);
			const incr = new Differ();
			incr.setSequences([local, base, remote]);
			const edited = ["SENTINEL_ROUNDTRIP", ...base.slice(1)];
			incr.changeSequence(1, 0, 0, [local, edited, remote]);
			incr.changeSequence(1, 0, 0, [local, base, remote]);
			const afterH = [0, 1, 2].map((p) =>
				getPaneHighlights(
					p,
					toFiles(local, base, remote),
					incr.diffs,
					false,
					false,
				),
			);
			expect(afterH).toEqual(initialH);
		}
	});

	it("delete first base line then restore: highlights match initial", () => {
		for (const [local, base, remote] of parseMeldTestCases()) {
			if (base.length < 2) {
				continue;
			}
			const initialD = new Differ();
			initialD.setSequences([local, base, remote]);
			const initialH = [0, 1, 2].map((p) =>
				getPaneHighlights(
					p,
					toFiles(local, base, remote),
					initialD.diffs,
					false,
					false,
				),
			);
			const incr = new Differ();
			incr.setSequences([local, base, remote]);
			incr.changeSequence(1, 0, -1, [local, base.slice(1), remote]);
			incr.changeSequence(1, 0, 1, [local, base, remote]);
			const afterH = [0, 1, 2].map((p) =>
				getPaneHighlights(
					p,
					toFiles(local, base, remote),
					incr.diffs,
					false,
					false,
				),
			);
			expect(afterH).toEqual(initialH);
		}
	});
});
