// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { jest } from "@jest/globals";
import {
	classifyDocumentChange,
	type EditState,
	processContentChanged,
} from "../src/webview/editorSync.ts";
import type { MonacoContentChange } from "../src/webview/ui/types.ts";

interface FullSyncMessage {
	command: "fullSync";
	content: string;
	lastExternalChangeVersion: number;
}

interface ExternalEditMessage {
	command: "externalEdit";
	changes: MonacoContentChange[];
	lastExternalChangeVersion: number;
}

type HarnessMessage = FullSyncMessage | ExternalEditMessage;

interface QueueEditOptions {
	msgVersion?: number;
	delayMs?: number;
	onApply?: () => void;
	injectExternalDuringApply?: MonacoContentChange;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function positionToIndex(
	content: string,
	lineNumber: number,
	column: number,
): number {
	const lines = content.split("\n");
	let index = 0;
	for (let i = 1; i < lineNumber; i++) {
		index += lines[i - 1]?.length ?? 0;
		index += 1;
	}
	return index + column - 1;
}

function applyChange(content: string, change: MonacoContentChange): string {
	const start = positionToIndex(
		content,
		change.range.startLineNumber,
		change.range.startColumn,
	);
	const end = positionToIndex(
		content,
		change.range.endLineNumber,
		change.range.endColumn,
	);
	return `${content.slice(0, start)}${change.text}${content.slice(end)}`;
}

function insertAtColumn(column: number, text: string): MonacoContentChange {
	return {
		range: {
			startLineNumber: 1,
			startColumn: column,
			endLineNumber: 1,
			endColumn: column,
		},
		text,
	};
}

function createPrng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_00_00_00_00;
	};
}

interface SaveRecord {
	source: "webview" | "external";
	content: string;
}

class DocumentSyncHarness {
	readonly sentMessages: HarnessMessage[] = [];
	readonly savedContents: string[] = [];
	readonly saveLog: SaveRecord[] = [];
	readonly applyOrder: number[] = [];
	documentContent: string;
	documentVersion = 0;
	readonly editState: EditState = {
		editQueue: Promise.resolve(),
		lastExternalChangeVersion: 0,
		versionBeforeEdit: undefined,
	};
	private readonly inFlight: Promise<void>[] = [];

	constructor(initialContent = "") {
		this.documentContent = initialContent;
	}

	queueWebviewEdit(
		change: MonacoContentChange,
		options: QueueEditOptions = {},
	): void {
		const promise = this.editState.editQueue.then(() =>
			this.runContentChanged(change, options),
		);
		this.editState.editQueue = promise;
		this.inFlight.push(promise);
	}

	queueWebviewEditWithoutChaining(
		change: MonacoContentChange,
		options: QueueEditOptions = {},
	): void {
		const promise = this.runContentChanged(change, options);
		this.editState.editQueue = promise;
		this.inFlight.push(promise);
	}

	queueSave(): void {
		// Mirrors the "save" message handler in meldWebviewPanel.ts: the save is
		// appended to the editQueue so it only runs after any pending edits.
		const promise = this.editState.editQueue.then(() => {
			this.savedContents.push(this.documentContent);
			this.saveLog.push({
				source: "webview",
				content: this.documentContent,
			});
		});
		this.editState.editQueue = promise;
		this.inFlight.push(promise);
	}

	// Simulates VS Code persisting the document outside our code path, e.g. File
	// > Save or another extension calling document.save() directly. Because we
	// removed onWillSaveTextDocument, our sync code never runs for this path; it
	// must not leave behind state that accidentally double-saves when our own
	// queued save later fires.
	saveExternallyNow(): void {
		this.saveLog.push({
			source: "external",
			content: this.documentContent,
		});
	}

	simulateExternalEdit(change: MonacoContentChange): void {
		this.documentContent = applyChange(this.documentContent, change);
		this.documentVersion += 1;
		this.handleDocumentChanged(this.documentVersion, [change]);
	}

