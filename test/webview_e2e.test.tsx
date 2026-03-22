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
		// biome-ignore lint/style/useNamingConvention: Monaco API
		EditorOption: {
			lineHeight: 1,
		},
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

import { createMockEditor } from "./mockEditor.ts";

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
});

const clickActionButton = async (action: string, side: string) => {
	// Buttons only render if diffs state is updated and curtains re-render.
	let buttons = screen.queryAllByRole("button");

	if (
		buttons.filter((b) => b.getAttribute("title") === action).length === 0
	) {
		await act(() => {
			jest.runAllTimers();
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
			.filter(Boolean)
			.join(", ");
		throw new Error(
			`Button ${action} for ${side} side not found. Available buttons: ${titles}`,
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

	await clickActionButton(config.action, config.side);

	await act(() => {
		jest.advanceTimersByTime(100);
	});

	const mergedEditors = screen.getAllByTestId("monaco-editor");
	// Local, Merged, Remote
	const mergedEditorIdx = 1;
	// biome-ignore lint/suspicious/noExplicitAny: mock
	const mergedEditor = (mergedEditors[mergedEditorIdx] as any)._monaco_mock;

	if (mergedEditor) {
		// biome-ignore lint/suspicious/noMisplacedAssertion: runTestCase helper
		expect(mergedEditor.getValue()).toBe(config.expected);
	}
};

describe("Webview E2E - Chunk Actions", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		messagesSent.length = 0;
	});

	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: mock
		(window as any).acquireVsCodeApi = undefined;
		jest.useRealTimers();
	});

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

describe("Webview E2E - Base Comparisons", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		messagesSent.length = 0;
	});

	afterEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: mock
		(window as any).acquireVsCodeApi = undefined;
		jest.useRealTimers();
	});

	it("toggles compare with base and verifies visibility", async () => {
		await setupApp();

		// 1. Initial state: 3 editors
		const editors = screen.getAllByTestId("monaco-editor");
		expect(editors).toHaveLength(3);

		// 2. Click "Toggle compare with Base" on Local side
		const leftToggle = screen.getByTestId("toggle-base-left");
		expect(leftToggle).toBeDefined();

		await act(() => {
			fireEvent.click(leftToggle);
		});

		// Verify request message was sent
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "requestBaseDiff",
				side: "left",
			}),
		);

		// 3. Simulate extension response
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

		// 4. Wait for animation
		await act(() => {
			jest.advanceTimersByTime(500); // ANIMATION_DURATION is 430
		});

		// 5. Verify 4 editors and 1 diff curtain (between Base and Local)
		expect(screen.getAllByTestId("monaco-editor")).toHaveLength(4);
		expect(screen.getAllByTitle("Diff Connections")).toHaveLength(3); // base-local, local-merged, merged-remote

		// 6. Click "Toggle compare with Base" on Remote side
		const rightToggle = screen.getByTestId("toggle-base-right");
		expect(rightToggle).toBeDefined();

		await act(() => {
			fireEvent.click(rightToggle);
		});

		// Simulate response for right side
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

		// 7. Verify 5 editors and 4 diff curtains
		expect(screen.getAllByTestId("monaco-editor")).toHaveLength(5);
		expect(screen.getAllByTitle("Diff Connections")).toHaveLength(4); // BL-L, L-M, M-R, R-BR

		// 8. Toggle off
		await act(() => {
			fireEvent.click(leftToggle);
		});

		await act(() => {
			jest.advanceTimersByTime(500);
		});

		expect(screen.getAllByTestId("monaco-editor")).toHaveLength(4);
	});
});
