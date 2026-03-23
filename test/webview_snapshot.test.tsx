import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/webview/ui/App.tsx";

// biome-ignore lint/suspicious/noExplicitAny: jest is global
declare let jest: any;

import { createMockEditor } from "./mockEditor.ts";

// Mock monaco-editor
jest.mock("monaco-editor", () => ({
	editor: {
		// biome-ignore lint/suspicious/noExplicitAny: mock
		// biome-ignore lint/style/useNamingConvention: Monaco API
		IStandaloneCodeEditor: {} as any,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		EditorOption: {
			lineHeight: 1,
			readOnly: 1,
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
		// biome-ignore lint/style/useNamingConvention: Monaco API
		KeyC: 3,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		KeyX: 4,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		KeyV: 5,
	},
}));

// Mock @monaco-editor/react
jest.mock("@monaco-editor/react", () => {
	// biome-ignore lint/style/noCommonJs: jest mock requirement
	const { useEffect } = require("react");
	// biome-ignore lint/suspicious/noExplicitAny: mock
	return function MockedEditor(props: any) {
		useEffect(() => {
			if (props.onMount) {
				const mock = createMockEditor(props.defaultValue || "");
				props.onMount(mock);
			}
		}, []);
		return <div data-testid="monaco-editor" />;
	};
});

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	observe() {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	unobserve() {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	disconnect() {}
};

// Mock vscode API
const vscode = {
	postMessage: jest.fn(),
	getState: jest.fn(() => ({})),
	// biome-ignore lint/suspicious/noExplicitAny: mock
	// biome-ignore lint/suspicious/noEmptyBlockStatements: mock
	setState: jest.fn((_state: any) => {}),
};
// biome-ignore lint/suspicious/noExplicitAny: mock
(window as any).acquireVsCodeApi = () => vscode;

const setupSnapshotData = () => {
	const local =
		"Line 1\nAdded in Local\nModified Local\nCommon 1\nCommon 2\nConflict Local\nSame End";
	const base =
		"Line 1\nModified Base\nDeleted in Local\nCommon 1\nCommon 2\nDeleted in Remote\nModified Base 2\nConflict Base\nSame End";
	const remote =
		"Line 1\nCommon 1\nCommon 2\nAdded in Remote\nModified Remote\nConflict Remote\nSame End";

	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: local },
							{ label: "Merged", content: base },
							{ label: "Remote", content: remote },
						],
						diffs: [
							[
								{
									tag: "equal",
									startA: 0,
									endA: 1,
									startB: 0,
									endB: 1,
								},
								{
									tag: "insert",
									startA: 1,
									endA: 2,
									startB: 1,
									endB: 1,
								},
								{
									tag: "replace",
									startA: 2,
									endA: 3,
									startB: 1,
									endB: 2,
								},
								{
									tag: "delete",
									startA: 3,
									endA: 4,
									startB: 2,
									endB: 2,
								},
								{
									tag: "equal",
									startA: 4,
									endA: 6,
									startB: 3,
									endB: 5,
								},
								{
									tag: "conflict",
									startA: 6,
									endA: 8,
									startB: 5,
									endB: 6,
								},
								{
									tag: "equal",
									startA: 8,
									endA: 9,
									startB: 6,
									endB: 7,
								},
							],
							[
								{
									tag: "equal",
									startA: 0,
									endA: 1,
									startB: 0,
									endB: 1,
								},
								{
									tag: "equal",
									startA: 1,
									endA: 3,
									startB: 1,
									endB: 3,
								},
								{
									tag: "delete",
									startA: 3,
									endA: 4,
									startB: 3,
									endB: 3,
								},
								{
									tag: "insert",
									startA: 4,
									endA: 4,
									startB: 3,
									endB: 4,
								},
								{
									tag: "replace",
									startA: 4,
									endA: 5,
									startB: 4,
									endB: 5,
								},
								{
									tag: "conflict",
									startA: 5,
									endA: 8,
									startB: 5,
									endB: 6,
								},
								{
									tag: "equal",
									startA: 8,
									endA: 9,
									startB: 6,
									endB: 7,
								},
							],
						],
					},
				},
			}),
		);
	});
};

const setupBaseDiffs = () => {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadBaseDiff",
					data: {
						side: "left",
						file: {
							label: "Base (L)",
							content: "Base L content",
						},
						diffs: [
							{
								tag: "replace",
								startA: 0,
								endA: 1,
								startB: 0,
								endB: 1,
							},
						],
					},
				},
			}),
		);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadBaseDiff",
					data: {
						side: "right",
						file: {
							label: "Base (R)",
							content: "Base R content",
						},
						diffs: [
							{
								tag: "insert",
								startA: 0,
								endA: 0,
								startB: 0,
								endB: 1,
							},
						],
					},
				},
			}),
		);
	});
};

describe("Webview Snapshot", () => {
	const snapshotPath = path.join(
		process.cwd(),
		"test",
		"snapshots",
		"webview_root.html",
	);

	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("matches the checked-in snapshot with all diff kinds and base panes open", () => {
		const { container } = render(<App />);

		setupSnapshotData();

		const leftToggle = screen.getByTestId("toggle-base-left");
		const rightToggle = screen.getByTestId("toggle-base-right");

		act(() => {
			fireEvent.click(leftToggle);
			fireEvent.click(rightToggle);
		});

		setupBaseDiffs();

		// Advance timers for animations
		act(() => {
			jest.advanceTimersByTime(1000);
		});

		// 3. Dump the DOM
		let html = container.innerHTML;
		html = html.replace(/id="[^"]*"/g, 'id="REDACTED"');

		// 4. Diff against checked-in file
		if (!fs.existsSync(snapshotPath)) {
			fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
			fs.writeFileSync(snapshotPath, html);
			return;
		}

		const expectedHtml = fs.readFileSync(snapshotPath, "utf-8");
		if (html !== expectedHtml) {
			const actualPath = `${snapshotPath}.actual`;
			fs.writeFileSync(actualPath, html);
			throw new Error(`Snapshot mismatch! 
            Expected: ${snapshotPath}
            Actual: ${actualPath}
            To update the snapshot, delete ${snapshotPath} and rerun the test.`);
		}
	});
});