	async drain(): Promise<void> {
		const results = await Promise.allSettled(this.inFlight);
		const rejected = results.find((result) => result.status === "rejected");
		if (rejected?.status === "rejected") {
			throw rejected.reason;
		}
	}

	private async runContentChanged(
		change: MonacoContentChange,
		options: QueueEditOptions,
	): Promise<void> {
		const {
			msgVersion = this.editState.lastExternalChangeVersion,
			delayMs = 0,
			onApply,
			injectExternalDuringApply,
		} = options;
		await processContentChanged({
			changes: [change],
			msgVersion,
			editState: this.editState,
			currentDocumentVersion: this.documentVersion,
			applyEdit: async (changes) => {
				onApply?.();
				if (injectExternalDuringApply) {
					this.simulateExternalEdit(injectExternalDuringApply);
				}
				if (delayMs > 0) {
					await sleep(delayMs);
				}
				for (const item of changes) {
					this.documentContent = applyChange(
						this.documentContent,
						item,
					);
				}
				this.documentVersion += 1;
				this.handleDocumentChanged(this.documentVersion, changes);
			},
			postFullSync: () => {
				this.sentMessages.push({
					command: "fullSync",
					content: this.documentContent,
					lastExternalChangeVersion:
						this.editState.lastExternalChangeVersion,
				});
			},
		});
	}

	private handleDocumentChanged(
		newVersion: number,
		changes: MonacoContentChange[],
	): void {
		const action = classifyDocumentChange(newVersion, this.editState);
		if (action === "suppress") {
			return;
		}
		this.editState.lastExternalChangeVersion = newVersion;
		if (action === "fullSync") {
			this.sentMessages.push({
				command: "fullSync",
				content: this.documentContent,
				lastExternalChangeVersion:
					this.editState.lastExternalChangeVersion,
			});
			return;
		}
		this.sentMessages.push({
			command: "externalEdit",
			changes,
			lastExternalChangeVersion: this.editState.lastExternalChangeVersion,
		});
	}
}

describe("classifyDocumentChange matrix", () => {
	const baseState = (): EditState => ({
		editQueue: Promise.resolve(),
		lastExternalChangeVersion: 10,
		versionBeforeEdit: undefined,
	});

	it.each([
		{ versionBeforeEdit: 10, newVersion: 11, expected: "suppress" },
		{ versionBeforeEdit: 10, newVersion: 12, expected: "fullSync" },
		{ versionBeforeEdit: 10, newVersion: 99, expected: "fullSync" },
		{
			versionBeforeEdit: undefined,
			newVersion: 11,
			expected: "externalEdit",
		},
		{
			versionBeforeEdit: undefined,
			newVersion: 50,
			expected: "externalEdit",
		},
	])("returns $expected for versionBeforeEdit=$versionBeforeEdit newVersion=$newVersion", ({
		versionBeforeEdit,
		newVersion,
		expected,
	}) => {
		const state = baseState();
		state.versionBeforeEdit = versionBeforeEdit;
		expect(classifyDocumentChange(newVersion, state)).toBe(expected);
	});
});

describe("processContentChanged behavior", () => {
	it("rejects stale messages via fullSync callback", async () => {
		const editState: EditState = {
			editQueue: Promise.resolve(),
			lastExternalChangeVersion: 10,
			versionBeforeEdit: undefined,
		};
		const applyEdit = jest.fn((): Promise<void> => Promise.resolve());
		const postFullSync = jest.fn();
		await processContentChanged({
			changes: [],
			msgVersion: 9,
			editState,
			currentDocumentVersion: 10,
			applyEdit,
			postFullSync,
		});
		expect(postFullSync).toHaveBeenCalledTimes(1);
		expect(applyEdit).not.toHaveBeenCalled();
	});

	it("applies fresh messages and clears versionBeforeEdit", async () => {
		const editState: EditState = {
			editQueue: Promise.resolve(),
			lastExternalChangeVersion: 10,
			versionBeforeEdit: undefined,
		};
		let capturedVersionBeforeEdit: number | undefined;
		await processContentChanged({
			changes: [],
			msgVersion: 10,
			editState,
			currentDocumentVersion: 42,
			applyEdit: (): Promise<void> => {
				capturedVersionBeforeEdit = editState.versionBeforeEdit;
				return Promise.resolve();
			},
			postFullSync: () => {
				throw new Error("postFullSync should not be called");
			},
		});
		expect(capturedVersionBeforeEdit).toBe(42);
		expect(editState.versionBeforeEdit).toBeUndefined();
	});
});

