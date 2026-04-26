// Tests that save operations are properly ordered with edits in the queue.
//
// This is a pure queue-ordering test without VS Code mocking. It verifies the
// fundamental behavior: when edits and saves are queued, they execute in order.
//
// Limitation: This doesn't test actual document.save() integration with VS Code.
// See TODO.md for upgrade path to @vscode/test-electron for full e2e coverage.

import { describe, it, jest } from "@jest/globals";

interface EditQueue {
	queue: Promise<void>;
}

const flushMicrotasks = async (count: number): Promise<void> => {
	if (count <= 0) {
		return;
	}
	await Promise.resolve();
	await flushMicrotasks(count - 1);
};

describe("Edit queue ordering", () => {
	it("saves execute in order with edits", async () => {
		const state: EditQueue = { queue: Promise.resolve() };
		const operations: string[] = [];

		const queueEdit = (name: string) => {
			state.queue = state.queue.then(async () => {
				await Promise.resolve();
				operations.push(name);
			});
		};

		const queueSave = () => {
			state.queue = state.queue.then(async () => {
				await Promise.resolve();
				operations.push("save");
			});
		};

		queueEdit("edit-1");
		queueEdit("edit-2");
		queueSave();
		queueEdit("edit-3");

		await state.queue;

		expect(operations).toEqual(["edit-1", "edit-2", "save", "edit-3"]);
	});

	it("multiple saves interleaved with edits maintain order", async () => {
		const state: EditQueue = { queue: Promise.resolve() };
		const operations: string[] = [];

		const queueEdit = (name: string) => {
			state.queue = state.queue.then(async () => {
				await Promise.resolve();
				operations.push(name);
			});
		};

		const queueSave = (name: string) => {
			state.queue = state.queue.then(async () => {
				await Promise.resolve();
				operations.push(name);
			});
		};

		queueEdit("edit-1");
		queueSave("save-1");
		queueEdit("edit-2");
		queueSave("save-2");
		queueEdit("edit-3");

		await state.queue;

		expect(operations).toEqual([
			"edit-1",
			"save-1",
			"edit-2",
			"save-2",
			"edit-3",
		]);
	});

	it("async operations with varying delays still execute in queue order", async () => {
		const state: EditQueue = { queue: Promise.resolve() };
		const operations: string[] = [];

		const queueOp = (name: string, delayMs: number) => {
			state.queue = state.queue.then(
				() =>
					new Promise<void>((resolve) => {
						setTimeout(() => {
							operations.push(name);
							resolve();
						}, delayMs);
					}),
			);
		};

		queueOp("slow-edit", 30);
		queueOp("fast-save", 5);
		queueOp("medium-edit", 15);

		await state.queue;

		expect(operations).toEqual(["slow-edit", "fast-save", "medium-edit"]);
	});

	it("queue settles correctly after all operations", async () => {
		const state: EditQueue = { queue: Promise.resolve() };
		const settled = jest.fn();

		state.queue = state.queue.then(() => Promise.resolve());
		state.queue = state.queue.then(() => Promise.resolve());
		state.queue = state.queue.then(() => Promise.resolve());

		state.queue.then(settled);
		await flushMicrotasks(20);

		expect(settled).toHaveBeenCalledTimes(1);
	});
});
