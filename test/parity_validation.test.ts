import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, test } from "@jest/globals";
import { Differ } from "../src/matchers/diffutil.ts";
import { Merger } from "../src/matchers/merge.ts";
import { getPaneHighlights } from "../src/webview/ui/highlightUtil.ts";
import type { DiffChunk, FileState } from "../src/webview/ui/types.ts";

const testDir = join(process.cwd(), "test");

/**
 * Compact Schema:
 * [pane, start, sizechange, [indices], [[diffs0], [diffs1]], output_index, unresolvedCount]
 */
type Step = [
	number, // pane
	number, // start
	number, // sizechange
	number[], // new_pane_text_indices
	[string, number, number, number, number][][], // diffs
	number, // mergeResult_index
	number, // unresolvedCount
];

interface Trace {
	t: string[]; // String Table
	it: number[]; // Initial Text Indices
	s: Step[]; // Steps
}

const tracePath = join(testDir, "parity_trace.json");
const trace: Trace = JSON.parse(readFileSync(tracePath, "utf-8"));

/** Helper to map string indices back to lines */
const hydrate = (indices: number[]) =>
	// biome-ignore lint/style/noNonNullAssertion: safe in controlled test
	indices.map((i) => trace.t[i]!);

const toFiles = (texts: string[][]): FileState[] =>
	texts.slice(0, 3).map((lines, i) => ({
		label: ["local", "base", "remote"][i] ?? "",
		content: lines.join("\n"),
	}));

const toWebviewFiles = (
	texts: string[][],
): [null, FileState, FileState, FileState, null] => {
	const [local, merged, remote] = toFiles(texts);
	if (!(local && merged && remote)) {
		throw new Error("expected three hydrated trace panes");
	}
	return [null, local, merged, remote, null];
};

const toWebviewDiffs = (
	differ: Differ,
): [null, DiffChunk[], DiffChunk[], null] => [
	null,
	differ._mergeCache
		.map((pair) => pair[0])
		.filter((chunk): chunk is DiffChunk => chunk !== null),
	differ._mergeCache
		.map((pair) => pair[1])
		.filter((chunk): chunk is DiffChunk => chunk !== null),
	null,
];

const webviewHighlights = (
	differ: Differ,
	texts: string[][],
): ReturnType<typeof getPaneHighlights>[] => {
	const files = toWebviewFiles(texts);
	const diffs = toWebviewDiffs(differ);
	return [1, 2, 3].map((pane) =>
		getPaneHighlights(pane, files, diffs, false, false),
	);
};

describe("Meld Step-by-Step Parity Trace: diffs and merge output", () => {
	test("matches internal diffs and merge results after 500+ stressful edits", () => {
		const merger = new Merger();
		const t = hydrate(trace.it);

		// Sync initial 3-pane state
		const texts: string[][] = [t.slice(), t.slice(), t.slice()];
		merger.initialize(texts, texts);

		for (const stepArr of trace.s) {
			const [
				pane,
				start,
				sizechange,
				newPaneTextIndices,
				expectedDiffsGroup,
				expectedMergeResultIndex,
				expectedUnresolvedCount,
			] = stepArr;

			texts[pane] = hydrate(newPaneTextIndices);
			merger.texts = texts;
			merger.differ.changeSequence(pane, start, sizechange, texts);

			// 1. Verify internal diffs
			const tsDiffs = merger.differ.diffs;
			for (let dIdx = 0; dIdx < 2; dIdx++) {
				// biome-ignore lint/style/noNonNullAssertion: safe in controlled test
				const expectedDiffs = expectedDiffsGroup[dIdx]!;
				// biome-ignore lint/style/noNonNullAssertion: safe in controlled test
				const actualDiffs = tsDiffs[dIdx]!;

				expect(actualDiffs.length).toBe(expectedDiffs.length);
				for (let cIdx = 0; cIdx < expectedDiffs.length; cIdx++) {
					// biome-ignore lint/style/noNonNullAssertion: safe in test
					const actualChunk = actualDiffs[cIdx]!;
					// biome-ignore lint/style/noNonNullAssertion: safe in test
					const expectedChunk = expectedDiffs[cIdx]!;

					// Tuple schema: [tag, startA, endA, startB, endB]
					expect(actualChunk.tag).toBe(expectedChunk[0]);
					expect(actualChunk.startA).toBe(expectedChunk[1]);
					expect(actualChunk.endA).toBe(expectedChunk[2]);
					expect(actualChunk.startB).toBe(expectedChunk[3]);
					expect(actualChunk.endB).toBe(expectedChunk[4]);
				}
			}

			// 2. Verify final merge output string
			expect(merger.merge3Files(true)).toBe(
				trace.t[expectedMergeResultIndex],
			);

			// 3. Verify unresolved count
			expect(merger.differ.getUnresolvedCount()).toBe(
				expectedUnresolvedCount,
			);
		}
	});
});

describe("Meld Step-by-Step Parity Trace: highlight validity", () => {
	test("highlights have no NaN and no out-of-bounds line numbers at every step", () => {
		const merger = new Merger();
		const t = hydrate(trace.it);
		const texts: string[][] = [t.slice(), t.slice(), t.slice()];
		merger.initialize(texts, texts);

		for (const stepArr of trace.s) {
			const [pane, start, sizechange, newPaneTextIndices] = stepArr;
			texts[pane] = hydrate(newPaneTextIndices);
			merger.texts = texts;
			merger.differ.changeSequence(pane, start, sizechange, texts);

			const highlightsByPane = webviewHighlights(merger.differ, texts);
			for (const highlights of highlightsByPane) {
				for (const hl of highlights) {
					expect(Number.isNaN(hl.startLine)).toBe(false);
					expect(Number.isNaN(hl.endLine)).toBe(false);
					expect(Number.isNaN(hl.startColumn)).toBe(false);
					expect(Number.isNaN(hl.endColumn)).toBe(false);
					expect(hl.startLine).toBeGreaterThanOrEqual(1);
					expect(hl.startColumn).toBeGreaterThanOrEqual(1);
				}
			}
		}
	});
});

describe("Meld Step-by-Step Parity Trace: incremental vs full recompute highlights", () => {
	test("incremental highlights match a full recompute at every step", () => {
		const merger = new Merger();
		const t = hydrate(trace.it);
		const texts: string[][] = [t.slice(), t.slice(), t.slice()];
		merger.initialize(texts, texts);

		for (const stepArr of trace.s) {
			const [pane, start, sizechange, newPaneTextIndices] = stepArr;
			texts[pane] = hydrate(newPaneTextIndices);
			merger.texts = texts;
			merger.differ.changeSequence(pane, start, sizechange, texts);

			const fresh = new Differ();
			fresh.setSequences(texts);

			expect(webviewHighlights(merger.differ, texts)).toEqual(
				webviewHighlights(fresh, texts),
			);
		}
	});
});
