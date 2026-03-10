import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import type { editor } from "monaco-editor";
import { DiffCurtain } from "./DiffCurtain.tsx";
import { getBounds } from "./diffCurtainUtils.ts";
import { mapLineAcrossPanes } from "./scrollMapping.ts";
import type { DiffChunk } from "./types.ts";

// Mock ResizeObserver which is not present in jsdom
global.ResizeObserver = class ResizeObserver {
	observe() {
		/* mock */
	}
	unobserve() {
		/* mock */
	}
	disconnect() {
		/* mock */
	}
};

// Mock Monaco Editor
const mockEditor = (lineCount: number, scrollTop: number) =>
	({
		getScrollTop: jest.fn(() => scrollTop),
		getContainerDomNode: jest.fn(() => ({
			getBoundingClientRect: jest.fn(() => ({
				top: 0,
				left: 0,
				width: 100,
				height: 1000,
			})),
		})),
		getModel: jest.fn(() => ({
			getLineCount: jest.fn(() => lineCount),
		})),
		getTopForLineNumber: jest.fn((l: number) => (l - 1) * 20),
		getOption: jest.fn(() => 20),
		onDidScrollChange: jest.fn(() => ({
			dispose: jest.fn(),
		})),
		getLayoutInfo: jest.fn(() => ({ height: 1000 })),
		getContentHeight: jest.fn(() => lineCount * 20),
	}) as unknown as editor.IStandaloneCodeEditor;

const OUT_OF_BOUNDS_ERROR = /DiffCurtain connection out of bounds/;

describe("Connection Directions and Bounds Checking", () => {
	const diffs: (DiffChunk[] | null)[] = [
		null,
		null,
		null,
		[
			{ tag: "replace", startA: 23, endA: 24, startB: 23, endB: 26 },
			{ tag: "insert", startA: 40, endA: 40, startB: 42, endB: 43 },
			{ tag: "replace", startA: 56, endA: 58, startB: 59, endB: 61 },
			{ tag: "replace", startA: 65, endA: 66, startB: 68, endB: 69 },
			{ tag: "insert", startA: 109, endA: 109, startB: 112, endB: 113 },
			{ tag: "insert", startA: 128, endA: 128, startB: 132, endB: 141 },
			{ tag: "insert", startA: 131, endA: 131, startB: 144, endB: 148 },
			{ tag: "insert", startA: 138, endA: 138, startB: 155, endB: 159 },
			{ tag: "replace", startA: 142, endA: 143, startB: 163, endB: 167 },
			{ tag: "replace", startA: 165, endA: 175, startB: 189, endB: 190 },
			{ tag: "insert", startA: 190, endA: 190, startB: 205, endB: 387 },
		],
	];
	const paneLineCounts = [1, 386, 388, 191, 388];

	describe("getBounds Unit Test", () => {
		it("should NOT throw when mapping lines with correct reversal (false)", () => {
			const curtain3Diffs = diffs[3];
			if (!curtain3Diffs) {
				throw new Error("TestData missing");
			}
			const chunk = curtain3Diffs[10];
			if (!chunk) {
				throw new Error("TestData missing");
			}
			expect(() => {
				getBounds({
					startA: chunk.startA,
					endA: chunk.endA,
					startB: chunk.startB,
					endB: chunk.endB,
					lMax: 191, // Remote
					rMax: 388, // BaseRight
					reversed: false, // CORRECT for this curtain
				});
			}).not.toThrow();
		});

		it("should still throw when mapping lines with INCORRECT reversal (true) to verify guards", () => {
			const curtain3Diffs = diffs[3];
			if (!curtain3Diffs) {
				throw new Error("TestData missing");
			}
			const chunk = curtain3Diffs[10];
			if (!chunk) {
				throw new Error("TestData missing");
			}
			expect(() => {
				getBounds({
					startA: chunk.startA,
					endA: chunk.endA,
					startB: chunk.startB,
					endB: chunk.endB,
					lMax: 191,
					rMax: 388,
					reversed: true, // INCORRECT
				});
			}).toThrow(OUT_OF_BOUNDS_ERROR);
		});
	});

	describe("DiffCurtain E2E React Test", () => {
		// Mock console.error to avoid React error logging noise during expected throws
		beforeAll(() => {
			jest.spyOn(console, "error").mockImplementation(() => {
				/* mock */
			});
		});
		afterAll(() => {
			(console.error as unknown as jest.SpyInstance).mockRestore();
		});

		it("should NOT throw during rendering when reversed=false for the 4th curtain", () => {
			const leftEditor = mockEditor(191, 0);
			const rightEditor = mockEditor(388, 0);

			expect(() => {
				render(
					<DiffCurtain
						diffs={diffs[3] ?? []}
						leftEditor={leftEditor}
						rightEditor={rightEditor}
						renderTrigger={0}
						reversed={false} // THIS IS THE FIX WE ARE PREPARING
					/>,
				);
			}).not.toThrow();
		});
	});

	describe("mapLineAcrossPanes Verification", () => {
		it("should work correctly with correct reversal flags (already fixed in scrollMapping)", () => {
			const diffIsReversed = [false, true, false, false];
			const result = mapLineAcrossPanes(
				190, // last line of Remote
				3, // Remote
				4, // BaseR
				diffs,
				paneLineCounts,
				true,
				diffIsReversed,
			);
			expect(result).toBeLessThanOrEqual(388);
			expect(result).toBeGreaterThan(200);
		});
	});
});
