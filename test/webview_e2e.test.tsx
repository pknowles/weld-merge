import { jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";
import { App } from "../src/webview/ui/App.tsx";
import { createMockEditor } from "./mockEditor.ts";

jest.mock("monaco-editor", () => {
	const mock = {} as unknown as typeof import("monaco-editor");

	const mockEditor = {} as typeof editor;
	Object.defineProperty(mock, "editor", { value: mockEditor });

	const mockEditorOption = {
		lineHeight: 1,
		readOnly: 1,
	};
	Object.defineProperty(mockEditor, "EditorOption", {
		value: mockEditorOption,
	});

	Object.defineProperty(mock, "Selection", {
		value: {
			createWithSelection() {
				return {};
			},
		},
	});

	const mockKeyMod = {};
	Object.defineProperty(mockKeyMod, "Alt", { value: 512 });
	Object.defineProperty(mockKeyMod, "CtrlCmd", { value: 2048 });
	Object.defineProperty(mock, "KeyMod", { value: mockKeyMod });

	const mockKeyCode = {};
	Object.defineProperty(mockKeyCode, "KeyJ", { value: 40 });
	Object.defineProperty(mockKeyCode, "KeyK", { value: 41 });
	Object.defineProperty(mockKeyCode, "Alt", { value: 512 });
	Object.defineProperty(mockKeyCode, "UpArrow", { value: 1 });
	Object.defineProperty(mockKeyCode, "DownArrow", { value: 2 });
	Object.defineProperty(mockKeyCode, "KeyC", { value: 3 });
	Object.defineProperty(mockKeyCode, "KeyX", { value: 4 });
	Object.defineProperty(mockKeyCode, "KeyV", { value: 5 });
	Object.defineProperty(mock, "KeyCode", { value: mockKeyCode });

	Object.defineProperty(mockEditor, "IStandaloneCodeEditor", {
		value: {},
	});

	return mock;
});

// Mock ResizeObserver
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

const messagesSent: unknown[] = [];
const vscode = {
	postMessage: jest.fn((msg: unknown) => {
		messagesSent.push(msg);
	}),
	getState: jest.fn(() => ({})),
	setState: jest.fn((_state: unknown) => {
		/* mock implementation */
	}),
};
(
	window as unknown as { acquireVsCodeApi: () => typeof vscode }
).acquireVsCodeApi = () => vscode;

// Editors registered in the order they are mounted, for retrieval by tests.
const mountedEditors: ReturnType<typeof createMockEditor>[] = [];

jest.mock(
	"@monaco-editor/react",
	() =>
		function MockedEditor(props: {
			onMount?: (ed: ReturnType<typeof createMockEditor>) => void;
			value?: string;
			defaultValue?: string;
		}) {
			const editorRef = useRef<ReturnType<
				typeof createMockEditor
			> | null>(null);

			if (editorRef.current) {
				const val =
					props.value !== undefined
						? props.value
						: props.defaultValue;
				if (val !== undefined) {
					editorRef.current.setValue(val);
				}
			}

			useEffect(() => {
				if (props.onMount && !editorRef.current) {
					const mock = createMockEditor(
						props.value || props.defaultValue || "",
					);
					editorRef.current = mock;
					mountedEditors.push(mock);
					props.onMount(mock);
				}
			}, [props.onMount, props.value, props.defaultValue]);

			return <div data-testid="monaco-editor" />;
		},
);

const clickActionButton = async (action: string) => {
	let buttons = screen.queryAllByRole("button");
	if (
		buttons.filter((b) => b.getAttribute("title") === action).length === 0
	) {
		await act(() => {
			for (let i = 0; i < 5; i++) {
				jest.advanceTimersByTime(100);
			}
		});
		buttons = screen.queryAllByRole("button");
	}
	const actionButtons = buttons.filter(
		(b) => b.getAttribute("title") === action,
	);
	const btn = actionButtons[0];
	if (!btn) {
		const titles = buttons
			.map((b) => b.getAttribute("title"))
			.filter((t): t is string => typeof t === "string")
			.join(", ");
		throw new Error(
			`Button ${action} not found. Available buttons: ${titles}`,
		);
	}
	await act(() => {
		fireEvent.click(btn);
	});
};

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
	await clickActionButton(config.action);
	await act(() => {
		jest.advanceTimersByTime(100);
	});

	// Editors mount in order: Local (0), Merged (1), Remote (2)
	return mountedEditors[1] ?? null;
};

