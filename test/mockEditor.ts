// biome-ignore lint/suspicious/noExplicitAny: mock
declare let jest: any;

// biome-ignore lint/suspicious/noExplicitAny: mock
const getValueInRange = (currentContent: string, range: any) => {
	const lines = currentContent.split("\n");
	const startLine = range.startLineNumber - 1;
	const endLine = range.endLineNumber - 1;
	if (lines[startLine] === undefined || lines[endLine] === undefined) {
		return "";
	}
	if (startLine === endLine) {
		return lines[startLine].substring(
			range.startColumn - 1,
			range.endColumn - 1,
		);
	}
	let res = `${lines[startLine].substring(range.startColumn - 1)}\n`;
	for (let i = startLine + 1; i < endLine; i++) {
		res += `${lines[i]}\n`;
	}
	res += lines[endLine].substring(0, range.endColumn - 1);
	return res;
};

// biome-ignore lint/suspicious/noExplicitAny: mock
const applyEdit = (currentContent: string, edit: any) => {
	const lines = currentContent.split("\n");
	const startLine = edit.range.startLineNumber - 1;
	const endLine = edit.range.endLineNumber - 1;
	const startCol = edit.range.startColumn - 1;
	const endCol = edit.range.endColumn - 1;

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
	return before + edit.text + after;
};

export const createMockEditor = (content: string) => {
	let currentContent = content;
	// biome-ignore lint/suspicious/noExplicitAny: mock
	const onDidChangeModelContentListeners: ((e: any) => void)[] = [];

	const mock = {
		getValue: jest.fn(() => currentContent),
		setValue: jest.fn((val: string) => {
			currentContent = val;
		}),
		getModel: jest.fn(() => ({
			getLineCount: jest.fn(() => currentContent.split("\n").length),
			getValue: jest.fn(() => currentContent),
			getLineContent: jest.fn(
				(line: number) => currentContent.split("\n")[line - 1],
			),
			getLineMaxColumn: jest.fn(
				(line: number) =>
					(currentContent.split("\n")[line - 1]?.length || 0) + 1,
			),
			// biome-ignore lint/suspicious/noExplicitAny: mock
			getValueInRange: jest.fn((range: any) =>
				getValueInRange(currentContent, range),
			),
			pushEditOperations: jest.fn(
				// biome-ignore lint/suspicious/noExplicitAny: mock
				(_beforeCursor: any, edits: any[], _afterCursor: any) => {
					for (const edit of edits) {
						currentContent = applyEdit(currentContent, edit);
					}
					for (const listener of onDidChangeModelContentListeners) {
						listener({});
					}
					return null;
				},
			),
			// biome-ignore lint/suspicious/noExplicitAny: mock
			onDidChangeContent: jest.fn((cb: any) => {
				onDidChangeModelContentListeners.push(cb);
				return { dispose: jest.fn() };
			}),
		})),
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
		getLayoutInfo: jest.fn(() => ({ height: 1000 })),
		getContentHeight: jest.fn(() => 2000),
		onDidScrollChange: jest.fn(() => ({ dispose: jest.fn() })),
		getTopForLineNumber: jest.fn((l: number) => (l - 1) * 20),
		getOption: jest.fn(() => 20),
		// biome-ignore lint/suspicious/noExplicitAny: mock
		executeEdits: jest.fn((_source: string, edits: any[]) => {
			for (const edit of edits) {
				// biome-ignore lint/suspicious/noExplicitAny: mock
				const model = (mock as any).getModel();
				model.pushEditOperations([], [edit], () => []);
			}
		}),
		revealLineInCenter: jest.fn(),
		setPosition: jest.fn(),
		getPosition: jest.fn(() => ({ lineNumber: 1, column: 1 })),
		focus: jest.fn(),
		// biome-ignore lint/suspicious/noExplicitAny: mock
		trigger: jest.fn((_source: string, handlerId: string, payload: any) => {
			if (handlerId === "paste") {
				// biome-ignore lint/suspicious/noExplicitAny: mock
				const model = (mock as any).getModel();
				model.pushEditOperations(
					[],
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
					() => [],
				);
			}
		}),
		addAction: jest.fn(),
		onDidBlurEditorText: jest.fn(() => ({ dispose: jest.fn() })),
		onDidFocusEditorText: jest.fn(() => ({ dispose: jest.fn() })),
		// biome-ignore lint/suspicious/noExplicitAny: mock
		deltaDecorations: jest.fn((_old: any, newDecorations: any[]) =>
			// biome-ignore lint/suspicious/noExplicitAny: mock
			newDecorations.map((_: any, i: number) => `id-${i}`),
		),
		getSelection: jest.fn(() => ({ isEmpty: () => true })),
		getActions: jest.fn(() => []),
		updateOptions: jest.fn(),
		layout: jest.fn(),
		dispose: jest.fn(),
	};
	return mock;
};