describe("DocumentSyncHarness queue and ordering", () => {
	it.each([
		2, 5, 10, 25, 50,
	])("handles burst of %d webview edits without false fullSync", async (count) => {
		const harness = new DocumentSyncHarness("");
		for (let i = 0; i < count; i++) {
			harness.queueWebviewEdit(insertAtColumn(i + 1, "x"));
		}
		await harness.drain();
		const fullSyncs = harness.sentMessages.filter(
			(message) => message.command === "fullSync",
		);
		expect(fullSyncs).toHaveLength(0);
		expect(harness.documentContent).toBe("x".repeat(count));
	});

	it("preserves FIFO apply order despite varied delays", async () => {
		const harness = new DocumentSyncHarness("");
		const delays = [30, 1, 20, 5];
		for (let i = 0; i < delays.length; i++) {
			const delay = delays[i];
			if (delay === undefined) {
				throw new Error(`Expected delay at index ${i}`);
			}
			harness.queueWebviewEdit(insertAtColumn(i + 1, "x"), {
				delayMs: delay,
				onApply: () => {
					harness.applyOrder.push(i);
				},
			});
		}
		await harness.drain();
		expect(harness.applyOrder).toEqual([0, 1, 2, 3]);
		expect(harness.documentContent).toBe("xxxx");
	});

	it.each([
		{ before: 1, after: 0 },
		{ before: 2, after: 1 },
		{ before: 5, after: 5 },
		{ before: 0, after: 4 },
	])("saves in-order with before=$before after=$after", async ({
		before,
		after,
	}) => {
		const harness = new DocumentSyncHarness("");
		let column = 1;
		for (let i = 0; i < before; i++) {
			harness.queueWebviewEdit(insertAtColumn(column, "x"));
			column += 1;
		}
		harness.queueSave();
		for (let i = 0; i < after; i++) {
			harness.queueWebviewEdit(insertAtColumn(column, "x"));
			column += 1;
		}
		await harness.drain();
		expect(harness.savedContents).toEqual(["x".repeat(before)]);
		expect(harness.documentContent).toBe("x".repeat(before + after));
	});
});

describe("staleness and external edit flow", () => {
	it("rejects stale webview edit after external change", async () => {
		const harness = new DocumentSyncHarness("");
		harness.simulateExternalEdit(insertAtColumn(1, "E"));
		harness.queueWebviewEdit(insertAtColumn(1, "W"), {
			msgVersion: 0,
		});
		await harness.drain();
		const fullSyncs = harness.sentMessages.filter(
			(message) => message.command === "fullSync",
		);
		expect(fullSyncs.length).toBeGreaterThanOrEqual(1);
		expect(harness.documentContent).toBe("E");
	});

	it("forwards external edit when not mid-apply", () => {
		const harness = new DocumentSyncHarness("");
		harness.simulateExternalEdit(insertAtColumn(1, "E"));
		const lastMessage = harness.sentMessages.at(-1);
		expect(lastMessage?.command).toBe("externalEdit");
		expect(harness.editState.lastExternalChangeVersion).toBe(1);
		expect(harness.documentContent).toBe("E");
	});

	it("sends fullSync when external change interleaves during apply", async () => {
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "W"), {
			injectExternalDuringApply: insertAtColumn(1, "E"),
		});
		await harness.drain();
		const fullSyncs = harness.sentMessages.filter(
			(message) => message.command === "fullSync",
		);
		expect(fullSyncs.length).toBeGreaterThanOrEqual(1);
		expect(harness.documentContent).toContain("E");
		expect(harness.documentContent).toContain("W");
	});
});

