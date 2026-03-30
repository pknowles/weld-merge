import { jest } from "@jest/globals";
import { act, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { Differ } from "../src/matchers/diffutil.ts";
import { Merger } from "../src/matchers/merge.ts";
import { App } from "../src/webview/ui/App.tsx";
import { createMockEditor } from "./mockEditor.ts";

jest.mock("monaco-editor", () => {
	const mock = {} as unknown as typeof import("monaco-editor");
	const mockEditor = {} as unknown as typeof import("monaco-editor").editor;
	Object.defineProperty(mock, "editor", { value: mockEditor });
	Object.defineProperty(mockEditor, "EditorOption", {
		value: { lineHeight: 1, readOnly: 1 },
	});
	Object.defineProperty(mock, "Selection", {
		value: { createWithSelection: () => ({}) },
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
	Object.defineProperty(mockEditor, "IStandaloneCodeEditor", { value: {} });
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

const vscode = {
	postMessage: jest.fn(() => {
		/* mock */
	}),
	getState: jest.fn(() => ({})),
	setState: jest.fn(() => {
		/* mock */
	}),
};
(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () =>
	vscode;

const mountedEditors: ReturnType<typeof createMockEditor>[] = [];

jest.mock(
	"@monaco-editor/react",
	() =>
		(props: {
			onMount?: (ed: ReturnType<typeof createMockEditor>) => void;
			value?: string;
			defaultValue?: string;
		}) => {
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

const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const runMerger = (local: string, base: string, remote: string) => {
	const localLines = splitLines(local);
	const baseLines = splitLines(base);
	const remoteLines = splitLines(remote);

	const merger = new Merger();
	const initGen = merger.initialize(
		[localLines, baseLines, remoteLines],
		[localLines, baseLines, remoteLines],
	);
	let resInit = initGen.next();
	while (!resInit.done) {
		resInit = initGen.next();
	}

	const mergeGen = merger.merge3Files(true);
	let mergedContent = base;
	let resMerge = mergeGen.next();
	while (!resMerge.done) {
		if (resMerge.value !== null && typeof resMerge.value === "string") {
			mergedContent = resMerge.value;
		}
		resMerge = mergeGen.next();
	}
	if (
		resMerge.value !== null &&
		resMerge.value !== undefined &&
		typeof resMerge.value === "string"
	) {
		mergedContent = resMerge.value;
	}
	return mergedContent;
};

describe("Webview User Requested Test Cases", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mountedEditors.length = 0;
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("verifies auto-merge output for first test case (L547-610)", () => {
		const local =
			"# Weld-Merge\n\nThis is the local content\n\n# 1\n\n# 2\n\nReplaced\n\n# 3\n\nLocal changes\n\n# 4\n\n# 5\n\nLocal replaced";
		const base =
			"# Weld-Merge\n\nThis is the base content\n\n# 1\n\nBoth will delete this\n\n# 2\n\nBoth will replace this with the same thing\n\n# 3\n\nBoth will replace this with different things\n\n# 4\n\nLocal removes this and remote replaces it\n\n# 5\n\nRemote removes this and local replaces it";
		const remote =
			"# Weld-Merge\n\nThis is the remote content\n\n# 1\n\n# 2\n\nReplaced\n\n# 3\n\nRemote changes\n\n# 4\n\nRemote replaced\n\n# 5";

		const expectedOutput =
			"# Weld-Merge\n\n(??)This is the base content\n\n# 1\n\n# 2\n\nReplaced\n\n# 3\n\n(??)Both will replace this with different things\n\n# 4\n\n(??)Local removes this and remote replaces it\n(??)\n# 5\n(??)\n(??)Remote removes this and local replaces it";

		const mergedContent = runMerger(local, base, remote);

		const localLines = splitLines(local);
		const remoteLines = splitLines(remote);
		const mergedLines = splitLines(mergedContent);

		const differ = new Differ();
		const diffInit = differ.setSequencesIter([
			localLines,
			mergedLines,
			remoteLines,
		]);
		let resDiff = diffInit.next();
		while (!resDiff.done) {
			resDiff = diffInit.next();
		}

		const leftDiffs = differ._mergeCache
			.map((p) => p[0])
			.filter((c) => c !== null);
		const rightDiffs = differ._mergeCache
			.map((p) => p[1])
			.filter((c) => c !== null);

		render(<App />);

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						command: "loadDiff",
						data: {
							files: [
								{ label: "Local", content: local },
								{ label: "Merged", content: mergedContent },
								{ label: "Remote", content: remote },
							],
							diffs: [leftDiffs, rightDiffs],
						},
					},
					origin: "*",
				}),
			);
		});

		act(() => {
			jest.advanceTimersByTime(500);
		});

		const mergedEditor = mountedEditors[1];
		expect(mergedEditor?.getValue()).toBe(expectedOutput);

		// Symmetry test: flipping local and remote should produce identical results
		const flippedMergedContent = runMerger(remote, base, local);
		expect(flippedMergedContent).toBe(mergedContent);
	});

	it("verifies auto-merge output for second test case (L612-692)", () => {
		const local = `# Weld-Merge

This is the local content

# 1

# 2

Replaced

# 3

Local changes

# 4

# 5

Local replaced

# 6

Both will add lines below
Local addition`;
		const base =
			"# Weld-Merge\n\nThis is the base content\n\n# 1\n\nBoth will delete this\n\n# 2\n\nBoth will replace this with the same thing\n\n# 3\n\nBoth will replace this with different things\n\n# 4\n\nLocal removes this and remote replaces it\n\n# 5\n\nRemote removes this and local replaces it\n\n# 6\n\nBoth will add lines below";
		const remote =
			"# Weld-Merge\n\nThis is the remote content\n\n# 1\n\n# 2\n\nReplaced\n\n# 3\n\nRemote changes\n\n# 4\n\nRemote replaced\n\n# 5\n\n# 6\n\nBoth will add lines below\nRemote addition";

		const expectedOutput = `# Weld-Merge

(??)This is the base content

# 1

# 2

Replaced

# 3

(??)Both will replace this with different things

# 4

(??)Local removes this and remote replaces it
(??)
# 5

(??)Remote removes this and local replaces it
(??)
# 6

Both will add lines below
(??)`;

		const mergedContent = runMerger(local, base, remote);
		expect(mergedContent).toBe(expectedOutput);

		// Verify symmetry here too
		const flippedMergedContent = runMerger(remote, base, local);
		expect(flippedMergedContent).toBe(mergedContent);
	});
});
