import { describe, expect, it, jest } from "@jest/globals";
import type { editor } from "monaco-editor";
import {
	applyChunkEdit,
	copyDownChunk,
	copyUpChunk,
	deleteChunk,
	getChunkText,
} from "../src/webview/ui/editorActions.ts";
import type { DiffChunk } from "../src/webview/ui/types.ts";
import { createMockEditor } from "./mockEditor.ts";

function chunk(overrides: Partial<DiffChunk>): DiffChunk {
	return {
		tag: "replace",
		startA: 0,
		endA: 0,
		startB: 0,
		endB: 0,
		...overrides,
	};
}

function getModelFromEditor(content: string): editor.ITextModel & {
	getValue: () => string;
} {
	const ed = createMockEditor(
		content,
	) as unknown as editor.IStandaloneCodeEditor;
	return ed.getModel() as editor.ITextModel & { getValue: () => string };
}

// Returns the editor AND captures executeEdits calls for range assertions.
function makeEditorWithCapture(content: string) {
	const ed = createMockEditor(
		content,
	) as unknown as editor.IStandaloneCodeEditor & {
		getValue: () => string;
		executeEdits: ReturnType<typeof jest.fn>;
	};
	return ed;
}

describe("editorActions/getChunkText", () => {
	it("returns empty text for empty chunks", () => {
		const model = getModelFromEditor("A\nB\nC");

		const text = getChunkText(model, chunk({ startB: 2, endB: 2 }), 3);

		expect(text).toBe("");
	});

	it("extracts text using the non-EOF range path", () => {
		const model = getModelFromEditor("A\nB\nC\nD");

		const text = getChunkText(
			model,
			chunk({ startB: 1, endB: 3, startA: 1, endA: 3 }),
			4,
		);

		expect(text).toBe("B\nC\n");
	});

	it("extracts text at EOF and appends newline when target has trailing lines", () => {
		const model = getModelFromEditor("A\nB\nC");

		const text = getChunkText(
			model,
			chunk({ startB: 1, endB: 3, startA: 1, endA: 1 }),
			5,
		);

		expect(text).toBe("B\nC\n");
	});
});

describe("editorActions/applyChunkEdit", () => {
	it("returns when target editor has no model", () => {
		const executeEdits = jest.fn();
		const targetEditor = {
			getModel: () => null,
			executeEdits,
		} as unknown as editor.IStandaloneCodeEditor;

		applyChunkEdit(targetEditor, chunk({ startA: 0, endA: 1 }), "X");

		expect(executeEdits).not.toHaveBeenCalled();
	});

	it("replaces a middle region in the target editor", () => {
		const targetEditor = createMockEditor(
			"A\nB\nC\nD",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		applyChunkEdit(
			targetEditor,
			chunk({ startA: 1, endA: 2, startB: 0, endB: 1 }),
			"X\n",
		);

		expect(targetEditor.getValue()).toBe("A\nX\nC\nD");
	});

	it("appends with a leading newline when insertion starts after EOF", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		applyChunkEdit(
			targetEditor,
			chunk({ startA: 5, endA: 5, startB: 0, endB: 1 }),
			"Z",
		);

		expect(targetEditor.getValue()).toBe("A\nB\nZ");
	});

	it("replaces through the last line when endA reaches EOF", () => {
		const targetEditor = createMockEditor(
			"A\nB\nC",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		applyChunkEdit(
			targetEditor,
			chunk({ startA: 1, endA: 3, startB: 0, endB: 2 }),
			"X\nY",
		);

		expect(targetEditor.getValue()).toBe("A\nX\nY");
	});
});

describe("editorActions/deleteChunk", () => {
	it("returns when chunk is empty", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		deleteChunk(targetEditor, chunk({ startA: 2, endA: 2 }));

		expect(targetEditor.getValue()).toBe("A\nB");
	});

	it("deletes a middle line range", () => {
		const targetEditor = createMockEditor(
			"A\nB\nC\nD",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		deleteChunk(targetEditor, chunk({ startA: 1, endA: 2 }));

		expect(targetEditor.getValue()).toBe("A\nC\nD");
	});

	it("deletes through EOF including the preceding newline", () => {
		const targetEditor = createMockEditor(
			"A\nB\nC",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		deleteChunk(targetEditor, chunk({ startA: 1, endA: 3 }));

		expect(targetEditor.getValue()).toBe("A");
	});
});

describe("editorActions/copyUpChunk", () => {
	it("returns when there is no text to copy", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyUpChunk(targetEditor, chunk({ startA: 1, endA: 1 }), "");

		expect(targetEditor.getValue()).toBe("A\nB");
	});

	it("inserts copied text before the chunk location", () => {
		const targetEditor = createMockEditor(
			"A\nB\nC",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyUpChunk(targetEditor, chunk({ startA: 1, endA: 2 }), "X\n");

		expect(targetEditor.getValue()).toBe("A\nX\nB\nC");
	});

	it("inserts text before the first line", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyUpChunk(targetEditor, chunk({ startA: 0, endA: 0 }), "FIRST\n");

		expect(targetEditor.getValue()).toBe("FIRST\nA\nB");
	});

	it("does not duplicate leading newline when appending after EOF", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyUpChunk(targetEditor, chunk({ startA: 9, endA: 9 }), "\nTAIL");

		expect(targetEditor.getValue()).toBe("A\nB\nTAIL");
	});
});

