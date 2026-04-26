// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";
import { App } from "../src/webview/ui/App.tsx";
import { createMockEditor } from "./mockEditor.ts";

jest.mock("monaco-editor", () => {
	const mock = {} as unknown as typeof import("monaco-editor");

	const mockEditor = {} as typeof editor;
	Object.defineProperty(mock, "editor", { value: mockEditor });

	Object.defineProperty(mockEditor, "EditorOption", {
		value: { lineHeight: 1, readOnly: 1 },
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
	Object.defineProperty(mockKeyCode, "KeyS", { value: 6 });
	Object.defineProperty(mock, "KeyCode", { value: mockKeyCode });

	Object.defineProperty(mockEditor, "IStandaloneCodeEditor", { value: {} });

	return mock;
});

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

const vscode = {
	postMessage: jest.fn((_msg: unknown) => {
		/* mock */
	}),
	getState: jest.fn(() => ({})),
	setState: jest.fn((_state: unknown) => {
		/* mock */
	}),
};
(
	window as unknown as { acquireVsCodeApi: () => typeof vscode }
).acquireVsCodeApi = () => vscode;

const mountedEditors: ReturnType<typeof createMockEditor>[] = [];

jest.mock(
	"@monaco-editor/react",
	() =>
		function MockedEditor(props: {
			onMount?: (ed: ReturnType<typeof createMockEditor>) => void;
			onChange?: (
				value: string,
				ev: { changes: unknown[]; isFlush: boolean },
			) => void;
			value?: string;
			defaultValue?: string;
		}) {
			const editorRef = useRef<ReturnType<
				typeof createMockEditor
			> | null>(null);
			useEffect(() => {
				if (props.onMount && !editorRef.current) {
					const mock = createMockEditor(
						props.value || props.defaultValue || "",
					);
					editorRef.current = mock;
					mountedEditors.push(mock);
					props.onMount(mock);

					mock.getModel().onDidChangeContent(() => {
						if (props.onChange) {
							props.onChange(mock.getValue(), {
								changes: [],
								isFlush: false,
							});
						}
					});
				}
			}, [
				props.onMount,
				props.onChange,
				props.value,
				props.defaultValue,
			]);
			useEffect(() => {
				if (editorRef.current && props.value !== undefined) {
					editorRef.current.setValue(props.value);
				}
			}, [props.value]);
			return <div data-testid="monaco-editor" />;
		},
);

const setupApp = async (content = "initial content", version = 5) => {
	render(<App />);
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						files: [
							{ label: "L", content: "L" },
							{ label: "M", content },
							{ label: "R", content: "R" },
						],
						diffs: [[], []],
					},
					lastExternalChangeVersion: version,
				},
			}),
		);
	});
	await act(() => jest.advanceTimersByTime(500));
};

const getSaveAction = (middleEditor: ReturnType<typeof createMockEditor>) => {
	type AddActionCall = [{ id: string; run: () => void }];
	const addActionCalls = middleEditor.addAction.mock
		.calls as unknown as AddActionCall[];
	const saveActionCall = addActionCalls.find(
		(call) => call[0].id === "custom-save",
	);
	if (!saveActionCall) {
		throw new Error("custom-save action not registered");
	}
	return saveActionCall[0];
};

type PostMessageCall = [{ command: string; [k: string]: unknown }];
const getPostMessageCalls = (): PostMessageCall[] =>
	vscode.postMessage.mock.calls as unknown as PostMessageCall[];

const setupTimersAndMocks = () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mountedEditors.length = 0;
		vscode.postMessage.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});
};

describe("Webview editor synchronization - Basic Edits", () => {
	setupTimersAndMocks();

	it("applies incremental external edits via applyExternalEditsRef", async () => {
		await setupApp("initial content", 5);
		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [
							{
								range: {
									startLineNumber: 1,
									startColumn: 1,
									endLineNumber: 1,
									endColumn: 8,
								},
								text: "updated",
							},
						],
						lastExternalChangeVersion: 6,
					},
				}),
			);
		});

		expect(middleEditor.getValue()).toBe("updated content");
		const contentChanges = getPostMessageCalls().filter(
			(c) => c[0].command === "contentChanged",
		);
		expect(contentChanges).toHaveLength(0);
	});

	it("applies fullSync by replacing entire model content", async () => {
		await setupApp("initial content", 5);
		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "fullSync",
						content: "completely new content",
						lastExternalChangeVersion: 7,
					},
				}),
			);
		});

		expect(middleEditor.getValue()).toBe("completely new content");
	});

	it("sends contentChanged with correct version on user edit", async () => {
		await setupApp("initial content", 5);
		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}

		await act(() => {
			middleEditor.getModel().pushEditOperations(
				[],
				[
					{
						range: {
							startLineNumber: 1,
							startColumn: 1,
							endLineNumber: 1,
							endColumn: 1,
						},
						text: "new ",
					},
				],
				() => [],
			);
		});

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "contentChanged",
				lastExternalChangeVersion: 5,
			}),
		);
	});
});

