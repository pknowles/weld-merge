import { describe, expect, it } from "@jest/globals";
import {
	assertDiffChunksWellFormed,
	compareChunkOrder,
	findTargetChunk,
	normalizeWebviewError,
} from "../src/webview/ui/appHooks.ts";
import type { DiffChunk } from "../src/webview/ui/types.ts";

const LABEL_IN_ERROR = /leftDiff/;

function chunk(startA: number, endA: number, startB = 0, endB = 1): DiffChunk {
	return { tag: "replace", startA, endA, startB, endB };
}

// ─── compareChunkOrder ───────────────────────────────────────────────────────

describe("compareChunkOrder", () => {
	it("earlier startA sorts first", () => {
		expect(compareChunkOrder(chunk(0, 1), chunk(1, 2))).toBeLessThan(0);
		expect(compareChunkOrder(chunk(1, 2), chunk(0, 1))).toBeGreaterThan(0);
	});

	it("equal startA, earlier endA sorts first", () => {
		expect(compareChunkOrder(chunk(0, 1), chunk(0, 2))).toBeLessThan(0);
	});

	it("equal startA and endA, earlier startB sorts first", () => {
		const a: DiffChunk = {
			tag: "replace",
			startA: 0,
			endA: 1,
			startB: 0,
			endB: 1,
		};
		const b: DiffChunk = {
			tag: "replace",
			startA: 0,
			endA: 1,
			startB: 1,
			endB: 2,
		};
		expect(compareChunkOrder(a, b)).toBeLessThan(0);
	});

	it("returns 0 for identical chunks", () => {
		const c = chunk(5, 10, 5, 10);
		expect(compareChunkOrder(c, c)).toBe(0);
	});
});

// ─── assertDiffChunksWellFormed ──────────────────────────────────────────────

describe("assertDiffChunksWellFormed", () => {
	it("accepts an empty array", () => {
		expect(() => assertDiffChunksWellFormed([], "test")).not.toThrow();
	});

	it("accepts a valid strictly increasing sequence", () => {
		const chunks = [chunk(0, 2), chunk(3, 5), chunk(6, 8)];
		expect(() => assertDiffChunksWellFormed(chunks, "test")).not.toThrow();
	});

	it("throws for a chunk with negative A length", () => {
		expect(() =>
			assertDiffChunksWellFormed(
				[{ tag: "replace", startA: 5, endA: 3, startB: 0, endB: 1 }],
				"test",
			),
		).toThrow();
	});

	it("throws for a chunk with negative B length", () => {
		expect(() =>
			assertDiffChunksWellFormed(
				[{ tag: "replace", startA: 0, endA: 1, startB: 5, endB: 3 }],
				"test",
			),
		).toThrow();
	});

	it("throws for a zero-size chunk (both lengths 0)", () => {
		expect(() =>
			assertDiffChunksWellFormed(
				[{ tag: "replace", startA: 3, endA: 3, startB: 3, endB: 3 }],
				"test",
			),
		).toThrow();
	});

	it("throws when chunks are not strictly increasing", () => {
		const chunks = [chunk(5, 8), chunk(3, 6)];
		expect(() => assertDiffChunksWellFormed(chunks, "test")).toThrow();
	});

	it("throws when second chunk starts at same position as first ends (overlapping)", () => {
		// chunk(0,4) then chunk(2,6): compareChunkOrder gives 0-4 < 2-6 so passes,
		// but chunk(4,6) then chunk(3,8): startA 4>3 so order fails.
		const chunks = [chunk(4, 6), chunk(3, 8)];
		expect(() => assertDiffChunksWellFormed(chunks, "test")).toThrow();
	});

	it("error message includes the label", () => {
		expect(() =>
			assertDiffChunksWellFormed(
				[{ tag: "replace", startA: 5, endA: 3, startB: 0, endB: 1 }],
				"leftDiff",
			),
		).toThrow(LABEL_IN_ERROR);
	});
});