describe("targeted regressions", () => {
	it("does not trigger false fullSync for two rapid edits when chained", async () => {
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "x"), {
			delayMs: 20,
			msgVersion: 0,
		});
		harness.queueWebviewEdit(insertAtColumn(2, "x"), {
			delayMs: 1,
			msgVersion: 0,
		});
		await harness.drain();
		const fullSyncs = harness.sentMessages.filter(
			(message) => message.command === "fullSync",
		);
		expect(fullSyncs).toHaveLength(0);
		expect(harness.documentContent).toBe("xx");
	});

	it("reproduces spurious webview message when editQueue chaining is removed", async () => {
		// Without .then() chaining, both contentChanged handlers run in parallel.
		// The faster edit completes and clears versionBeforeEdit while the slower
		// edit is still awaiting applyEdit. When the slower edit finally resolves,
		// its onDidChangeTextDocument event sees versionBeforeEdit=undefined and
		// misclassifies the echo as an external change. The symptom is a spurious
		// externalEdit (not fullSync) being sent back to the webview — which in
		// the real extension causes Monaco to re-apply its own edit and manifests
		// as cursor jumps during rapid typing.
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEditWithoutChaining(insertAtColumn(1, "x"), {
			delayMs: 20,
			msgVersion: 0,
		});
		harness.queueWebviewEditWithoutChaining(insertAtColumn(2, "x"), {
			delayMs: 1,
			msgVersion: 0,
		});
		await harness.drain();
		expect(harness.sentMessages.length).toBeGreaterThanOrEqual(1);
	});
});

describe("invariants and deterministic stress", () => {
	it("keeps versionBeforeEdit undefined after mixed operations drain", async () => {
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "x"));
		harness.queueSave();
		harness.simulateExternalEdit(insertAtColumn(1, "E"));
		harness.queueWebviewEdit(insertAtColumn(3, "x"));
		await harness.drain();
		expect(harness.editState.versionBeforeEdit).toBeUndefined();
	});

	it("keeps lastExternalChangeVersion monotonic", async () => {
		const harness = new DocumentSyncHarness("");
		let maxSeen = harness.editState.lastExternalChangeVersion;
		const verifyMonotonic = () => {
			expect(
				harness.editState.lastExternalChangeVersion,
			).toBeGreaterThanOrEqual(maxSeen);
			maxSeen = harness.editState.lastExternalChangeVersion;
		};
		harness.queueWebviewEdit(insertAtColumn(1, "x"));
		await harness.drain();
		verifyMonotonic();
		harness.simulateExternalEdit(insertAtColumn(1, "E"));
		verifyMonotonic();
		harness.queueWebviewEdit(insertAtColumn(3, "x"));
		await harness.drain();
		verifyMonotonic();
	});
});

