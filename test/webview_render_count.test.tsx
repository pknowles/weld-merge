import { afterEach, beforeEach, describe, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
	createMonacoMock,
	createMonacoReactMockComponent,
	createVscodeStub,
	installResizeObserverMock,
	installVscodeApi,
	mountedEditors,
	resetMountedEditors,
	uninstallVscodeApi,
} from "./mockMonacoSetup.tsx";
import { createRenderCounter } from "./renderCounter.tsx";

// TODO: seems flaky - has to be after mockMonacoSetup.tsx. Why?
import { App } from "../src/webview/ui/App.tsx";

// Baselines captured today. These are strict upper bounds: if a change makes
// the numbers smaller, lower the constant in the same commit. If a change
// makes them larger, that is a regression and should be justified or fixed
// before merge. See the "useEffect cleanup" section in TODO.md for context on
// the planned renderTrigger removal and when to ratchet these down.
//
// Observed today:
//   mount + loadDiff -> 5 commits: [mount, update, update, update, nested-update]
//   single user edit -> 1 commit:  [update]
const EXPECTED_MAX_RENDERS_AFTER_LOAD = 5;
const EXPECTED_MAX_NESTED_UPDATES_AFTER_LOAD = 1;
const EXPECTED_MAX_RENDERS_PER_USER_EDIT = 1;
const EXPECTED_MAX_RENDERS_FOR_FULL_SYNC = 0;
const EXPECTED_MAX_RENDERS_FOR_BASE_TOGGLE = 5;
const EXPECTED_MAX_RENDERS_FOR_CHUNK_ACTION = 3;

jest.mock("monaco-editor", () => createMonacoMock());
jest.mock("@monaco-editor/react", () => createMonacoReactMockComponent());

installResizeObserverMock();
installVscodeApi(createVscodeStub());

interface TestEditor {
	executeEdits: (
		source: string | null | undefined,
		edits: Array<{
			range: {
				startLineNumber: number;
				startColumn: number;
				endLineNumber: number;
				endColumn: number;
			};
			text: string;
		}>,
	) => void;
	getValue: () => string;
}

type ChunkAction = "Push" | "Copy Up" | "Copy Down" | "Delete";
type ChunkSide = "left" | "right";

const dispatchLoadDiff = async () => {
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: "line 1\nline 2" },
							{ label: "Merged", content: "line 1\nline 2" },
							{ label: "Remote", content: "line 1\nline 2" },
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

const dispatchChunkLoadDiff = async (
	action: ChunkAction,
	side: ChunkSide,
): Promise<void> => {
	const local =
		action === "Push" || action === "Copy Down" ? "L1\nL2" : "A\nB";
	const base = "A\nB";
	const remote =
		action === "Copy Up" || action === "Delete" ? "R1\nR2" : "A\nB";
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: local },
							{ label: "Base/Merged", content: base },
							{ label: "Remote", content: remote },
						],
						diffs: [
							side === "left"
								? [
										{
											tag: "replace",
											startA: 0,
											endA: 1,
											startB: 0,
											endB: 1,
										},
									]
								: [],
							side === "right"
								? [
										{
											tag: "replace",
											startA: 0,
											endA: 1,
											startB: 0,
											endB: 1,
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
};

const dispatchFullSync = async (content: string): Promise<void> => {
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "fullSync",
					content,
					lastExternalChangeVersion: 2,
				},
				origin: "*",
			}),
		);
	});
	await act(() => {
		jest.advanceTimersByTime(100);
	});
};

