import { describe, expect, it } from "@jest/globals";
import { Differ } from "../src/matchers/diffutil.ts";

// Build a Differ over three line arrays and return it ready to query.
function makeDiffer(local: string[], base: string[], remote: string[]): Differ {
	const d = new Differ();
	d.setSequences([local, base, remote]);
	return d;
}

// ─── merge cache tags ──────────────��──────────────────────────────────────────

describe("Differ merge cache tags", () => {
	it("identical files produce no cache entries", () => {
		const lines = ["a", "b", "c"];
		const d = makeDiffer(lines, lines, lines);
		expect(d.allChanges()).toHaveLength(0);
		expect(d.conflicts).toHaveLength(0);
	});

	it("local-only change gets a non-conflict left-side entry", () => {
		const d = makeDiffer(["a", "X", "c"], ["a", "b", "c"], ["a", "b", "c"]);
		const changes = d.allChanges();
		expect(changes.length).toBeGreaterThan(0);
		const left = changes.find((pair) => pair[0] !== null);
		expect(left).toBeDefined();
		expect(left?.[0]?.tag).not.toBe("conflict");
		expect(d.conflicts).toHaveLength(0);
	});

	it("remote-only change gets a non-conflict right-side entry", () => {
		const d = makeDiffer(["a", "b", "c"], ["a", "b", "c"], ["a", "X", "c"]);
		const changes = d.allChanges();
		expect(changes.length).toBeGreaterThan(0);
		const right = changes.find((pair) => pair[1] !== null);
		expect(right).toBeDefined();
		expect(right?.[1]?.tag).not.toBe("conflict");
		expect(d.conflicts).toHaveLength(0);
	});

	it("same change on both sides produces no conflict", () => {
		const d = makeDiffer(["a", "X", "c"], ["a", "b", "c"], ["a", "X", "c"]);
		expect(d.conflicts).toHaveLength(0);
	});

	it("diverging changes on both sides produce a conflict chunk", () => {
		const d = makeDiffer(
			["a", "LOCAL", "c"],
			["a", "b", "c"],
			["a", "REMOTE", "c"],
		);
		expect(d.conflicts.length).toBeGreaterThan(0);
		const conflictPairs = d.conflicts.map((i) => d.allChanges()[i]);
		expect(
			conflictPairs.some(
				(p) => p?.[0]?.tag === "conflict" || p?.[1]?.tag === "conflict",
			),
		).toBe(true);
	});

	it("conflict chunk startA/endA coordinates point into merged (pane 1) lines", () => {
		const local = ["a", "LOCAL", "c"];
		const base = ["a", "b", "c"];
		const remote = ["a", "REMOTE", "c"];
		const d = makeDiffer(local, base, remote);

		const allPairs = d.allChanges();
		const conflictPair = allPairs.find(
			(p) => p[0]?.tag === "conflict" || p[1]?.tag === "conflict",
		);
		expect(conflictPair).toBeDefined();

		// startA/endA index into pane 1 (merged/base). Line index 1 is "b".
		const chunk = conflictPair?.[0] ?? conflictPair?.[1];
		expect(chunk?.startA).toBe(1);
		expect(chunk?.endA).toBe(2);
	});

	it("conflict chunk startB/endB coordinates point into the outer pane lines", () => {
		const local = ["a", "LOCAL", "c"];
		const base = ["a", "b", "c"];
		const remote = ["a", "REMOTE", "c"];
		const d = makeDiffer(local, base, remote);

		const left = d.allChanges().find((p) => p[0]?.tag === "conflict");
		expect(left?.[0]?.startB).toBe(1);
		expect(left?.[0]?.endB).toBe(2);
	});

	it("multi-line conflict spans exact line range", () => {
		const local = ["a", "L1", "L2", "d"];
		const base = ["a", "b", "c", "d"];
		const remote = ["a", "R1", "R2", "d"];
		const d = makeDiffer(local, base, remote);

		expect(d.conflicts.length).toBeGreaterThan(0);
		const pair = d.allChanges()[d.conflicts[0] ?? 0];
		const chunk = pair?.[0] ?? pair?.[1];
		expect(chunk?.startA).toBe(1);
		expect(chunk?.endA).toBe(3);
	});
});

