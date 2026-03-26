import { jest } from "@jest/globals";
import type { editor, IRange, ISelection, Selection } from "monaco-editor";

const getValueInRange = (currentContent: string, range: IRange) => {
	const lines = currentContent.split("\n");
	const startLine = range.startLineNumber - 1;
	const endLine = range.endLineNumber - 1;
	const lineStart = lines[startLine];
	const lineEnd = lines[endLine];
	if (lineStart === undefined || lineEnd === undefined) {
		return "";
	}
	if (startLine === endLine) {
		return lineStart.substring(range.startColumn - 1, range.endColumn - 1);
	}
	let res = `${lineStart.substring(range.startColumn - 1)}\n`;
	for (let i = startLine + 1; i < endLine; i++) {
		res += `${lines[i]}\n`;
	}
	res += lineEnd.substring(0, range.endColumn - 1);
	return res;
};

const applyEdit = (
	currentContent: string,
	edit: editor.IIdentifiedSingleEditOperation,
) => {
	const lines = currentContent.split("\n");
	const range = edit.range;
	const startLine = range.startLineNumber - 1;
	const endLine = range.endLineNumber - 1;
	const startCol = range.startColumn - 1;
	const endCol = range.endColumn - 1;

	const lineStart = lines[startLine];
	const lineEnd = lines[endLine];
	if (lineStart === undefined || lineEnd === undefined) {
		return currentContent;
	}

	const before =
		lines.slice(0, startLine).join("\n") +
		(startLine > 0 ? "\n" : "") +
		lineStart.substring(0, startCol);
	const after =
		lineEnd.substring(endCol) +
		(endLine < lines.length - 1 ? "\n" : "") +
		lines.slice(endLine + 1).join("\n");
	return before + (edit.text ?? "") + after;
};

const getPositionAtHelper = (text: string, offset: number) => {
	const lines = text.split("\n");
	let remaining = offset;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) {
			continue;
		}
		const lineLen = line.length;
		if (remaining <= lineLen) {
			return { lineNumber: i + 1, column: remaining + 1 };
		}
		remaining -= lineLen + 1; // +1 for the newline character
	}
	const lastLine = lines.at(-1) ?? "";
	return { lineNumber: lines.length || 1, column: lastLine.length + 1 };
};

const createMockModel = (
	getContent: () => string,
	setContent: (v: string) => void,
	listeners: ((e: editor.IModelContentChangedEvent) => void)[],
) => ({
	getLineCount: jest.fn(() => getContent().split("\n").length),
	getValue: jest.fn(() => getContent()),
	getLineContent: jest.fn(
		(line: number) => getContent().split("\n")[line - 1],
	),
	getLineMaxColumn: jest.fn(
		(line: number) => (getContent().split("\n")[line - 1]?.length || 0) + 1,
	),
	getPositionAt: jest.fn((offset: number) =>
		getPositionAtHelper(getContent(), offset),
	),
	getValueInRange: jest.fn((range: IRange) =>
		getValueInRange(getContent(), range),
	),
	pushEditOperations: jest.fn(
		(
			_beforeCursor: Selection[] | ISelection[] | null,
			edits: editor.IIdentifiedSingleEditOperation[],
			_afterCursor:
				| ((
						inverseEditOperations: editor.IIdentifiedSingleEditOperation[],
				  ) => Selection[] | ISelection[] | null)
				| null,
		) => {
			for (const edit of edits) {
				setContent(applyEdit(getContent(), edit));
			}
			for (const listener of listeners) {
				listener({} as editor.IModelContentChangedEvent);
			}
			return null;
		},
	),
	onDidChangeContent: jest.fn(
		(cb: (e: editor.IModelContentChangedEvent) => void) => {
			listeners.push(cb);
			return {
				dispose: jest.fn(() => {
					/* mock */
				}),
			};
		},
	),
});

export const createMockEditor = (content: string) => {
	let currentContent = content;
	const listeners: ((e: editor.IModelContentChangedEvent) => void)[] = [];

	const mockModel = createMockModel(
		() => currentContent,
		(v) => {
			currentContent = v;
		},
		listeners,
	);

	const mockEditor = {
		getValue: jest.fn(() => currentContent),
		setValue: jest.fn((val: string) => {
			currentContent = val;
		}),
		getModel: jest.fn(() => mockModel as unknown as editor.ITextModel),
		getContainerDomNode: jest.fn(() => ({
			getBoundingClientRect: jest.fn(() => ({
				top: 0,
				left: 0,
				width: 100,
				height: 1000,
			})),
		})),
		getScrollTop: jest.fn(() => 0),
		getScrollLeft: jest.fn(() => 0),
		setScrollTop: jest.fn(() => {
			/* mock */
		}),
		setScrollLeft: jest.fn(() => {
			/* mock */
		}),
		getLayoutInfo: jest.fn(() => ({ height: 1000 })),
		getContentHeight: jest.fn(() => 2000),
		onDidScrollChange: jest.fn(() => ({
			dispose: jest.fn(() => {
				/* mock */
			}),
		})),
		getTopForLineNumber: jest.fn((l: number) => (l - 1) * 20),
		getOption: jest.fn(() => 20),
		executeEdits: jest.fn(
			(
				_source: string | null | undefined,
				edits: editor.IIdentifiedSingleEditOperation[],
			) => {
				mockModel.pushEditOperations(null, edits, null);
			},
		),
		revealLineInCenter: jest.fn(() => {
			/* mock */
		}),
		setPosition: jest.fn(() => {
			/* mock */
		}),
		getPosition: jest.fn(() => ({ lineNumber: 1, column: 1 })),
		focus: jest.fn(() => {
			/* mock */
		}),
		trigger: jest.fn(
			(
				_source: string | null | undefined,
				handlerId: string,
				payload: { text: string },
			) => {
				if (handlerId === "paste") {
					mockModel.pushEditOperations(
						null,
						[
							{
								range: {
									startLineNumber: 1,
									startColumn: 1,
									endLineNumber: 1,
									endColumn: 1,
								},
								text: payload.text,
							},
						],
						null,
					);
				}
			},
		),
		addAction: jest.fn(() => {
			/* mock */
		}),
		onDidBlurEditorText: jest.fn(() => ({
			dispose: jest.fn(() => {
				/* mock */
			}),
		})),
		onDidFocusEditorText: jest.fn(() => ({
			dispose: jest.fn(() => {
				/* mock */
			}),
		})),
		deltaDecorations: jest.fn(
			(_old: string[], newDecorations: editor.IModelDeltaDecoration[]) =>
				newDecorations.map((_, i) => `id-${i}`),
		),
		getSelection: jest.fn(() => ({ isEmpty: () => true })),
		getActions: jest.fn(() => []),
		updateOptions: jest.fn(() => {
			/* mock */
		}),
		onDidLayoutChange: jest.fn(() => ({
			dispose: jest.fn(() => {
				/* mock */
			}),
		})),
		layout: jest.fn(() => {
			/* mock */
		}),
		dispose: jest.fn(() => {
			/* mock */
		}),
	};
	return mockEditor;
};