describe("Webview E2E - Chunk Actions", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		messagesSent.length = 0;
		mountedEditors.length = 0;
	});

	afterEach(() => {
		(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi =
			undefined;
		jest.useRealTimers();
	});

	it("permutes test cases correctly", async () => {
		const tc = {
			name: "Push from Local at start",
			local: "updated line\nline 2",
			base: "line 1\nline 2",
			remote: "line 1\nline 2",
			action: "Push" as const,
			side: "left" as const,
			start: 0,
			expected: "updated line\nline 2",
		};

		const mergedEditor = await runTestCase(tc);
		expect(mergedEditor?.getValue()).toBe(tc.expected);
	});
});

const setupApp = async () => {
	render(<App />);
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: "L" },
							{ label: "Merged", content: "M" },
							{ label: "Remote", content: "R" },
						],
						diffs: [[], []],
					},
				},
				origin: "*",
			}),
		);
	});
	await act(() => {
		jest.advanceTimersByTime(500);
	});
};

const setupLongDocumentTestCase = async () => {
	const localLines = Array.from({ length: 400 }, (_, i) => `Line ${i + 1}`);
	const mergedLines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						config: { showBase: false },
						files: [
							{ label: "Local", content: localLines.join("\n") },
							{
								label: "Merged",
								content: mergedLines.join("\n"),
							},
							{ label: "Remote", content: "remote" },
						],
						diffs: [
							[
								{
									tag: "delete",
									startA: 380,
									endA: 390,
									startB: 10,
									endB: 10,
								},
							],
							[],
						],
					},
				},
				origin: "*",
			}),
		);
	});
};

describe("Webview E2E - Base Comparisons", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		messagesSent.length = 0;
		mountedEditors.length = 0;
	});

	afterEach(() => {
		(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi =
			undefined;
		jest.useRealTimers();
	});

	it("toggles compare with base and verifies visibility", async () => {
		await setupApp();
		expect(screen.getAllByTestId("monaco-editor")).toHaveLength(3);
		await act(() => {
			fireEvent.click(screen.getByTestId("toggle-base-left"));
		});
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "requestBaseDiff",
				side: "left",
			}),
		);
		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "loadBaseDiff",
						data: {
							side: "left",
							file: { label: "Base (L)", content: "BL" },
							diffs: [],
						},
					},
					origin: "*",
				}),
			);
		});
		await act(() => {
			jest.advanceTimersByTime(500);
		});
		expect(screen.getAllByTestId("monaco-editor")).toHaveLength(4);
		expect(screen.getAllByTitle("Diff Connections")).toHaveLength(3);
	});

	it("toggles compare with base on remote side", async () => {
		await setupApp();
		await act(() => {
			fireEvent.click(screen.getByTestId("toggle-base-right"));
		});
		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "loadBaseDiff",
						data: {
							side: "right",
							file: { label: "Base (R)", content: "BR" },
							diffs: [],
						},
					},
					origin: "*",
				}),
			);
		});
		await act(() => {
			jest.advanceTimersByTime(500);
		});
		expect(screen.getAllByTestId("monaco-editor")).toHaveLength(4);
		expect(screen.getAllByTitle("Diff Connections")).toHaveLength(3);
	});
});

describe("Webview E2E - Stress Tests", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		messagesSent.length = 0;
		mountedEditors.length = 0;
	});

	afterEach(() => {
		(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi =
			undefined;
		jest.useRealTimers();
	});

	it("does not crash when typing in Merged shrinks the document below Local's bounds (reversed limits bug)", async () => {
		await setupApp();
		await setupLongDocumentTestCase();
		await act(() => {
			jest.advanceTimersByTime(500);
		});
		expect(screen.getAllByTitle("Diff Connections").length).toBeGreaterThan(
			0,
		);
		const newMergedLines = Array.from(
			{ length: 40 },
			(_, i) => `Line ${i + 1}`,
		);
		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "updateContent",
						text: newMergedLines.join("\n"),
					},
					origin: "*",
				}),
			);
		});
		await act(() => {
			jest.advanceTimersByTime(500);
		});
		expect(screen.getAllByTitle("Diff Connections").length).toBeGreaterThan(
			0,
		);
	});
});
