import { createMockEditor } from "./mockEditor.ts";

describe("MockEditor - core", () => {
	describe("value sync", () => {
		it("should return the correct initial value", () => {
			const editor = createMockEditor("hello\nworld");
			expect(editor.getValue()).toBe("hello\nworld");
			expect(editor.getModel().getValue()).toBe("hello\nworld");
		});

		it("should update value on setValue", () => {
			const editor = createMockEditor("hello\nworld");
			editor.setValue("new\nvalue");
			expect(editor.getValue()).toBe("new\nvalue");
			expect(editor.getModel().getValue()).toBe("new\nvalue");
		});
	});

	describe("getPositionAt", () => {
		it("should convert offset to position correctly", () => {
			const editor = createMockEditor("ab\ncd");
			const model = editor.getModel();

			expect(model.getPositionAt(0)).toEqual({
				lineNumber: 1,
				column: 1,
			});
			expect(model.getPositionAt(1)).toEqual({
				lineNumber: 1,
				column: 2,
			});
			expect(model.getPositionAt(2)).toEqual({
				lineNumber: 1,
				column: 3,
			}); // Before \n
			expect(model.getPositionAt(3)).toEqual({
				lineNumber: 2,
				column: 1,
			}); // After \n
			expect(model.getPositionAt(4)).toEqual({
				lineNumber: 2,
				column: 2,
			});
			expect(model.getPositionAt(5)).toEqual({
				lineNumber: 2,
				column: 3,
			}); // EOF
		});

		it("should clamp out-of-bounds offsets to EOF", () => {
			const editor = createMockEditor("ab\ncd");
			const model = editor.getModel();

			expect(model.getPositionAt(100)).toEqual({
				lineNumber: 2,
				column: 3,
			});
		});
	});
});

describe("MockEditor - complex edits", () => {
	it("should apply single line replacements", () => {
		const editor = createMockEditor("hello\nworld");
		const model = editor.getModel();

		model.pushEditOperations(
			[],
			[
				{
					range: {
						startLineNumber: 1,
						startColumn: 1,
						endLineNumber: 1,
						endColumn: 6,
					},
					text: "hi",
				},
			],
			() => [],
		);

		expect(editor.getValue()).toBe("hi\nworld");
	});

	it("should apply multi-line replacements", () => {
		const editor = createMockEditor("line 1\nline 2\nline 3");
		const model = editor.getModel();

		model.pushEditOperations(
			[],
			[
				{
					range: {
						startLineNumber: 1,
						startColumn: 6,
						endLineNumber: 3,
						endColumn: 5,
					},
					text: " changed\nfoo ",
				},
			],
			() => [],
		);

		// "line 1" -> "line " (start line prefix)
		// " changed\nfoo " (text)
		// " 3" (end line suffix)
		expect(editor.getValue()).toBe("line  changed\nfoo  3");
	});

	it("should apply multiple edits in order", () => {
		const editor = createMockEditor("a\nb\nc");
		const model = editor.getModel();

		// When edits are provided, pushEditOperations applies them.
		// In a real scenario they are typically non-overlapping or applied bottom-up or simultaneously.
		// Our mock applies them sequentially in order.
		// Let's test a simple top-to-bottom edit that might fail if not careful,
		// but for now we just verify the sequential apply works.
		model.pushEditOperations(
			[],
			[
				{
					range: {
						startLineNumber: 3,
						startColumn: 1,
						endLineNumber: 3,
						endColumn: 2,
					},
					text: "z",
				},
				{
					range: {
						startLineNumber: 1,
						startColumn: 1,
						endLineNumber: 1,
						endColumn: 2,
					},
					text: "x",
				},
			],
			() => [],
		);

		expect(editor.getValue()).toBe("x\nb\nz");
	});
});