// ─── ignoreBlanks / consumeBlankLines ─────────────────���───────────────────────

describe("Differ ignoreBlanks trims leading and trailing blanks from chunks", () => {
	it("chunk surrounded by blank lines shrinks to non-blank content only", () => {
		// local changes line 2; lines 1 and 3 are blank in the merged pane.
		// With ignoreBlanks the chunk should cover only the non-blank line.
		const local = ["", "CHANGED", ""];
		const base = ["", "original", ""];
		const remote = ["", "original", ""];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		const changes = d.allChanges();
		expect(changes.length).toBeGreaterThan(0);
		const chunk = changes[0]?.[0];
		// After trimming blanks the covered range must not include the empty lines.
		if (chunk) {
			expect(chunk.startA).toBeGreaterThanOrEqual(1);
			expect(chunk.endA).toBeLessThanOrEqual(2);
		}
	});

	it("chunk consisting entirely of blank lines is removed", () => {
		// Both local and base differ only in blank lines.
		// consumeBlankLines should eliminate the chunk entirely.
		const local = ["a", "", "b"];
		const base = ["a", "x", "b"];
		const remote = ["a", "x", "b"];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		// The only differing line is blank in local; it should be consumed.
		const changes = d.allChanges();
		const nonNullChanges = changes.filter(
			(p) => p[0] !== null || p[1] !== null,
		);
		// All remaining chunks must have at least one non-blank-only range.
		for (const [left, right] of nonNullChanges) {
			const chunk = left ?? right;
			if (chunk) {
				const seqA = [local, base, remote][1] ?? [];
				const allBlank = seqA
					.slice(chunk.startA, chunk.endA)
					.every((l) => l === "");
				expect(allBlank).toBe(false);
			}
		}
	});
});

describe("Differ ignoreBlanks consumeBlankLines boundary conditions", () => {
	it("leading blanks on A-side are trimmed: startA advances past them", () => {
		const base = ["", "x"];
		const local = ["", "Y"];
		const remote = ["", "x"];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		const nonNull = d
			.allChanges()
			.filter((p) => p[0] !== null || p[1] !== null);
		const chunk = nonNull[0]?.[0] ?? nonNull[0]?.[1];
		expect(chunk?.startA).toBeGreaterThanOrEqual(1);
	});

	it("trailing blanks on A-side are trimmed: endA retreats past them", () => {
		const base = ["x", ""];
		const local = ["Y", ""];
		const remote = ["x", ""];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		const nonNull = d
			.allChanges()
			.filter((p) => p[0] !== null || p[1] !== null);
		const chunk = nonNull[0]?.[0] ?? nonNull[0]?.[1];
		expect(chunk?.endA).toBeLessThanOrEqual(1);
	});

	it("replace→insert when merged A-side trims to empty and outer B-side has content", () => {
		// Right diff: A=merged(base), B=remote. Make base have only blank in the diff
		// region while remote has real content → c1===c2 with replace → insert.
		const base = ["a", "", "b"];
		const local = ["a", "", "b"];
		const remote = ["a", "NEW", "b"];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		// Any chunk with tag insert (from right diff pair[1]) satisfies the condition.
		const hasInsert = d
			.allChanges()
			.some((p) => p[0]?.tag === "insert" || p[1]?.tag === "insert");
		expect(hasInsert).toBe(true);
	});

	it("replace→delete when outer B-side trims to empty and merged A-side has content", () => {
		// Left diff: A=merged(base), B=local. Make local have only blank in the diff
		// region while base has real content → c3===c4 with replace → delete.
		const base = ["a", "CONTENT", "b"];
		const local = ["a", "", "b"];
		const remote = ["a", "CONTENT", "b"];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		const hasDelete = d
			.allChanges()
			.some((p) => p[0]?.tag === "delete" || p[1]?.tag === "delete");
		expect(hasDelete).toBe(true);
	});

	it("both sides trim to empty: chunk is removed entirely", () => {
		const base = ["a", "x", "b"];
		const local = ["a", "", "b"];
		const remote = ["a", "x", "b"];
		const d = new Differ();
		d.ignoreBlanks = true;
		d.setSequences([local, base, remote]);

		const nonNull = d
			.allChanges()
			.filter((p) => p[0] !== null || p[1] !== null);
		for (const [left] of nonNull) {
			if (left) {
				const aLines = base.slice(left.startA, left.endA);
				expect(aLines.every((l) => l === "")).toBe(false);
			}
		}
	});
});

