import { describe, expect, it, jest } from "@jest/globals";
import {
	applyMeldStyleContentChanges,
	contentChangeForFullReplacementFromLines,
} from "../src/webview/ui/mergedPaneEdits.ts";
import type { MonacoContentChange } from "../src/webview/ui/types.ts";

// Minimal Differ stub — only changeSequence is called by applyMeldStyleContentChanges.
function makeDiffer() {
	return { changeSequence: jest.fn<() => void>() };
}

function change(
	startLine: number,
	startCol: number,
	endLine: number,
	endCol: number,
	text: string,
): MonacoContentChange {
	return {
		range: {
			startLineNumber: startLine,
			startColumn: startCol,
			endLineNumber: endLine,
			endColumn: endCol,
		},
		text,
	};
}

// ─── contentChangeForFullReplacementFromLines ─────────────────────────────────

describe("contentChangeForFullReplacementFromLines", () => {
	it("covers the entire document — starts at (1,1) and ends at last line", () => {
		const old = ["alpha", "beta", "gamma"];
		const result = contentChangeForFullReplacementFromLines(
			old,
			"new content",
		);
		expect(result.range.startLineNumber).toBe(1);
		expect(result.range.startColumn).toBe(1);
		expect(result.range.endLineNumber).toBe(3);
	});

	it("endColumn is last-line length + 1 (past end of final line)", () => {
		const old = ["hello", "world"];
		const result = contentChangeForFullReplacementFromLines(old, "x");
		// "world" has length 5, so endColumn should be 6
		expect(result.range.endColumn).toBe(6);
	});

	it("carries the new content as the replacement text", () => {
		const result = contentChangeForFullReplacementFromLines(
			["a"],
			"replaced",
		);
		expect(result.text).toBe("replaced");
	});

	it("single line: endLine equals startLine (1)", () => {
		const result = contentChangeForFullReplacementFromLines(["only"], "x");
		expect(result.range.endLineNumber).toBe(1);
	});

	it("throws for an empty lines array", () => {
		expect(() =>
			contentChangeForFullReplacementFromLines([], "x"),
		).toThrow();
	});
});

// ─── applyMeldStyleContentChanges ────────────────────────────────────────────

describe("applyMeldStyleContentChanges / single edit", () => {
	it("replaces a mid-line range with new text", () => {
		const merged = ["hello world"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 7, 1, 12, "earth")],
		);
		expect(merged).toEqual(["hello earth"]);
	});

	it("inserts text at cursor position (empty range)", () => {
		const merged = ["ac"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 2, 1, 2, "b")],
		);
		expect(merged).toEqual(["abc"]);
	});

	it("deletes a range by replacing with empty string", () => {
		const merged = ["abcde"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 2, 1, 4, "")],
		);
		expect(merged).toEqual(["ade"]);
	});

	it("replaces across two lines merging them", () => {
		const merged = ["first", "second"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 6, 2, 1, " and ")],
		);
		expect(merged).toEqual(["first and second"]);
	});

	it("splits one line into two by inserting a newline", () => {
		const merged = ["ab"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 2, 1, 2, "\n")],
		);
		expect(merged).toEqual(["a", "b"]);
	});

	it("calls differ.changeSequence for the delete part of a replace", () => {
		const merged = ["old"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 1, 1, 4, "new")],
		);
		// delete step: -0 lines (same-line replace), then insert step: +0 lines
		expect(d.changeSequence).toHaveBeenCalled();
	});

	it("does not call changeSequence for the delete when range is empty", () => {
		const merged = ["x"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 2, 1, 2, "y")],
		);
		// empty range → only insert call
		const calls = d.changeSequence.mock.calls;
		// All calls should be for inserts (sizeChange >= 0)
		for (const callArgs of calls as unknown as [
			unknown,
			unknown,
			number,
		][]) {
			expect(callArgs[2]).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("applyMeldStyleContentChanges / multiple edits", () => {
	it("applies changes in descending position order to avoid index drift", () => {
		// Two replacements on the same line: col 1-2 → "X", col 4-5 → "Y"
		// If applied in reverse order (descending), indices don't shift.
		const merged = ["abcde"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 1, 1, 2, "X"), change(1, 4, 1, 5, "Y")],
		);
		expect(merged).toEqual(["XbcYe"]);
	});

	it("applies multi-line edits preserving final line count", () => {
		const merged = ["line1", "line2", "line3"];
		const d = makeDiffer();
		applyMeldStyleContentChanges(
			d as never,
			[],
			merged,
			[],
			[change(1, 1, 1, 6, "ONE"), change(3, 1, 3, 6, "THREE")],
		);
		expect(merged).toEqual(["ONE", "line2", "THREE"]);
	});
});

describe("applyMeldStyleContentChanges / error cases", () => {
	it("throws when startLine is out of bounds", () => {
		const merged = ["only line"];
		const d = makeDiffer();
		expect(() =>
			applyMeldStyleContentChanges(
				d as never,
				[],
				merged,
				[],
				[change(5, 1, 5, 1, "x")],
			),
		).toThrow();
	});

	it("throws when startColumn exceeds line length", () => {
		const merged = ["short"];
		const d = makeDiffer();
		expect(() =>
			applyMeldStyleContentChanges(
				d as never,
				[],
				merged,
				[],
				[change(1, 99, 1, 99, "x")],
			),
		).toThrow();
	});
});
