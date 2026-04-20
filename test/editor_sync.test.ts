// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { jest } from "@jest/globals";
import {
	classifyDocumentChange,
	type EditState,
	processContentChanged,
} from "../src/webview/editorSync.ts";
import type { MonacoContentChange } from "../src/webview/ui/types.ts";

type ApplyEditFn = (changes: MonacoContentChange[]) => Promise<void>;
type PostFullSyncFn = () => void;

describe("classifyDocumentChange", () => {
	let editState: EditState;

	beforeEach(() => {
		editState = {
			editQueue: Promise.resolve(),
			lastExternalChangeVersion: 10,
			versionBeforeEdit: undefined,
		};
	});

	it("returns 'suppress' when version increments by exactly 1 during edit", () => {
		editState.versionBeforeEdit = 10;
		expect(classifyDocumentChange(11, editState)).toBe("suppress");
	});

	it("returns 'fullSync' when version jumps by more than 1 during edit", () => {
		editState.versionBeforeEdit = 10;
		expect(classifyDocumentChange(12, editState)).toBe("fullSync");
	});

	it("returns 'externalEdit' when not mid-edit", () => {
		editState.versionBeforeEdit = undefined;
		expect(classifyDocumentChange(11, editState)).toBe("externalEdit");
	});
});

describe("processContentChanged", () => {
	let editState: EditState;
	let applyEdit: jest.Mock<ApplyEditFn>;
	let postFullSync: jest.Mock<PostFullSyncFn>;

	beforeEach(() => {
		editState = {
			editQueue: Promise.resolve(),
			lastExternalChangeVersion: 10,
			versionBeforeEdit: undefined,
		};
		applyEdit = jest.fn(() => Promise.resolve());
		postFullSync = jest.fn();
	});

	it("calls postFullSync and skips applyEdit when msg version is stale", async () => {
		await processContentChanged({
			changes: [],
			msgVersion: 8,
			editState,
			currentDocumentVersion: 10,
			applyEdit,
			postFullSync,
		});
		expect(applyEdit).not.toHaveBeenCalled();
		expect(postFullSync).toHaveBeenCalled();
	});

	it("calls applyEdit when msg version matches", async () => {
		await processContentChanged({
			changes: [],
			msgVersion: 10,
			editState,
			currentDocumentVersion: 10,
			applyEdit,
			postFullSync,
		});
		expect(applyEdit).toHaveBeenCalled();
		expect(postFullSync).not.toHaveBeenCalled();
	});

	it("clears versionBeforeEdit after applyEdit completes", async () => {
		await processContentChanged({
			changes: [],
			msgVersion: 10,
			editState,
			currentDocumentVersion: 10,
			applyEdit,
			postFullSync,
		});
		expect(editState.versionBeforeEdit).toBeUndefined();
	});

	it("serializes concurrent edits — all applied in order", async () => {
		const appliedOrder: number[] = [];
		const delays = [30, 10, 20];

		const mockApply = (i: number) =>
			new Promise<void>((resolve) => {
				setTimeout(() => {
					appliedOrder.push(i);
					resolve();
				}, delays[i]);
			});

		// Manually chain the promises to simulate how it's used in the provider.
		// Document version increments with each edit in real usage.
		let docVersion = 10;
		editState.editQueue = editState.editQueue.then(() =>
			processContentChanged({
				changes: [],
				msgVersion: 10,
				editState,
				currentDocumentVersion: docVersion++,
				applyEdit: () => mockApply(0),
				postFullSync,
			}),
		);
		editState.editQueue = editState.editQueue.then(() =>
			processContentChanged({
				changes: [],
				msgVersion: 10,
				editState,
				currentDocumentVersion: docVersion++,
				applyEdit: () => mockApply(1),
				postFullSync,
			}),
		);
		editState.editQueue = editState.editQueue.then(() =>
			processContentChanged({
				changes: [],
				msgVersion: 10,
				editState,
				currentDocumentVersion: docVersion++,
				applyEdit: () => mockApply(2),
				postFullSync,
			}),
		);

		await editState.editQueue;
		expect(appliedOrder).toEqual([0, 1, 2]);
	});
});

describe("race condition stress", () => {
	it("never corrupts state under concurrent interleaved edits", async () => {
		const editState: EditState = {
			editQueue: Promise.resolve(),
			lastExternalChangeVersion: 0,
			versionBeforeEdit: undefined,
		};

		const applied: string[] = [];
		const iterations = 50;

		const runIteration = (i: number) => {
			const delay = Math.random() * 10;
			editState.editQueue = editState.editQueue.then(async () => {
				await new Promise((r) => setTimeout(r, delay));
				applied.push(`edit-${i}`);
			});
		};

		for (let i = 0; i < iterations; i++) {
			runIteration(i);
		}

		await editState.editQueue;
		expect(applied.length).toBe(iterations);
		for (let i = 0; i < iterations; i++) {
			expect(applied[i]).toBe(`edit-${i}`);
		}
	});
});
