/**
 * Webview Survival Stress Test
 *
 * DESIGN PHILOSOPHY:
 * This is a "Survival Test" designed specifically for Stryker mutation testing.
 * While it mocks the peripheral View layer (Monaco rendering, SVG lines), it
 * exercises the REAL "brains" of the application:
 *   - src/matchers/diffutil.ts (The Differ class)
 *   - src/matchers/merge.ts (The Merger logic)
 *   - src/webview/ui/appHooks.ts (State management and change propagation)
 *
 * MUTANT KILLER MECHANISM:
 * The test uses a "Catch-and-Restore" cycle. By performing random actions (Stage 1)
 * and modifications (Stage 2), we put the internal Differ state through a gauntlet
 * of complex transitions. If a mutant causes the Differ to corrupt its internal cache
 * or miscalculate offsets, the final "revert to baseline" assertion will fail.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { Differ } from "../src/matchers/diffutil.ts";
import { App } from "../src/webview/ui/App.tsx";
import type { DiffChunk } from "../src/webview/ui/types.ts";

// Interfaces for mocks to avoid 'any'
interface MockModel {
	getLineCount: () => number;
	getValue: () => string;
	getLineContent: (line: number) => string;
	getLineMaxColumn: (line: number) => number;
	getValueInRange: (range: {
		startLineNumber: number;
		startColumn: number;
		endLineNumber: number;
		endColumn: number;
	}) => string;
	pushEditOperations: (
		before: unknown[],
		edits: {
			range: {
				startLineNumber: number;
				startColumn: number;
				endLineNumber: number;
				endColumn: number;
			};
			text: string;
		}[],
		after: () => unknown[],
	) => void;
	onDidChangeContent: (cb: (e: unknown) => void) => { dispose: () => void };
}

interface MockEditor {
	getValue: () => string;
	setValue: (val: string) => void;
	getModel: () => MockModel;
	getContainerDomNode: () => {
		getBoundingClientRect: () => {
			top: number;
			left: number;
			width: number;
			height: number;
		};
	};
	getScrollTop: () => number;
	getScrollLeft: () => number;
	getLayoutInfo: () => { height: number };
	getContentHeight: () => number;
	onDidScrollChange: () => { dispose: () => void };
	getTopForLineNumber: (line: number) => number;
	getOption: (id: number) => number;
	executeEdits: (
		source: string,
		edits: {
			range: {
				startLineNumber: number;
				startColumn: number;
				endLineNumber: number;
				endColumn: number;
			};
			text: string;
			forceMoveMarkers?: boolean;
		}[],
	) => void;
	revealLineInCenter: (line: number) => void;
	setPosition: (pos: { lineNumber: number; column: number }) => void;
	focus: () => void;
	trigger: (
		source: string,
		handlerId: string,
		payload: { text: string },
	) => void;
	addAction: (options: unknown) => void;
	onDidBlurEditorText: () => { dispose: () => void };
	onDidFocusEditorText: () => { dispose: () => void };
	deltaDecorations: (old: string[], newDec: unknown[]) => string[];
	getSelection: () => { isEmpty: () => boolean };
	getPosition: () => { lineNumber: number; column: number } | null;
	getActions: () => unknown[];
	updateOptions: (options: unknown) => void;
	layout: () => void;
	dispose: () => void;
}

interface MockedEditorProps {
	onMount?: (m: MockEditor) => void;
	onChange?: (content: string) => void;
	defaultValue?: string;
	options?: { readOnly?: boolean };
}

// biome-ignore lint/suspicious/noExplicitAny: globally declared jest
declare let jest: any;

const capturedEditors: { props: MockedEditorProps; mock: MockEditor }[] = [];
const capturedDiffsMap: Record<string, DiffChunk[]> = {};
let mergedEditorMock: MockEditor | null = null;

const createMockModel = (
	initialContent: string,
	onContentChange: (newContent: string) => void,
): MockModel => {
	let content = initialContent;
	const listeners: ((e: unknown) => void)[] = [];

	return {
		getLineCount: () => content.split("\n").length,
		getValue: () => content,
		getLineContent: (line) => content.split("\n")[line - 1] ?? "",
		getLineMaxColumn: (line) =>
			(content.split("\n")[line - 1]?.length || 0) + 1,
		getValueInRange: (range) => {
			const lines = content.split("\n");
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
		},
		pushEditOperations: (_before, edits, _after) => {
			let nextContent = content;
			for (const edit of edits) {
				const lines = nextContent.split("\n");
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
				nextContent = before + edit.text + after;
			}
			content = nextContent;
			onContentChange(content);
			for (const l of listeners) {
				l({});
			}
		},
		onDidChangeContent: (cb) => {
			listeners.push(cb);
			return {
				dispose: () => {
					/* Intentionally empty */
				},
			};
		},
	};
};

