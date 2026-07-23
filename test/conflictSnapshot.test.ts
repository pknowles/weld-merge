// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { describe, expect, it } from "@jest/globals";
import { createConflictSnapshot } from "../src/conflictSnapshot.ts";

describe("createConflictSnapshot", () => {
	it("counts independent overlapping edits as separate conflicts", () => {
		const snapshot = createConflictSnapshot({
			base: "alpha\none\nmiddle\ntwo\nomega\n",
			local: "alpha\nlocal one\nmiddle\nlocal two\nomega\n",
			remote: "alpha\nremote one\nmiddle\nremote two\nomega\n",
		});

		expect(snapshot.conflictChangeIndexes).toHaveLength(2);
		for (const index of snapshot.conflictChangeIndexes) {
			const change = snapshot.changes[index];
			expect(change).toBeDefined();
			expect(change?.some((chunk) => chunk?.tag === "conflict")).toBe(
				true,
			);
		}
	});

	it("does not count independent non-overlapping edits as conflicts", () => {
		const snapshot = createConflictSnapshot({
			base: "alpha\none\nmiddle\ntwo\nomega\n",
			local: "alpha\nlocal one\nmiddle\ntwo\nomega\n",
			remote: "alpha\none\nmiddle\nremote two\nomega\n",
		});

		expect(snapshot.conflictChangeIndexes).toHaveLength(0);
		expect(snapshot.mergedContent).toContain("local one");
		expect(snapshot.mergedContent).toContain("remote two");
	});

	it("analyzes both-added content with an empty base", () => {
		const snapshot = createConflictSnapshot({
			base: "",
			local: "local addition\n",
			remote: "remote addition\n",
		});

		expect(snapshot.conflictChangeIndexes).toHaveLength(1);
	});
});