describe("save deduplication", () => {
	it("single webview save persists exactly once", async () => {
		const harness = new DocumentSyncHarness("hello");
		harness.queueSave();
		await harness.drain();
		expect(harness.saveLog).toEqual([
			{ source: "webview", content: "hello" },
		]);
	});

	it("webview save with surrounding edits persists once at queue point", async () => {
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "a"));
		harness.queueWebviewEdit(insertAtColumn(2, "b"));
		harness.queueSave();
		harness.queueWebviewEdit(insertAtColumn(3, "c"));
		await harness.drain();
		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		expect(webviewSaves).toEqual([{ source: "webview", content: "ab" }]);
		expect(harness.documentContent).toBe("abc");
	});

	it("back-to-back webview saves persist once per request (no merging, no duplication)", async () => {
		const harness = new DocumentSyncHarness("x");
		harness.queueSave();
		harness.queueSave();
		harness.queueSave();
		await harness.drain();
		expect(
			harness.saveLog.filter((record) => record.source === "webview"),
		).toHaveLength(3);
	});

	it("external save while queue is idle does not trigger a webview save", async () => {
		const harness = new DocumentSyncHarness("seed");
		harness.saveExternallyNow();
		await harness.drain();
		expect(harness.saveLog).toEqual([
			{ source: "external", content: "seed" },
		]);
		expect(
			harness.saveLog.filter((record) => record.source === "webview"),
		).toHaveLength(0);
	});

	it("external save racing a queued webview save persists exactly once per source", async () => {
		// Simulates: user hits Ctrl+S in our webview (queued) and File > Save in
		// the VS Code tab (external) at roughly the same moment. Each code path
		// owns its own persist; neither should double-save.
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "a"), { delayMs: 5 });
		harness.queueWebviewEdit(insertAtColumn(2, "b"), { delayMs: 5 });
		harness.queueSave();
		harness.saveExternallyNow();
		await harness.drain();
		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		const externalSaves = harness.saveLog.filter(
			(record) => record.source === "external",
		);
		expect(webviewSaves).toHaveLength(1);
		expect(externalSaves).toHaveLength(1);
		expect(webviewSaves[0]?.content).toBe("ab");
	});

	it("external edit landing between save queueing and save execution does not duplicate persist", async () => {
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "a"), { delayMs: 10 });
		harness.queueSave();
		await sleep(2);
		harness.simulateExternalEdit(insertAtColumn(2, "E"));
		await harness.drain();
		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		expect(webviewSaves).toHaveLength(1);
	});
});

describe("deterministic stress", () => {
	it("survives deterministic burst chaos without invariant violations", async () => {
		const harness = new DocumentSyncHarness("");
		const rand = createPrng(1337);
		let nextColumn = 1;
		for (let i = 0; i < 120; i++) {
			const roll = rand();
			if (roll < 0.15) {
				harness.simulateExternalEdit(insertAtColumn(1, "E"));
				nextColumn += 1;
				continue;
			}
			if (roll < 0.25) {
				harness.queueSave();
				continue;
			}
			const delayMs = Math.floor(rand() * 8);
			harness.queueWebviewEdit(insertAtColumn(nextColumn, "x"), {
				delayMs,
			});
			nextColumn += 1;
		}
		await harness.drain();
		expect(harness.editState.versionBeforeEdit).toBeUndefined();
		expect(harness.documentContent.length).toBeGreaterThan(0);
		expect(harness.documentVersion).toBeGreaterThan(0);
	});
});