const createMockEditorInstance = (
	content: string,
	isReadOnly: boolean,
): MockEditor => {
	let currentContent = content;
	let model: MockModel;

	const mock: MockEditor = {
		getValue: () => currentContent,
		setValue: (val) => {
			currentContent = val;
		},
		getModel: () => model,
		getContainerDomNode: () => ({
			getBoundingClientRect: () => ({
				top: 0,
				left: 0,
				width: 100,
				height: 1000,
			}),
		}),
		getScrollTop: () => 0,
		getScrollLeft: () => 0,
		getLayoutInfo: () => ({ height: 1000 }),
		getContentHeight: () => 2000,
		onDidScrollChange: () => ({
			dispose: () => {
				/* Intentionally empty */
			},
		}),
		getTopForLineNumber: (l) => (l - 1) * 20,
		getOption: () => 20,
		executeEdits: (_source, edits) => {
			model.pushEditOperations([], edits, () => []);
		},
		revealLineInCenter: jest.fn(),
		setPosition: jest.fn(),
		focus: jest.fn(),
		trigger: (_source, handlerId, payload) => {
			if (handlerId === "paste") {
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
		},
		addAction: jest.fn(),
		onDidBlurEditorText: () => ({
			dispose: () => {
				/* Intentionally empty */
			},
		}),
		onDidFocusEditorText: () => ({
			dispose: () => {
				/* Intentionally empty */
			},
		}),
		deltaDecorations: (_old, newDec) => newDec.map((_, i) => `id-${i}`),
		getSelection: () => ({ isEmpty: () => true }),
		getPosition: () => ({ lineNumber: 1, column: 1 }),
		getActions: () => [],
		updateOptions: jest.fn(),
		layout: jest.fn(),
		dispose: jest.fn(),
	};

	model = createMockModel(currentContent, (newContent) => {
		currentContent = newContent;
	});

	if (!isReadOnly) {
		mergedEditorMock = mock;
	}

	return mock;
};

// Mock monaco-editor
jest.mock("monaco-editor", () => ({
	editor: {
		// biome-ignore lint/style/useNamingConvention: Monaco API
		IStandaloneCodeEditor: {} as unknown,
		// biome-ignore lint/style/useNamingConvention: Monaco API
		EditorOption: { lineHeight: 1, readOnly: 1 },
	},
	// biome-ignore lint/style/useNamingConvention: Monaco API
	Selection: { createWithSelection: () => ({}) },
	// biome-ignore lint/style/useNamingConvention: Monaco API
	KeyMod: { Alt: 512, CtrlCmd: 2048 },
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
	// biome-ignore lint/style/noCommonJs: jest.mock dynamic require
	const React = require("react") as typeof import("react");
	const { useEffect, useRef } = React;
	return function MockedEditor(props: MockedEditorProps) {
		const initialized = useRef(false);
		const currentEntry = useRef<{
			props: MockedEditorProps;
			mock: MockEditor;
		} | null>(null);

		useEffect(() => {
			if (!initialized.current && props.onMount) {
				const mock = createMockEditorInstance(
					props.defaultValue || "",
					Boolean(props.options?.readOnly),
				);
				const entry = { props, mock };
				capturedEditors.push(entry);
				currentEntry.current = entry;
				props.onMount(mock);
				initialized.current = true;
			}
		}, []);

		if (currentEntry.current) {
			currentEntry.current.props = props;
		}

		return <div data-testid="monaco-editor" />;
	};
});

// Mock DiffCurtain
jest.mock("../src/webview/ui/DiffCurtain", () => ({
	// biome-ignore lint/style/useNamingConvention: Component name in mock
	DiffCurtain: (props: {
		leftEditor: MockEditor;
		rightEditor: MockEditor;
		diffs: DiffChunk[];
	}) => {
		const leftIdx = capturedEditors.findIndex(
			(e) => e.mock === props.leftEditor,
		);
		const rightIdx = capturedEditors.findIndex(
			(e) => e.mock === props.rightEditor,
		);
		if (leftIdx !== -1 && rightIdx !== -1) {
			capturedDiffsMap[`${leftIdx}-${rightIdx}`] = props.diffs;
		}
		return <div data-testid="diff-curtain-mock" />;
	},
}));

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
	observe(): void {
		/* Intentionally empty */
	}
	unobserve(): void {
		/* Intentionally empty */
	}
	disconnect(): void {
		/* Intentionally empty */
	}
};

// Mock vscode API
const mockVscode = {
	postMessage: jest.fn(),
	getState: jest.fn(() => ({})),
	setState: jest.fn(),
};
// biome-ignore lint/suspicious/noExplicitAny: mock setup
(window as any).acquireVsCodeApi = () => mockVscode;

const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const dedupeChunks = (chunks: DiffChunk[]) => {
	const seen = new Set<string>();
	return chunks.filter((c) => {
		const key = `${c.startA}-${c.endA}-${c.startB}-${c.endB}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
};

const random = (seed: number) => {
	const x = Math.sin(seed) * 10_000;
	return x - Math.floor(x);
};

const waitForDebounce = (ms = 1000) => {
	act(() => {
		jest.advanceTimersByTime(ms);
	});
};

const dispatchAction = (
	action: number,
	_iteration: number,
	_entry: { props: MockedEditorProps; mock: MockEditor } | undefined,
	seed: number,
) => {
	const titles = ["Push", "Delete", "Copy up", "Copy down"];
	const title = titles[action % titles.length];
	if (title) {
		const btns = screen.queryAllByTitle(title);
		if (btns.length > 0) {
			const btn = btns[Math.floor(random(seed) * btns.length)];
			if (btn) {
				fireEvent.click(btn);
			}
		}
	}
};

const performRandomAction = (iteration: number, seed: number) => {
	if (!mergedEditorMock) {
		return;
	}
	const entry = capturedEditors.find((e) => e.mock === mergedEditorMock);
	const action = Math.floor(random(seed) * 4); // 4 actions now

	act(() => {
		dispatchAction(action, iteration, entry, seed);
	});
	waitForDebounce();
};

const performRandomModification = (iteration: number, seed: number) => {
	if (!mergedEditorMock) {
		return;
	}
	const entry = capturedEditors.find((e) => e.mock === mergedEditorMock);
	const lines = mergedEditorMock.getValue().split("\n");
	const lineIdx = Math.floor(random(seed) * lines.length);

	const modType = Math.floor(random(seed + 1) * 3);
	if (modType === 0) {
		// Insert
		lines.splice(lineIdx, 0, `Random Insert ${iteration}`);
	} else if (modType === 1) {
		// Delete
		if (lines.length > 1) {
			lines.splice(lineIdx, 1);
		}
	} else {
		// Replace
		lines[lineIdx] = `Random Replace ${iteration}`;
	}

	act(() => {
		entry?.props.onChange?.(lines.join("\n"));
	});
	waitForDebounce();
};

const loadTestData = (
	local = "SAME\nL1\nSAME\nL2\nSAME",
	base = "SAME\nB1\nSAME\nB2\nSAME",
	remote = "SAME\nB1\nSAME\nR2\nSAME",
) => {
	const differ = new Differ();
	const iter = differ.setSequencesIter([
		splitLines(local),
		splitLines(base),
		splitLines(remote),
	]);
	let s = iter.next();
	while (!s.done) {
		s = iter.next();
	}

	const allChanges = differ.allChanges();
	const realDiffs = [
		dedupeChunks(
			allChanges
				.map((p: [DiffChunk | null, DiffChunk | null]) => p[0])
				.filter((x): x is DiffChunk => x !== null),
		),
		dedupeChunks(
			allChanges
				.map((p: [DiffChunk | null, DiffChunk | null]) => p[1])
				.filter((x): x is DiffChunk => x !== null),
		),
	];

	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: local },
							{ label: "Base", content: base },
							{ label: "Remote", content: remote },
						],
						diffs: realDiffs,
					},
				},
			}),
		);
	});
	waitForDebounce();
	return { realDiffs, mergedText: base };
};

describe("Webview Survival Stress Test", () => {
	let seed = 12_345;

	beforeEach(() => {
		jest.useFakeTimers();
		capturedEditors.length = 0;
		for (const k of Object.keys(capturedDiffsMap)) {
			delete capturedDiffsMap[k];
		}
		mergedEditorMock = null;
		seed = 12_345;
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("survives random actions and modifications (Stage 1 & 2)", () => {
		render(<App />);
		const { realDiffs: baselineDiffs, mergedText: baselineText } =
			loadTestData();
		const baselineLr = JSON.parse(JSON.stringify(baselineDiffs[0]));
		const baselineRm = JSON.parse(JSON.stringify(baselineDiffs[1]));

		const entry = capturedEditors.find((e) => e.mock === mergedEditorMock);
		if (!entry) {
			throw new Error("Merged editor not found");
		}

		// STAGE 1: Random Cluster of Action Buttons
		// This exercises the `Merger` logic and the ability of the `Differ`
		// to track changes made via standard UI actions (Push/Delete/Copy).
		for (let i = 0; i < 20; i++) {
			performRandomAction(i, seed++);

			// Survival Assertion: The app must not crash and must produce some diffs
			expect(capturedDiffsMap["0-1"]).toBeDefined();
			expect(capturedDiffsMap["1-2"]).toBeDefined();

			// Catch-and-Restore: Reverting to the origin MUST result in a perfect diff state.
			// Any drift here indicates a corrupted internal state in the Differ cache.
			act(() => {
				entry.props.onChange?.(baselineText);
			});
			waitForDebounce();
			expect(capturedDiffsMap["0-1"]).toEqual(baselineLr);
			expect(capturedDiffsMap["1-2"]).toEqual(baselineRm);
		}

		// STAGE 2: Random Document Modifications (Arbitrary Text Edits)
		// This simulates a user typing or pasting text, which triggers the
		// incremental update logic in `src/webview/ui/appHooks.ts`.
		for (let i = 0; i < 20; i++) {
			performRandomModification(i, seed++);

			expect(capturedDiffsMap["0-1"]).toBeDefined();
			expect(capturedDiffsMap["1-2"]).toBeDefined();

			// Catch-and-Restore: Again, verify that we can return to a perfect state.
			act(() => {
				entry.props.onChange?.(baselineText);
			});
			waitForDebounce();
			expect(capturedDiffsMap["0-1"]).toEqual(baselineLr);
			expect(capturedDiffsMap["1-2"]).toEqual(baselineRm);
		}
	});

	it("kills mutants by clearing and restoring", () => {
		render(<App />);
		const { realDiffs: baselineDiffs, mergedText: baselineText } =
			loadTestData();
		const baselineLr = JSON.parse(JSON.stringify(baselineDiffs[0]));
		const baselineRm = JSON.parse(JSON.stringify(baselineDiffs[1]));

		const entry = capturedEditors.find((e) => e.mock === mergedEditorMock);
		if (!entry) {
			throw new Error("Merged editor not found");
		}

		// Clear the document
		act(() => {
			entry.props.onChange?.("");
		});
		waitForDebounce();

		// Verify clearing changed the diffs (mutant killer)
		expect(capturedDiffsMap["0-1"]).not.toEqual(baselineLr);

		// Restore and verify
		act(() => {
			entry.props.onChange?.(baselineText);
		});
		waitForDebounce();
		expect(capturedDiffsMap["0-1"]).toEqual(baselineLr);
		expect(capturedDiffsMap["1-2"]).toEqual(baselineRm);
	});
});
