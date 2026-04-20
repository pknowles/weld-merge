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
			pendingVersionEcho: -1,
		};
	});

	it("returns 'suppress' when newVersion matches pendingVersionEcho", () => {
		editState.pendingVersionEcho = 11;
		expect(classifyDocumentChange(11, editState)).toBe("suppress");
		expect(editState.pendingVersionEcho).toBe(-1);
	});

	it("returns 'fullSync' when version jumps past pendingVersionEcho", () => {
		editState.pendingVersionEcho = 11;
		expect(classifyDocumentChange(12, editState)).toBe("fullSync");
		expect(editState.pendingVersionEcho).toBe(-1);
	});

	it("returns 'externalEdit' when no pending echo matches", () => {
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
			pendingVersionEcho: -1,
		};
		applyEdit = jest.fn(() => Promise.resolve());
		postFullSync = jest.fn();
	});

	it("calls postFullSync and skips applyEdit when msg version is stale", async () => {
		await processContentChanged([], 8, editState, applyEdit, postFullSync);
		expect(applyEdit).not.toHaveBeenCalled();
		expect(postFullSync).toHaveBeenCalled();
	});

	it("calls applyEdit and sets pendingVersionEcho when msg version matches", async () => {
		await processContentChanged([], 10, editState, applyEdit, postFullSync);
		expect(applyEdit).toHaveBeenCalled();
		expect(postFullSync).not.toHaveBeenCalled();
		expect(editState.pendingVersionEcho).toBe(11);
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

		// Manually chain the promises to simulate how it's used in the provider
		editState.editQueue = editState.editQueue.then(() =>
			processContentChanged(
				[],
				10,
				editState,
				() => mockApply(0),
				postFullSync,
			),
		);
		editState.editQueue = editState.editQueue.then(() =>
			processContentChanged(
				[],
				10,
				editState,
				() => mockApply(1),
				postFullSync,
			),
		);
		editState.editQueue = editState.editQueue.then(() =>
			processContentChanged(
				[],
				10,
				editState,
				() => mockApply(2),
				postFullSync,
			),
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
			pendingVersionEcho: -1,
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