describe("editorActions/copyDownChunk", () => {
	it("inserts copied text after the chunk location", () => {
		const targetEditor = createMockEditor(
			"A\nB\nC",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyDownChunk(targetEditor, chunk({ startA: 0, endA: 1 }), "X\n");

		expect(targetEditor.getValue()).toBe("A\nX\nB\nC");
	});

	it("appends copied text at EOF when insertion point is after file end", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyDownChunk(targetEditor, chunk({ startA: 0, endA: 6 }), "tail");

		expect(targetEditor.getValue()).toBe("A\nB\ntail");
	});

	it("does not duplicate leading newline when appending past EOF", () => {
		const targetEditor = createMockEditor(
			"A\nB",
		) as unknown as editor.IStandaloneCodeEditor & {
			getValue: () => string;
		};

		copyDownChunk(targetEditor, chunk({ startA: 0, endA: 8 }), "\ntail");

		expect(targetEditor.getValue()).toBe("A\nB\ntail");
	});
});

// ─── exact executeEdits range assertions ──────────────────────────────────────
// These kill off-by-one mutants (e.g. eL >= mMax vs eL > mMax) that content-
// only tests miss because adjacent lines happen to have the same result.

describe("editorActions/applyChunkEdit exact ranges", () => {
	it("mid-file replace: startLineNumber=startA+1, endLineNumber=endA+1, endColumn=1", () => {
		// "A\nB\nC\nD" — chunk covers line index 1 (line 2). endA=2 < mMax=4.
		// Expected: startLine=2, endLine=3, endCol=1.
		const ed = makeEditorWithCapture("A\nB\nC\nD");
		applyChunkEdit(ed, chunk({ startA: 1, endA: 2 }), "X\n");
		const call = (ed.executeEdits as ReturnType<typeof jest.fn>).mock
			.calls[0];
		const range = (
			call?.[1] as {
				range: {
					startLineNumber: number;
					startColumn: number;
					endLineNumber: number;
					endColumn: number;
				};
			}[]
		)[0]?.range;
		expect(range?.startLineNumber).toBe(2);
		expect(range?.startColumn).toBe(1);
		expect(range?.endLineNumber).toBe(3);
		expect(range?.endColumn).toBe(1);
	});

	it("replace through last line: endLineNumber=mMax, endColumn=lastLineMaxCol", () => {
		// "A\nB\nC" — chunk endA=3 === mMax=3. endCol should be column past "C".
		const ed = makeEditorWithCapture("A\nB\nC");
		applyChunkEdit(ed, chunk({ startA: 1, endA: 3 }), "X");
		const call = (ed.executeEdits as ReturnType<typeof jest.fn>).mock
			.calls[0];
		const range = (
			call?.[1] as {
				range: {
					startLineNumber: number;
					startColumn: number;
					endLineNumber: number;
					endColumn: number;
				};
			}[]
		)[0]?.range;
		expect(range?.endLineNumber).toBe(3);
		expect(range?.endColumn).toBeGreaterThan(1);
	});

	it("insert after EOF: range is at end of last line", () => {
		// startA > mMax → appends to last line.
		const ed = makeEditorWithCapture("A\nB");
		applyChunkEdit(ed, chunk({ startA: 5, endA: 5 }), "Z");
		const call = (ed.executeEdits as ReturnType<typeof jest.fn>).mock
			.calls[0];
		const range = (
			call?.[1] as {
				range: {
					startLineNumber: number;
					startColumn: number;
					endLineNumber: number;
					endColumn: number;
				};
			}[]
		)[0]?.range;
		expect(range?.startLineNumber).toBe(2);
		expect(range?.endLineNumber).toBe(2);
	});
});

describe("editorActions/deleteChunk exact ranges", () => {
	it("mid-file delete: range covers exactly the deleted lines", () => {
		// "A\nB\nC\nD" — delete index 1 (line 2). endLine=3, endCol=1.
		const ed = makeEditorWithCapture("A\nB\nC\nD");
		deleteChunk(ed, chunk({ startA: 1, endA: 2 }));
		const call = (ed.executeEdits as ReturnType<typeof jest.fn>).mock
			.calls[0];
		const range = (
			call?.[1] as {
				range: {
					startLineNumber: number;
					startColumn: number;
					endLineNumber: number;
					endColumn: number;
				};
			}[]
		)[0]?.range;
		expect(range?.startLineNumber).toBe(2);
		expect(range?.endLineNumber).toBe(3);
		expect(range?.endColumn).toBe(1);
	});

	it("delete through EOF: endLineNumber=mMax, endColumn=lastLineMaxCol", () => {
		// "A\nB\nC" — delete from index 1 to 3 (to end). No trailing newline.
		const ed = makeEditorWithCapture("A\nB\nC");
		deleteChunk(ed, chunk({ startA: 1, endA: 3 }));
		const call = (ed.executeEdits as ReturnType<typeof jest.fn>).mock
			.calls[0];
		const range = (
			call?.[1] as {
				range: {
					startLineNumber: number;
					startColumn: number;
					endLineNumber: number;
					endColumn: number;
				};
			}[]
		)[0]?.range;
		expect(range?.endLineNumber).toBe(3);
		expect(range?.endColumn).toBeGreaterThan(1);
	});
});
