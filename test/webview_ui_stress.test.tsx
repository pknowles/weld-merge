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
	iteration: number,
	entry: { props: MockedEditorProps; mock: MockEditor } | undefined,
	seed: number,
) => {
	switch (action) {
		case 0:
			fireEvent.click(screen.getByTestId("toggle-base-left"));
			break;
		case 1:
			fireEvent.click(screen.getByTestId("toggle-base-right"));
			break;
		case 2:
			{
				const lines = mergedEditorMock?.getValue().split("\n") || [];
				const lineIdx = Math.floor(random(seed) * lines.length);
				lines[lineIdx] = `Fuzzed ${iteration}: ${lines[lineIdx]}`;
				entry?.props.onChange?.(lines.join("\n"));
			}
			break;
		case 3:
		case 4:
		case 5:
			{
				const titles = ["Push", "Delete", "Copy up"];
				const title = titles[action - 3];
				if (title) {
					const btns = screen.queryAllByTitle(title);
					if (btns.length > 0) {
						const btn =
							btns[Math.floor(random(seed) * btns.length)];
						if (btn) {
							fireEvent.click(btn);
						}
					}
				}
			}
			break;
		default:
			break;
	}
};

const performRandomAction = (iteration: number, seed: number) => {
	if (!mergedEditorMock) {
		return;
	}
	const entry = capturedEditors.find((e) => e.mock === mergedEditorMock);
	const action = Math.floor(random(seed) * 6);

	act(() => {
		dispatchAction(action, iteration, entry, seed);
	});
	waitForDebounce();
};

const loadTestData = (
	local = "SAFE\nL2\nSAME\nL4\nSAME",
	base = "SAME\nB2\nSAME\nB4\nSAME",
	remote = "SAME\nB2\nSAME\nR4\nSAME",
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
};