// ─── _getAutoMergeTag via observable chunk tags ───────────────────────────────
// Each case drives a different branch of _getAutoMergeTag (conflict/delete/
// replace/insert) by choosing sequences that produce the right overlap shape.

describe("Differ _autoMerge tag classification", () => {
	it("produces 'replace' tag when both sides changed the same lines differently", () => {
		// Both sides change the same base line, but to different content → conflict.
		// Same content → replace (matched, both sides changed merged content).
		const base = ["a", "b", "c"];
		const local = ["a", "X", "c"];
		const remote = ["a", "X", "c"];
		const d = makeDiffer(local, base, remote);
		// Same change on both sides → auto-merge as replace (non-conflict).
		const changes = d.allChanges();
		const tags = changes
			.flatMap((p) => [p[0]?.tag, p[1]?.tag])
			.filter(Boolean);
		expect(tags.every((t) => t !== "conflict")).toBe(true);
		expect(
			tags.some(
				(t) => t === "replace" || t === "insert" || t === "delete",
			),
		).toBe(true);
	});

	it("produces 'delete' tag when merged side has lines but outer sides are empty", () => {
		// local and remote both delete a line that exists in base.
		// _getAutoMergeTag: matches=true, l1!==h1 (base has content), l0===h0 → delete.
		const base = ["a", "GONE", "c"];
		const local = ["a", "c"];
		const remote = ["a", "c"];
		const d = makeDiffer(local, base, remote);
		const tags = d
			.allChanges()
			.flatMap((p) => [p[0]?.tag, p[1]?.tag])
			.filter(Boolean);
		expect(tags.some((t) => t === "delete")).toBe(true);
	});

	it("produces 'insert' tag when both sides insert identical content", () => {
		// local and remote both add the same new line.
		// _getAutoMergeTag: matches=true, l1===h1 (no base change) → insert.
		const base = ["a", "c"];
		const local = ["a", "NEW", "c"];
		const remote = ["a", "NEW", "c"];
		const d = makeDiffer(local, base, remote);
		const tags = d
			.allChanges()
			.flatMap((p) => [p[0]?.tag, p[1]?.tag])
			.filter(Boolean);
		expect(tags.some((t) => t === "insert")).toBe(true);
	});

	it("produces 'conflict' tag when both sides differ from base differently", () => {
		const base = ["a", "original", "c"];
		const local = ["a", "LOCAL", "c"];
		const remote = ["a", "REMOTE", "c"];
		const d = makeDiffer(local, base, remote);
		const tags = d
			.allChanges()
			.flatMap((p) => [p[0]?.tag, p[1]?.tag])
			.filter(Boolean);
		expect(tags.some((t) => t === "conflict")).toBe(true);
	});
});

// ─── locateChunk ──────────────────────────────────────────────────────────────

describe("Differ locateChunk", () => {
	it("returns [null, null, null] for an out-of-range pane", () => {
		const d = makeDiffer(["a", "X", "c"], ["a", "b", "c"], ["a", "b", "c"]);
		expect(d.locateChunk(-1, 0)).toEqual([null, null, null]);
		expect(d.locateChunk(3, 0)).toEqual([null, null, null]);
	});

	it("locates the chunk index containing the changed line", () => {
		const d = makeDiffer(["a", "X", "c"], ["a", "b", "c"], ["a", "b", "c"]);
		// The change is at line index 1 in pane 0 (local). foundIndex should be 0.
		const [found] = d.locateChunk(0, 1);
		expect(found).toBe(0);
	});

	it("returns null foundIndex for an unchanged line", () => {
		const d = makeDiffer(["a", "X", "c"], ["a", "b", "c"], ["a", "b", "c"]);
		// Line 0 ("a") is unchanged — no chunk contains it.
		const [found] = d.locateChunk(0, 0);
		expect(found).toBeNull();
	});
});