describe("Webview editor synchronization - Save", () => {
	// Note: these save-race cases are best-effort in jsdom. A future
	// @vscode/test-electron integration can validate the same flows against the
	// real extension host event loop and editor lifecycle.
	setupTimersAndMocks();

	it("does not echo back external edits (no loop)", async () => {
		await setupApp("initial content", 5);

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [
							{
								range: {
									startLineNumber: 1,
									startColumn: 1,
									endLineNumber: 1,
									endColumn: 1,
								},
								text: "external ",
							},
						],
						lastExternalChangeVersion: 6,
					},
				}),
			);
		});

		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}
		expect(middleEditor.getValue()).toBe("external initial content");

		const echo = getPostMessageCalls().find(
			(c) => c[0].command === "contentChanged",
		);
		expect(echo).toBeUndefined();
	});

	it("sends save with the most recent version", async () => {
		await setupApp("initial content", 5);

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [],
						lastExternalChangeVersion: 10,
					},
				}),
			);
		});

		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}
		const saveAction = getSaveAction(middleEditor);

		await act(() => {
			saveAction.run();
		});

		expect(vscode.postMessage).toHaveBeenCalledWith({
			command: "save",
			lastExternalChangeVersion: 10,
		});
	});
});

describe("Webview editor synchronization - Save Race Cases", () => {
	// Note: these save-race cases are best-effort in jsdom. A future
	// @vscode/test-electron integration can validate the same flows against the
	// real extension host event loop and editor lifecycle.
	setupTimersAndMocks();

	it("uses newest external version when save follows multiple in-flight updates", async () => {
		await setupApp("initial content", 3);

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [],
						lastExternalChangeVersion: 7,
					},
				}),
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [],
						lastExternalChangeVersion: 8,
					},
				}),
			);
		});

		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}
		const saveAction = getSaveAction(middleEditor);

		await act(() => {
			saveAction.run();
		});

		expect(vscode.postMessage).toHaveBeenCalledWith({
			command: "save",
			lastExternalChangeVersion: 8,
		});
	});

	it("prefers external version bump over local unsaved edits", async () => {
		await setupApp("initial content", 5);
		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}

		await act(() => {
			middleEditor.getModel().pushEditOperations(
				[],
				[
					{
						range: {
							startLineNumber: 1,
							startColumn: 1,
							endLineNumber: 1,
							endColumn: 1,
						},
						text: "local ",
					},
				],
				() => [],
			);
		});

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [],
						lastExternalChangeVersion: 6,
					},
				}),
			);
		});

		const saveAction = getSaveAction(middleEditor);
		await act(() => {
			saveAction.run();
		});

		expect(vscode.postMessage).toHaveBeenCalledWith({
			command: "save",
			lastExternalChangeVersion: 6,
		});
	});

	it("updates save version after save then later external change", async () => {
		await setupApp("initial content", 2);
		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}
		const saveAction = getSaveAction(middleEditor);

		await act(() => {
			saveAction.run();
		});
		expect(vscode.postMessage).toHaveBeenCalledWith({
			command: "save",
			lastExternalChangeVersion: 2,
		});

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [],
						lastExternalChangeVersion: 9,
					},
				}),
			);
		});

		await act(() => {
			saveAction.run();
		});
		expect(vscode.postMessage).toHaveBeenCalledWith({
			command: "save",
			lastExternalChangeVersion: 9,
		});
	});
});

const runStressIteration = async (
	middleEditor: ReturnType<typeof createMockEditor>,
	index: number,
	currentVersion: { value: number },
): Promise<void> => {
	if (index >= 20) {
		return;
	}

	if (index % 2 === 0) {
		currentVersion.value++;
		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "externalEdit",
						changes: [
							{
								range: {
									startLineNumber: 1,
									startColumn: 1,
									endLineNumber: 1,
									endColumn: 1,
								},
								text: `e${index}`,
							},
						],
						lastExternalChangeVersion: currentVersion.value,
					},
				}),
			);
		});
	} else {
		await act(() => {
			middleEditor.getModel().pushEditOperations(
				[],
				[
					{
						range: {
							startLineNumber: 1,
							startColumn: 1,
							endLineNumber: 1,
							endColumn: 1,
						},
						text: `u${index}`,
					},
				],
				() => [],
			);
		});
	}
	await act(() => jest.advanceTimersByTime(Math.floor(Math.random() * 5)));
	await runStressIteration(middleEditor, index + 1, currentVersion);
};

describe("Webview editor synchronization - Stress", () => {
	setupTimersAndMocks();

	it("handles interleaved edits and syncs without corruption", async () => {
		await setupApp("initial", 1);
		const middleEditor = mountedEditors[1];
		if (!middleEditor) {
			throw new Error("middle editor not mounted");
		}
		const currentVersion = { value: 1 };

		await runStressIteration(middleEditor, 0, currentVersion);

		expect(typeof middleEditor.getValue()).toBe("string");
		expect(middleEditor.getValue()).toContain("e");
		expect(middleEditor.getValue()).toContain("u");
	});
});
