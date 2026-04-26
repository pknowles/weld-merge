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