// Multi-editor scenarios: the same TextDocument is edited from our webview AND
// from another VS Code editor tab (e.g. the built-in text editor). From our
// sync code's perspective, the other editor is indistinguishable from any
// other external mutation source: its edits arrive as onDidChangeTextDocument
// (modeled by simulateExternalEdit) and its saves call document.save()
// directly, bypassing our code (modeled by saveExternallyNow).
describe("multi-editor concurrent editing and save attribution", () => {
	it("webview and external edits interleave, webview saves exactly once at queue point", async () => {
		const harness = new DocumentSyncHarness("");
		// Our webview types "a" (goes through editQueue, runs async).
		harness.queueWebviewEdit(insertAtColumn(1, "a"), { delayMs: 3 });
		// Another VS Code editor inserts "X" at the start of the doc.
		// This fires synchronously (it's our test simulating the event arriving)
		// and lands before the queued edit runs.
		harness.simulateExternalEdit(insertAtColumn(1, "X"));
		harness.queueWebviewEdit(insertAtColumn(2, "b"), { delayMs: 3 });
		harness.simulateExternalEdit(insertAtColumn(1, "Y"));
		// User hits Ctrl+S in OUR editor. Goes through the same queue as edits.
		harness.queueSave();
		// Typing continues on both sides after save was queued.
		harness.queueWebviewEdit(insertAtColumn(3, "c"), { delayMs: 3 });
		harness.simulateExternalEdit(insertAtColumn(1, "Z"));
		await harness.drain();

		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		const externalSaves = harness.saveLog.filter(
			(record) => record.source === "external",
		);
		// Exactly one persist, attributed to our code path.
		expect(webviewSaves).toHaveLength(1);
		expect(externalSaves).toHaveLength(0);
		// Save captured content at its queue position: after "a" and "b" from
		// the webview and all three external inserts (which ran sync before
		// the queue drained), but before "c".
		expect(webviewSaves[0]?.content).not.toContain("c");
		expect(webviewSaves[0]?.content).toContain("a");
		expect(webviewSaves[0]?.content).toContain("b");
		// No data loss: final doc reflects all edits from both sources.
		expect(harness.documentContent).toContain("a");
		expect(harness.documentContent).toContain("b");
		expect(harness.documentContent).toContain("c");
		for (const ch of ["X", "Y", "Z"]) {
			expect(harness.documentContent).toContain(ch);
		}
		expect(harness.editState.versionBeforeEdit).toBeUndefined();
	});

	it("webview and external edits interleave, external save records exactly once with zero webview saves", async () => {
		const harness = new DocumentSyncHarness("");
		harness.queueWebviewEdit(insertAtColumn(1, "a"), { delayMs: 3 });
		harness.simulateExternalEdit(insertAtColumn(1, "X"));
		harness.queueWebviewEdit(insertAtColumn(2, "b"), { delayMs: 3 });
		harness.simulateExternalEdit(insertAtColumn(1, "Y"));
		// User hits Ctrl+S in the OTHER editor tab. Bypasses our code.
		harness.saveExternallyNow();
		harness.queueWebviewEdit(insertAtColumn(3, "c"), { delayMs: 3 });
		harness.simulateExternalEdit(insertAtColumn(1, "Z"));
		await harness.drain();

		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		const externalSaves = harness.saveLog.filter(
			(record) => record.source === "external",
		);
		// External save path must NOT leak into our queue or trigger a
		// webview-side save. Guards against anyone re-adding an
		// onWillSaveTextDocument hook that enqueues its own save.
		expect(webviewSaves).toHaveLength(0);
		expect(externalSaves).toHaveLength(1);
		// Final doc reflects all edits from both sources — no data loss.
		for (const ch of ["a", "b", "c", "X", "Y", "Z"]) {
			expect(harness.documentContent).toContain(ch);
		}
		expect(harness.editState.versionBeforeEdit).toBeUndefined();
	});
});