const dispatchBaseDiff = async (side: "left" | "right"): Promise<void> => {
	await act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					command: "loadBaseDiff",
					data: {
						side,
						file: {
							label: side === "left" ? "Base (L)" : "Base (R)",
							content: side === "left" ? "BL" : "BR",
						},
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
};

const getMergedEditor = (): TestEditor => {
	const merged = mountedEditors.find(
		(e) => e.props.options?.readOnly === false,
	)?.mock as unknown as TestEditor | undefined;
	if (!merged) {
		throw new Error("Expected to find a mounted editable (merged) editor");
	}
	return merged;
};

const clickChunkActionButton = async (action: ChunkAction): Promise<void> => {
	let buttons = screen.queryAllByRole("button");
	let actionButtons = buttons.filter(
		(button) => button.getAttribute("title") === action,
	);
	if (actionButtons.length === 0) {
		await act(() => {
			for (let i = 0; i < 5; i++) {
				jest.advanceTimersByTime(100);
			}
		});
		buttons = screen.queryAllByRole("button");
		actionButtons = buttons.filter(
			(button) => button.getAttribute("title") === action,
		);
	}
	if (actionButtons.length === 0) {
		throw new Error(`Expected to find chunk action button '${action}'`);
	}
	const firstButton = actionButtons[0];
	if (!firstButton) {
		throw new Error(
			`Expected to find first chunk action button '${action}'`,
		);
	}
	await act(() => {
		fireEvent.click(firstButton);
	});
};

const getRenderStats = (
	counter: ReturnType<typeof createRenderCounter>,
): { count: number; nestedCount: number } => {
	const count = counter.getCount();
	const nestedCount = counter
		.getPhases()
		.filter((phase) => phase === "nested-update").length;
	return { count, nestedCount };
};

describe("Webview Render Count - baseline ratchet", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		resetMountedEditors();
	});

	afterEach(() => {
		uninstallVscodeApi();
		jest.useRealTimers();
	});

	it("mount + loadDiff stays under the baseline", async () => {
		const counter = createRenderCounter("App");
		render(counter.wrap(<App />));
		await dispatchLoadDiff();
		const { count, nestedCount } = getRenderStats(counter);
		expect(count).toBeLessThanOrEqual(EXPECTED_MAX_RENDERS_AFTER_LOAD);
		expect(count).toBeGreaterThan(0);
		expect(nestedCount).toBeLessThanOrEqual(
			EXPECTED_MAX_NESTED_UPDATES_AFTER_LOAD,
		);
	});

	it("a single user edit in the merged pane stays under the per-edit baseline", async () => {
		const counter = createRenderCounter("App");
		render(counter.wrap(<App />));
		await dispatchLoadDiff();
		const merged = getMergedEditor();
		counter.reset();
		await act(() => {
			merged.executeEdits("user", [
				{
					range: {
						startLineNumber: 1,
						startColumn: 1,
						endLineNumber: 1,
						endColumn: 1,
					},
					text: "X",
				},
			]);
		});
		await act(() => {
			jest.advanceTimersByTime(50);
		});

		const { count } = getRenderStats(counter);
		expect(count).toBeLessThanOrEqual(EXPECTED_MAX_RENDERS_PER_USER_EDIT);
		expect(count).toBeGreaterThan(0);
	});

	it("fullSync replacement stays within the external-sync baseline", async () => {
		const counter = createRenderCounter("App");
		render(counter.wrap(<App />));
		await dispatchLoadDiff();
		counter.reset();
		await dispatchFullSync("replaced\ncontent\nfrom\nextension");
		const { count } = getRenderStats(counter);
		expect(count).toBeLessThanOrEqual(EXPECTED_MAX_RENDERS_FOR_FULL_SYNC);
	});

	it("compare-with-base toggle+load stays within baseline", async () => {
		const counter = createRenderCounter("App");
		render(counter.wrap(<App />));
		await dispatchLoadDiff();
		counter.reset();
		await act(() => {
			fireEvent.click(screen.getByTestId("toggle-base-left"));
		});
		await dispatchBaseDiff("left");
		const { count } = getRenderStats(counter);
		expect(count).toBeLessThanOrEqual(EXPECTED_MAX_RENDERS_FOR_BASE_TOGGLE);
		expect(count).toBeGreaterThan(0);
	});
});

// TODO: Render-count tests for Monaco layout/scroll events require real Monaco
// integration tests (test/vscode/ suite), not mocked unit tests. The mock can't
// meaningfully simulate Monaco's actual onDidLayoutChange / onDidScrollChange
// behavior — any attempt just tests mock behavior, not real code paths.
// Scenarios to add in integration tests:
//   - Layout change after window resize (triggers setRenderTrigger cascade)
//   - Scroll burst across panes (triggers sync-scroll + renderTrigger storm)
// See TODO.md "Cull unnecessary useEffects" for context on renderTrigger removal.

describe("Webview Render Count - chunk action permutations", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		resetMountedEditors();
	});

	afterEach(() => {
		uninstallVscodeApi();
		jest.useRealTimers();
	});

	it.each([
		{ action: "Push" as const, side: "left" as const },
		{ action: "Copy Down" as const, side: "left" as const },
		{ action: "Copy Up" as const, side: "right" as const },
		{ action: "Delete" as const, side: "right" as const },
	])("chunk action '$action' on $side stays within baseline", async ({
		action,
		side,
	}) => {
		const counter = createRenderCounter("App");
		render(counter.wrap(<App />));
		await dispatchChunkLoadDiff(action, side);
		counter.reset();
		await clickChunkActionButton(action);
		const { count } = getRenderStats(counter);
		expect(count).toBeLessThanOrEqual(
			EXPECTED_MAX_RENDERS_FOR_CHUNK_ACTION,
		);
		expect(count).toBeGreaterThan(0);
	});
});
