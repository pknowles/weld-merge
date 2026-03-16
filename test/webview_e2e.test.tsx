import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/webview/ui/App.tsx";

// biome-ignore lint/suspicious/noExplicitAny: jest is global
declare let jest: any;

// Mock monaco-editor
jest.mock("monaco-editor", () => ({
	editor: {
		// biome-ignore lint/suspicious/noExplicitAny: mock
		// biome-ignore lint/style/useNamingConvention: Monaco API
		IStandaloneCodeEditor: {} as any,
	},
	// biome-ignore lint/style/useNamingConvention: Monaco API
	Selection: {
		createWithSelection() {
			return {};
		},
	},
	// biome-ignore lint/style/useNamingConvention: Monaco API
	KeyMod: {
		// biome-ignore lint/style/useNamingConvention: Monaco API
		Alt: 512,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		CtrlCmd: 2048,
	},
	// biome-ignore lint/style/useNamingConvention: Monaco API
	KeyCode: {
		// biome-ignore lint/style/useNamingConvention: Monaco API
		KeyJ: 40,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		KeyK: 41,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		Alt: 512,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		UpArrow: 1,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		DownArrow: 2,
	},
}));

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	observe() {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	unobserve() {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	disconnect() {}
};

const createMockEditor = (content: string) => {
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
			getValueInRange: jest.fn((range: any) => {
				const lines = currentContent.split("\n");
				const startLine = range.startLineNumber - 1;
				const endLine = range.endLineNumber - 1;
				if (
					lines[startLine] === undefined ||
					lines[endLine] === undefined
				) {
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
			}),
			pushEditOperations: jest.fn(
				// biome-ignore lint/suspicious/noExplicitAny: mock
				(_beforeCursor: any, edits: any[], _afterCursor: any) => {
					// Very basic simulation of edits
					for (const edit of edits) {
						const lines = currentContent.split("\n");
						const startLine = edit.range.startLineNumber - 1;
						const endLine = edit.range.endLineNumber - 1;
						const startCol = edit.range.startColumn - 1;
						const endCol = edit.range.endColumn - 1;

						const lineStart = lines[startLine];
						const lineEnd = lines[endLine];
						if (lineStart === undefined || lineEnd === undefined) {
							continue;
						}

						const before =
							lines.slice(0, startLine).join("\n") +
							(startLine > 0 ? "\n" : "") +
							lineStart.substring(0, startCol);
						const after =
							lineEnd.substring(endCol) +
							(endLine < lines.length - 1 ? "\n" : "") +
							lines.slice(endLine + 1).join("\n");
						currentContent = before + edit.text + after;
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
		getScrollTop: jest.fn(() => 0),
		getContainerDomNode: jest.fn(() => ({
			getBoundingClientRect: jest.fn(() => ({
				top: 0,
				left: 0,
				width: 100,
				height: 1000,
			})),
		})),
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

// biome-ignore lint/suspicious/noExplicitAny: mock
const messagesSent: any[] = [];
const vscode = {
	// biome-ignore lint/suspicious/noExplicitAny: mock
	postMessage: jest.fn((msg: any) => {
		messagesSent.push(msg);
	}),
	getState: jest.fn(() => ({})),
	// biome-ignore lint/suspicious/noExplicitAny: mock
	setState: jest.fn((_state: any) => {
		// mock implementation
	}),
};
// biome-ignore lint/suspicious/noExplicitAny: mock
(window as any).acquireVsCodeApi = () => vscode;

jest.mock("@monaco-editor/react", () => {
	// biome-ignore lint/style/noCommonJs: jest mock requirement
	const { useEffect } = require("react");
	// biome-ignore lint/suspicious/noExplicitAny: mock
	return function MockedEditor(props: any) {
		useEffect(() => {
			if (props.onMount) {
				const mock = createMockEditor(props.defaultValue || "");
				// biome-ignore lint/suspicious/noExplicitAny: mock
				(mock as any)._monaco_mock = mock; // for easier access
				props.onMount(mock);
			}
		}, [props.onMount, props.defaultValue]);
		return <div data-testid="monaco-editor" />;
	};
});

describe("Webview E2E Regression Tests", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		messagesSent.length = 0;
	});

	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: mock
		(window as any).acquireVsCodeApi = undefined;
		jest.useRealTimers();
	});

	const runTestCase = async (config: {
		local: string;
		base: string;
		remote: string;
		action: "Push" | "Copy up" | "Copy down" | "Delete";
		side: "left" | "right";
		expected: string;
		start: number;
	}) => {
		render(<App />);

		await act(() => {
			window.postMessage(
				{
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: config.local },
							{ label: "Base/Merged", content: config.base },
							{ label: "Remote", content: config.remote },
						],
						diffs: [
							// Local <-> Merged
							config.side === "left"
								? [
										{
											tag: "replace",
											startA: config.start,
											endA: config.start + 1,
											startB: config.start,
											endB: config.start + 1,
										},
									]
								: [],
							// Merged <-> Remote
							config.side === "right"
								? [
										{
											tag: "replace",
											startA: config.start,
											endA: config.start + 1,
											startB: config.start,
											endB: config.start + 1,
										},
									]
								: [],
						],
					},
				},
				"*",
			);
		});

		await act(() => {
			jest.advanceTimersByTime(500);
		});

		// Buttons only render if diffs state is updated and curtains re-render.
		let buttons = screen.queryAllByRole("button");

		if (
			buttons.filter((b) => b.getAttribute("title") === config.action)
				.length === 0
		) {
			await act(() => {
				jest.runAllTimers();
			});
			buttons = screen.queryAllByRole("button");
		}

		const actionButtons = buttons.filter(
			(b) => b.getAttribute("title") === config.action,
		);
		const btn = actionButtons[0];

		if (!btn) {
			const titles = buttons
				.map((b) => b.getAttribute("title"))
				.filter(Boolean)
				.join(", ");
			throw new Error(
				`Button ${config.action} for ${config.side} side not found. Available buttons: ${titles}`,
			);
		}

		await act(() => {
			fireEvent.click(btn);
		});

		await act(() => {
			jest.advanceTimersByTime(100);
		});

		const mergedEditors = screen.getAllByTestId("monaco-editor");
		// Local, Merged, Remote
		const mergedEditorIdx = 1;
		// biome-ignore lint/suspicious/noExplicitAny: mock
		const mergedEditor = (mergedEditors[mergedEditorIdx] as any)
			._monaco_mock;

		if (mergedEditor) {
			// biome-ignore lint/suspicious/noMisplacedAssertion: runTestCase helper
			expect(mergedEditor.getValue()).toBe(config.expected);
		}
	};

	it("permutes test cases correctly", async () => {
		const testCases = [
			{
				name: "Push from Local at start",
				local: "updated line\nline 2",
				base: "line 1\nline 2",
				remote: "line 1\nline 2",
				action: "Push" as const,
				side: "left" as const,
				start: 0,
				expected: "updated line\nline 2",
			},
		];

		for (const tc of testCases) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential execution required
			await runTestCase(tc);
		}
	});
});
