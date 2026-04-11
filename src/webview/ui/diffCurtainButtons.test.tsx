import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { editor } from "monaco-editor";
import { DiffCurtain } from "./DiffCurtain.tsx";
import type { DiffChunk } from "./types.ts";

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

const mockEditor = (lineCount: number) =>
	({
		getScrollTop: jest.fn(() => 0),
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
		getBottomForLineNumber: jest.fn((l: number) => l * 20),
		onDidScrollChange: jest.fn(() => ({
			dispose: jest.fn(),
		})),
		getLayoutInfo: jest.fn(() => ({ height: 1000 })),
		getContentHeight: jest.fn(() => lineCount * 20),
		getDomNode: jest.fn(() => null),
	}) as unknown as editor.IStandaloneCodeEditor;

describe("DiffCurtain Action Buttons Visibility - Basic Cases", () => {
	const leftEditor = mockEditor(500);
	const rightEditor = mockEditor(500);
	const leftModel = leftEditor.getModel() as editor.ITextModel;
	const rightModel = rightEditor.getModel() as editor.ITextModel;

	it("should hide Push arrow when source is empty (insert)", () => {
		const diffs: DiffChunk[] = [
			{ tag: "insert", startA: 10, endA: 10, startB: 10, endB: 12 },
		];
		render(
			<DiffCurtain
				diffs={diffs}
				leftEditor={leftEditor}
				rightEditor={rightEditor}
				leftModel={leftModel}
				rightModel={rightModel}
				renderTrigger={0}
				reversed={false} // Push is Right (B) -> Left (A) ? No, reversed=false means Left is A, Right is B.
				// Wait, if reversed=false, applySide is "right" (line 208).
				// If applySide is "right", Push icon is ⬅ and it's on the right side.
				// Source is Right (B), Dest is Left (A).
				onApplyChunk={() => {
					/* mock */
				}}
				onDeleteChunk={() => {
					/* mock */
				}}
			/>,
		);
		// With reversed=false:
		// applySide = "right"
		// source = Right (B), dest = Left (A)
		// insert: startA: 10, endA: 10 (A empty), startB: 10, endB: 12 (B not empty)
		// source (B) is not empty -> Push ⬅ VISIBLE
		// dest (A) is empty -> Delete HIDDEN
		expect(screen.getByTitle("Push")).toBeInTheDocument();
		expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
	});

	it("should hide Delete cross when destination is empty (delete)", () => {
		const diffs: DiffChunk[] = [
			{ tag: "delete", startA: 10, endA: 12, startB: 10, endB: 10 },
		];
		render(
			<DiffCurtain
				diffs={diffs}
				leftEditor={leftEditor}
				rightEditor={rightEditor}
				leftModel={leftModel}
				rightModel={rightModel}
				renderTrigger={0}
				reversed={false}
				onApplyChunk={() => {
					/* mock */
				}}
				onDeleteChunk={() => {
					/* mock */
				}}
			/>,
		);
		// With reversed=false:
		// applySide = "right"
		// source = Right (B), dest = Left (A)
		// delete: startA: 10, endA: 12 (A not empty), startB: 10, endB: 10 (B empty)
		// source (B) is empty -> Push HIDDEN
		// dest (A) is not empty -> Delete VISIBLE
		expect(screen.queryByTitle("Push")).not.toBeInTheDocument();
		expect(screen.getByTitle("Delete")).toBeInTheDocument();
	});
});

describe("DiffCurtain Action Buttons Visibility - Advanced Cases", () => {
	const leftEditor = mockEditor(500);
	const rightEditor = mockEditor(500);
	const leftModel = leftEditor.getModel() as editor.ITextModel;
	const rightModel = rightEditor.getModel() as editor.ITextModel;

	it("should show both buttons when neither side is empty (replace)", () => {
		const diffs: DiffChunk[] = [
			{ tag: "replace", startA: 10, endA: 12, startB: 10, endB: 12 },
		];
		render(
			<DiffCurtain
				diffs={diffs}
				leftEditor={leftEditor}
				rightEditor={rightEditor}
				leftModel={leftModel}
				rightModel={rightModel}
				renderTrigger={0}
				reversed={false}
				onApplyChunk={() => {
					/* mock */
				}}
				onDeleteChunk={() => {
					/* mock */
				}}
			/>,
		);
		expect(screen.getByTitle("Push")).toBeInTheDocument();
		expect(screen.getByTitle("Delete")).toBeInTheDocument();
	});

	it("should handle reversed case correctly (insert)", () => {
		const diffs: DiffChunk[] = [
			{ tag: "insert", startA: 10, endA: 10, startB: 10, endB: 12 },
		];
		render(
			<DiffCurtain
				diffs={diffs}
				leftEditor={leftEditor}
				rightEditor={rightEditor}
				leftModel={leftModel}
				rightModel={rightModel}
				renderTrigger={0}
				reversed={true}
				onApplyChunk={() => {
					/* mock */
				}}
				onDeleteChunk={() => {
					/* mock */
				}}
			/>,
		);
		// With reversed=true:
		// applySide = "left" (line 208)
		// left = B, right = A (getBounds)
		// source = Left (B), dest = Right (A)
		// insert: startA: 10, endA: 10 (A empty), startB: 10, endB: 12 (B not empty)
		// source (B) is not empty -> Push ➔ VISIBLE
		// dest (A) is empty -> Delete HIDDEN
		expect(screen.getByTitle("Push")).toBeInTheDocument();
		expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
	});
});