// Stress variants of the multi-editor scenario. Split from the focused tests
// above so each describe block stays readable and under the per-function
// line limit.
describe("multi-editor concurrent editing stress", () => {
	// Parameterized seeded stress. Each seed generates a different random mix
	// of webview edits, external edits, webview saves, and external saves.
	// We tally expected save counts as we schedule, then after drain assert
	// exact counts per source. Duplicated or dropped saves under stress are
	// immediately visible.
	it.each([
		1337, 42, 99, 12_345,
	])("multi-editor stress seed=%i preserves exact save counts per source", async (seed) => {
		const harness = new DocumentSyncHarness("");
		const rand = createPrng(seed);
		const operationCount = 500;
		let nextColumn = 1;
		let expectedWebviewSaves = 0;
		let expectedExternalSaves = 0;
		let webviewEditCount = 0;
		let externalEditCount = 0;

		for (let i = 0; i < operationCount; i++) {
			const roll = rand();
			if (roll < 0.35) {
				harness.simulateExternalEdit(insertAtColumn(1, "E"));
				nextColumn += 1;
				externalEditCount += 1;
			} else if (roll < 0.4) {
				harness.queueSave();
				expectedWebviewSaves += 1;
			} else if (roll < 0.44) {
				harness.saveExternallyNow();
				expectedExternalSaves += 1;
			} else {
				const delayMs = Math.floor(rand() * 5);
				harness.queueWebviewEdit(insertAtColumn(nextColumn, "x"), {
					delayMs,
				});
				nextColumn += 1;
				webviewEditCount += 1;
			}
		}
		await harness.drain();

		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		const externalSaves = harness.saveLog.filter(
			(record) => record.source === "external",
		);
		expect(webviewSaves).toHaveLength(expectedWebviewSaves);
		expect(externalSaves).toHaveLength(expectedExternalSaves);
		// Queue drained cleanly.
		expect(harness.editState.versionBeforeEdit).toBeUndefined();
		// No data loss: every external 'E' and every webview 'x' survived.
		const externalCharCount = (harness.documentContent.match(/E/g) ?? [])
			.length;
		const webviewCharCount = (harness.documentContent.match(/x/g) ?? [])
			.length;
		expect(externalCharCount).toBe(externalEditCount);
		expect(webviewCharCount).toBe(webviewEditCount);
	});

	// Save fires at a random point in the run from a random source. Targets
	// the exact "one of them saves" bullet from the requirement: regardless
	// of which side triggered the save, exactly one persist is recorded and
	// it is attributed to the correct source.
	it.each([
		{ seed: 7, source: "webview" as const },
		{ seed: 7, source: "external" as const },
		{ seed: 314, source: "webview" as const },
		{ seed: 314, source: "external" as const },
	])("multi-editor burst with single $source save records exactly one save from that source (seed=$seed)", async ({
		seed,
		source,
	}) => {
		const { harness, externalEditCount, webviewEditCount } =
			await runSingleSaveBurst({ seed, source, totalEdits: 200 });

		const webviewSaves = harness.saveLog.filter(
			(record) => record.source === "webview",
		);
		const externalSaves = harness.saveLog.filter(
			(record) => record.source === "external",
		);
		expect(webviewSaves).toHaveLength(source === "webview" ? 1 : 0);
		expect(externalSaves).toHaveLength(source === "external" ? 1 : 0);
		expect((harness.documentContent.match(/E/g) ?? []).length).toBe(
			externalEditCount,
		);
		expect((harness.documentContent.match(/x/g) ?? []).length).toBe(
			webviewEditCount,
		);
		expect(harness.editState.versionBeforeEdit).toBeUndefined();
	});
});

interface SingleSaveBurstArgs {
	seed: number;
	source: "webview" | "external";
	totalEdits: number;
}

interface SingleSaveBurstResult {
	harness: DocumentSyncHarness;
	externalEditCount: number;
	webviewEditCount: number;
}

async function runSingleSaveBurst(
	args: SingleSaveBurstArgs,
): Promise<SingleSaveBurstResult> {
	const { seed, source, totalEdits } = args;
	const harness = new DocumentSyncHarness("");
	const rand = createPrng(seed);
	const saveAt = Math.floor(rand() * totalEdits);
	let nextColumn = 1;
	let externalEditCount = 0;
	let webviewEditCount = 0;

	for (let i = 0; i < totalEdits; i++) {
		if (i === saveAt) {
			triggerSaveFromSource(harness, source);
		}
		const didExternalEdit = scheduleRandomEdit(harness, rand, nextColumn);
		nextColumn += 1;
		if (didExternalEdit) {
			externalEditCount += 1;
		} else {
			webviewEditCount += 1;
		}
	}
	await harness.drain();
	return { harness, externalEditCount, webviewEditCount };
}

function triggerSaveFromSource(
	harness: DocumentSyncHarness,
	source: "webview" | "external",
): void {
	if (source === "webview") {
		harness.queueSave();
	} else {
		harness.saveExternallyNow();
	}
}

// Returns true if the scheduled op was an external edit, false for webview.
function scheduleRandomEdit(
	harness: DocumentSyncHarness,
	rand: () => number,
	column: number,
): boolean {
	const roll = rand();
	if (roll < 0.4) {
		harness.simulateExternalEdit(insertAtColumn(1, "E"));
		return true;
	}
	const delayMs = Math.floor(rand() * 4);
	harness.queueWebviewEdit(insertAtColumn(column, "x"), { delayMs });
	return false;
}