describe("Webview UI Stress Test - Basic", () => {
	let seed = 123;

	beforeEach(() => {
		jest.useFakeTimers();
		capturedEditors.length = 0;
		for (const k of Object.keys(capturedDiffsMap)) {
			delete capturedDiffsMap[k];
		}
		mergedEditorMock = null;
		seed = 123;
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("performs 50 seeded pseudo-random interactions (smoke test)", () => {
		render(<App />);
		loadTestData();

		for (let i = 0; i < 50; i++) {
			performRandomAction(i, seed++);
			expect(capturedDiffsMap["0-1"]).toBeDefined();
			expect(capturedDiffsMap["1-2"]).toBeDefined();
		}
	});

	it("verifies reversion to baseline after randomized interactions", () => {
		render(<App />);
		loadTestData();
		if (!mergedEditorMock) {
			throw new Error("Could not find Merged editor mock");
		}
		const baselineLr = JSON.parse(
			JSON.stringify(capturedDiffsMap["0-1"] || []),
		);
		const baselineRm = JSON.parse(
			JSON.stringify(capturedDiffsMap["1-2"] || []),
		);
		const baselineText = mergedEditorMock.getValue();
		for (let i = 0; i < 50; i++) {
			const entry = capturedEditors.find(
				(e) => e.mock === mergedEditorMock,
			);
			performRandomAction(i, seed++);
			act(() => {
				entry?.props.onChange?.(baselineText);
			});
			waitForDebounce();
			expect(capturedDiffsMap["0-1"]).toEqual(baselineLr);
			expect(capturedDiffsMap["1-2"]).toEqual(baselineRm);
		}
	});
});

const TRANSFORM_DATA = {
	local: [
		"Same 1",
		"Added L 1",
		"Same 2",
		"Modified Local",
		"Same 3",
		"To be restored",
		"Same 4",
	].join("\n"),
	base: [
		"Same 1",
		"Base line",
		"Same 2",
		"Modified Base",
		"Same 3",
		"Same 4",
	].join("\n"),
	remote: [
		"Same 1",
		"Base line",
		"Same 2",
		"Modified Base",
		"Same 3",
		"Same 4",
	].join("\n"),
};

const setupTransformTest = () => {
	render(<App />);
	loadTestData(
		TRANSFORM_DATA.local,
		TRANSFORM_DATA.base,
		TRANSFORM_DATA.remote,
	);
	const entry = capturedEditors.find((e) => e.mock === mergedEditorMock);
	if (!entry || mergedEditorMock === null) {
		throw new Error("No editor found");
	}
	const originalLr = JSON.parse(
		JSON.stringify(capturedDiffsMap["0-1"] || []),
	);
	const originalRm = JSON.parse(
		JSON.stringify(capturedDiffsMap["1-2"] || []),
	);
	return {
		entry,
		originalLr,
		originalRm,
		baselineText: mergedEditorMock.getValue(),
	};
};

describe("Webview UI Stress - Transformations 1", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		capturedEditors.length = 0;
		for (const k of Object.keys(capturedDiffsMap)) {
			delete capturedDiffsMap[k];
		}
		mergedEditorMock = null;
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("verifies insertions and replacements", () => {
		const { entry, originalLr, originalRm, baselineText } =
			setupTransformTest();

		for (const chunk of originalLr.filter(
			(c: DiffChunk) => c.tag === "insert",
		)) {
			act(() => {
				if (mergedEditorMock) {
					const lines = mergedEditorMock.getValue().split("\n");
					if (lines[chunk.startB]) {
						lines[chunk.startB] =
							`Fuzzed Insert: ${lines[chunk.startB]}`;
						entry.props.onChange?.(lines.join("\n"));
					}
				}
			});
			waitForDebounce();
			expect(
				capturedDiffsMap["0-1"]?.some(
					(c: DiffChunk) =>
						c.startB <= chunk.startB && c.endB >= chunk.startB,
				),
			).toBe(true);
			act(() => {
				entry.props.onChange?.(baselineText);
			});
			waitForDebounce();
			expect(capturedDiffsMap["0-1"]).toEqual(originalLr);
			expect(capturedDiffsMap["1-2"]).toEqual(originalRm);
		}

		for (const chunk of originalLr.filter(
			(c: DiffChunk) => c.tag === "replace",
		)) {
			act(() => {
				if (mergedEditorMock) {
					const lines = mergedEditorMock.getValue().split("\n");
					for (let i = chunk.startB; i < chunk.endB; i++) {
						lines[i] = "Induced Conflict Content";
					}
					entry.props.onChange?.(lines.join("\n"));
				}
			});
			waitForDebounce();
			const chunkNow = capturedDiffsMap["0-1"]?.find(
				(c: DiffChunk) => c.startB === chunk.startB,
			);
			expect(chunkNow).toBeDefined();
			expect(chunkNow?.tag).not.toBe("equal");
			act(() => {
				entry.props.onChange?.(baselineText);
			});
			waitForDebounce();
			expect(capturedDiffsMap["0-1"]).toEqual(originalLr);
		}
	});
});

describe("Webview UI Stress - Transformations 2", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		capturedEditors.length = 0;
		for (const k of Object.keys(capturedDiffsMap)) {
			delete capturedDiffsMap[k];
		}
		mergedEditorMock = null;
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("verifies deletions and wipeout", () => {
		const { entry, originalLr, originalRm, baselineText } =
			setupTransformTest();

		for (const chunk of originalLr.filter(
			(c: DiffChunk) => c.tag === "delete",
		)) {
			act(() => {
				if (mergedEditorMock) {
					const lines = mergedEditorMock.getValue().split("\n");
					const restoredLines = TRANSFORM_DATA.local
						.split("\n")
						.slice(chunk.startA, chunk.endA);
					lines.splice(chunk.startB, 0, ...restoredLines);
					entry.props.onChange?.(lines.join("\n"));
				}
			});
			waitForDebounce();
			expect(
				capturedDiffsMap["0-1"]?.some(
					(c: DiffChunk) =>
						c.tag === "delete" &&
						c.startA === chunk.startA &&
						c.endA === chunk.endA,
				),
			).toBe(false);
			act(() => {
				entry.props.onChange?.(baselineText);
			});
			waitForDebounce();
			expect(capturedDiffsMap["0-1"]).toEqual(originalLr);
		}

		act(() => {
			entry.props.onChange?.("");
		});
		waitForDebounce();
		expect(capturedDiffsMap["0-1"]?.some((c) => c.tag !== "equal")).toBe(
			true,
		);
		act(() => {
			entry.props.onChange?.(baselineText);
		});
		waitForDebounce();
		expect(capturedDiffsMap["0-1"]).toEqual(originalLr);
		expect(capturedDiffsMap["1-2"]).toEqual(originalRm);
	});
});
