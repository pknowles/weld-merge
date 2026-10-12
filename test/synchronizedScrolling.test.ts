import { describe, expect, it } from "@jest/globals";
import {
	getSourceLineDecimal,
	getSyncPointY,
} from "../src/webview/ui/useSynchronizedScrolling.ts";

jest.mock("monaco-editor", () => {
	// EditorOption.lineHeight (49) is the enum value getOption() receives.
	// Object.defineProperty avoids biome's naming-convention lint on PascalCase keys.
	const editorMock: Record<string, unknown> = {};
	Object.defineProperty(editorMock, "EditorOption", {
		value: { lineHeight: 49 },
	});
	return { editor: editorMock };
});

// Fake Monaco editor whose line tops are uniformly spaced by lineHeight.
function makeEditor(lineCount: number, lineHeight = 20, scrollTop = 0) {
	return {
		getModel: () => ({ getLineCount: () => lineCount }),
		getTopForLineNumber: (line: number) => (line - 1) * lineHeight,
		getOption: () => lineHeight,
		getScrollTop: () => scrollTop,
	};
}

// ─── getSyncPointY ────────────────────────────────────────────────────────────
// syncpoint formula:
//   halfPage = pageSize / 2
//   firstScale  = clamp01(scrollTop / halfPage)         → top half
//   lastScale   = clamp01((scrollTop - bottomVal) / halfPage) → bottom half
//   syncpoint = 0.5 * firstScale + 0.5 * lastScale
//   syncY = scrollTop + pageSize * syncpoint

describe("getSyncPointY", () => {
	it("scrollTop=0 → syncpoint=0, syncY=0", () => {
		const { syncpoint, syncY } = getSyncPointY(0, 400, 2000);
		expect(syncpoint).toBe(0);
		expect(syncY).toBe(0);
	});

	it("scrollTop at half-page → syncpoint=0.5, syncY = scrollTop + pageSize*0.5", () => {
		// halfPage=200, firstScale reaches 1 when scrollTop=200
		const { syncpoint, syncY } = getSyncPointY(200, 400, 2000);
		expect(syncpoint).toBe(0.5);
		expect(syncY).toBe(200 + 400 * 0.5);
	});

	it("scrollTop at bottom boundary → syncpoint=1, syncY = scrollTop + pageSize", () => {
		// bottomVal = scrollHeight - 1.5*pageSize = 2000 - 600 = 1400
		// lastScale reaches 1 when scrollTop = bottomVal + halfPage = 1600
		const { syncpoint, syncY } = getSyncPointY(1600, 400, 2000);
		expect(syncpoint).toBe(1);
		expect(syncY).toBe(1600 + 400 * 1);
	});

	it("syncpoint is clamped to [0, 1]", () => {
		const { syncpoint: sp0 } = getSyncPointY(0, 400, 2000);
		const { syncpoint: sp1 } = getSyncPointY(9999, 400, 2000);
		expect(sp0).toBeGreaterThanOrEqual(0);
		expect(sp1).toBeLessThanOrEqual(1);
	});

	it("syncpoint increases monotonically with scrollTop", () => {
		const pageSize = 400;
		const scrollHeight = 2000;
		let prev = -1;
		for (let s = 0; s <= 1800; s += 100) {
			const { syncpoint } = getSyncPointY(s, pageSize, scrollHeight);
			expect(syncpoint).toBeGreaterThanOrEqual(prev);
			prev = syncpoint;
		}
	});

	it("small page (pageSize < scrollHeight): syncpoint reaches 1 before scroll end", () => {
		// halfPage=50, bottomVal=0, lastScale saturates quickly
		const { syncpoint } = getSyncPointY(200, 100, 200);
		expect(syncpoint).toBe(1);
	});
});

// ─── getSourceLineDecimal ─────────────────────────────────────────────────────
// Binary search finds the last line whose top ≤ syncY.
// Fractional part = (syncY - lineTop) / lineHeight.

describe("getSourceLineDecimal", () => {
	it("syncY=0 → line 0.0 (first line, no fraction)", () => {
		const ed = makeEditor(10, 20);
		expect(getSourceLineDecimal(ed as never, 0)).toBe(0);
	});

	it("syncY exactly at start of line 3 (top=40) → 2.0", () => {
		// line 3 (1-based) has top (3-1)*20 = 40
		const ed = makeEditor(10, 20);
		expect(getSourceLineDecimal(ed as never, 40)).toBe(2);
	});

	it("syncY midway through line 1 (top=0, height=20, syncY=10) → 0.5", () => {
		const ed = makeEditor(10, 20);
		expect(getSourceLineDecimal(ed as never, 10)).toBe(0.5);
	});

	it("syncY midway through line 3 (top=40, height=20, syncY=50) → 2.5", () => {
		const ed = makeEditor(10, 20);
		expect(getSourceLineDecimal(ed as never, 50)).toBe(2.5);
	});

	it("syncY past last line → clamps to last line with fraction", () => {
		// 5 lines, height=20. Last line top = 80. syncY=95 → fraction=(95-80)/20=0.75
		const ed = makeEditor(5, 20);
		const result = getSourceLineDecimal(ed as never, 95);
		expect(result).toBeGreaterThanOrEqual(4);
		expect(result).toBeLessThanOrEqual(5);
	});

	it("result increases monotonically with syncY", () => {
		const ed = makeEditor(10, 20);
		let prev = -1;
		for (let y = 0; y <= 180; y += 5) {
			const r = getSourceLineDecimal(ed as never, y);
			expect(r).toBeGreaterThanOrEqual(prev);
			prev = r;
		}
	});

	it("single-line document: always returns fraction of line 0", () => {
		const ed = makeEditor(1, 20);
		expect(getSourceLineDecimal(ed as never, 0)).toBe(0);
		expect(getSourceLineDecimal(ed as never, 10)).toBe(0.5);
	});

	it("variable line heights: uses actual pixel tops, not uniform spacing", () => {
		// Lines 1-5 with heights [10, 30, 10, 30, 10]
		const tops = [0, 10, 40, 50, 80, 90];
		const ed = {
			getModel: () => ({ getLineCount: () => 5 }),
			getTopForLineNumber: (line: number) =>
				tops[line - 1] ?? tops.at(-1) ?? 0,
			getOption: () => 20,
		};
		// syncY=25 is inside line 2 (top=10, next=40, height=30): fraction=(25-10)/30=0.5
		expect(getSourceLineDecimal(ed as never, 25)).toBeCloseTo(1.5);
	});
});
