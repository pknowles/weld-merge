import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
// TODO: seems flaky - has to be after mockMonacoSetup.tsx. Why?
import { App } from "../src/webview/ui/App.tsx";
import {
	createVscodeStub,
	installResizeObserverMock,
	installVscodeApi,
	mountedEditors,
	resetMountedEditors,
	uninstallVscodeApi,
	type VscodeStub,
} from "./mockMonacoSetup.tsx";

// require() is intentional: jest.mock factories are hoisted before ESM imports initialize
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock("monaco-editor", () =>
	require("./mockMonacoSetup.tsx").createMonacoMock(),
);
jest.mock("@monaco-editor/react", () =>
	require("./mockMonacoSetup.tsx").createMonacoReactMockComponent(),
);
/* eslint-enable @typescript-eslint/no-require-imports */

installResizeObserverMock();
const vscode: VscodeStub = createVscodeStub();
installVscodeApi(vscode);

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
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
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
						lastExternalChangeVersion: 1,
					},
				},
				origin: "*",
			}),
		);
	});

	await act(() => {
		jest.advanceTimersByTime(500);
	});
	const mergedEditor =
		mountedEditors.find((entry) => entry.props.options?.readOnly === false)
			?.mock ?? null;
	let buttons = screen.queryAllByRole("button");
	let actionButtons = buttons.filter(
		(button) => button.getAttribute("title") === config.action,
	);
	if (actionButtons.length === 0) {
		await act(() => {
			for (let i = 0; i < 5; i++) {
				jest.advanceTimersByTime(100);
			}
		});
		buttons = screen.queryAllByRole("button");
		actionButtons = buttons.filter(
			(button) => button.getAttribute("title") === config.action,
		);
	}
	if (actionButtons.length === 0) {
		const titles = buttons
			.map((button) => button.getAttribute("title"))
			.filter((title): title is string => typeof title === "string")
			.join(", ");
		throw new Error(
			`Button ${config.action} not found. Available buttons: ${titles}`,
		);
	}
	await actionButtons.reduce<Promise<void>>(async (chain, button) => {
		await chain;
		if (mergedEditor?.getValue() === config.expected) {
			return;
		}
		await act(() => {
			fireEvent.click(button);
		});
	}, Promise.resolve());

	return mergedEditor;
};

describe("Webview E2E - Chunk Actions", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		vscode.messagesSent.length = 0;
		resetMountedEditors();
	});

	afterEach(() => {
		uninstallVscodeApi();
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
						isConflicted: true,
						lastExternalChangeVersion: 1,
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
		vscode.messagesSent.length = 0;
		resetMountedEditors();
	});

	afterEach(() => {
		uninstallVscodeApi();
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

describe("Webview E2E - Conflict State Transitions", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		vscode.messagesSent.length = 0;
		resetMountedEditors();
	});

	afterEach(() => {
		uninstallVscodeApi();
		jest.useRealTimers();
	});

	it("shows no-conflict state and restores merge controls when conflicts return", async () => {
		await setupApp();
		expect(screen.getByText("Save & Complete Merge")).toBeInTheDocument();

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "conflictStateLost",
					},
				}),
			);
		});

		expect(
			screen.queryByText("Save & Complete Merge"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("File is no longer conflicted."),
		).toBeInTheDocument();
		expect(screen.getByTestId("weld-root")).toHaveStyle(
			"background-color: #4b1f1f",
		);

		await act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "loadDiff",
						data: {
							files: [
								{ label: "Local", content: "L2" },
								{ label: "Merged", content: "M2" },
								{ label: "Remote", content: "R2" },
							],
							diffs: [[], []],
							isConflicted: true,
						},
						lastExternalChangeVersion: 2,
					},
				}),
			);
		});

		expect(screen.getByText("Save & Complete Merge")).toBeInTheDocument();
		expect(
			screen.queryByText("File is no longer conflicted."),
		).not.toBeInTheDocument();
	});
});

describe("Webview E2E - Stress Tests", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		vscode.messagesSent.length = 0;
		resetMountedEditors();
	});

	afterEach(() => {
		uninstallVscodeApi();
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
						command: "fullSync",
						content: newMergedLines.join("\n"),
						lastExternalChangeVersion: 1,
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