// ─── findTargetChunk ─────────────────────────────────────────────────────────

describe("findTargetChunk", () => {
	const chunks = [chunk(2, 4), chunk(8, 10), chunk(15, 17)];

	it("returns null for empty array", () => {
		expect(findTargetChunk([], 5, "next")).toBeNull();
		expect(findTargetChunk([], 5, "prev")).toBeNull();
	});

	it("next: returns first chunk when cursor is before all chunks", () => {
		expect(findTargetChunk(chunks, 0, "next")).toEqual(chunks[0]);
	});

	it("next: returns next chunk when cursor is inside first chunk", () => {
		// cursor=3 is inside chunk[0] (startA=2). next should be chunk[1].
		expect(findTargetChunk(chunks, 3, "next")).toEqual(chunks[1]);
	});

	it("next: wraps to first chunk when cursor is past all chunks", () => {
		expect(findTargetChunk(chunks, 20, "next")).toEqual(chunks[0]);
	});

	it("prev: returns last chunk when cursor is after all chunks", () => {
		expect(findTargetChunk(chunks, 20, "prev")).toEqual(chunks[2]);
	});

	it("prev: returns previous chunk when cursor is at start of a chunk", () => {
		// cursor=9 is inside chunk[1] (startA+1=9). prev should be chunk[0].
		expect(findTargetChunk(chunks, 9, "prev")).toEqual(chunks[0]);
	});

	it("prev: wraps to last chunk when cursor is before all chunks", () => {
		expect(findTargetChunk(chunks, 0, "prev")).toEqual(chunks[2]);
	});

	it("next with single chunk wraps back to that chunk", () => {
		const one = [chunk(5, 8)];
		// cursor inside chunk → next wraps to chunk[0] (only chunk)
		expect(findTargetChunk(one, 6, "next")).toEqual(one[0]);
	});

	it("prev with single chunk wraps back to that chunk", () => {
		const one = [chunk(5, 8)];
		expect(findTargetChunk(one, 4, "prev")).toEqual(one[0]);
	});
});

// ─── normalizeWebviewError ────────────────────────────────────────────────────

describe("normalizeWebviewError", () => {
	it("passes through valid string fields unchanged", () => {
		const result = normalizeWebviewError({
			title: "Something failed",
			message: "The operation could not complete",
			details: "stack trace here",
		});
		expect(result.title).toBe("Something failed");
		expect(result.message).toBe("The operation could not complete");
		expect(result.details).toBe("stack trace here");
	});

	it("substitutes a fallback title when title is missing", () => {
		const result = normalizeWebviewError({ message: "oops" });
		expect(result.title).toBe("Error: exception while loading diff");
	});

	it("substitutes a fallback message when message is missing", () => {
		const result = normalizeWebviewError({ title: "Failed" });
		expect(result.message).toBe("Unknown exception");
	});

	it("substitutes fallback title when title is not a string", () => {
		const result = normalizeWebviewError({ title: 42, message: "ok" });
		expect(result.title).toBe("Error: exception while loading diff");
	});

	it("substitutes fallback message when message is not a string", () => {
		const result = normalizeWebviewError({
			title: "T",
			message: { obj: 1 },
		});
		expect(result.message).toBe("Unknown exception");
	});

	it("omits details when details is undefined", () => {
		const result = normalizeWebviewError({ title: "T", message: "M" });
		expect(result.details).toBeUndefined();
	});

	it("omits details when details is not a string", () => {
		const result = normalizeWebviewError({
			title: "T",
			message: "M",
			details: 99,
		});
		expect(result.details).toBeUndefined();
	});

	it("handles a completely empty object with all fallbacks", () => {
		const result = normalizeWebviewError({});
		expect(result.title).toBe("Error: exception while loading diff");
		expect(result.message).toBe("Unknown exception");
		expect(result.details).toBeUndefined();
	});
});
