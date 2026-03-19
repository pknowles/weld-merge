import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { Merger } from "../src/matchers/merge.ts";

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

describe("Meld Step-by-Step Parity Trace", () => {
	const tracePath = join(testDir, "parity_trace.json");
	const trace: Trace = JSON.parse(readFileSync(tracePath, "utf-8"));

	/** Helper to map string indices back to lines */
	const hydrate = (indices: number[]) =>
		indices.map(
			(i) =>
				// biome-ignore lint/style/noNonNullAssertion: safe in controlled test
				trace.t[i]!,
		);

	test("matches internal diffs and merge results after 500+ stressful edits", () => {
		const merger = new Merger();
		const t = hydrate(trace.it);

		// Sync initial 3-pane state
		const texts: string[][] = [t.slice(), t.slice(), t.slice()];
		const init = merger.initialize(texts, texts);
		for (const _ of init) {
			/* consume */
		}

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

			// Reconstruct text for current step
			const newPaneTexts = hydrate(newPaneTextIndices);
			texts[pane] = newPaneTexts;
			merger.texts = texts;

			// Apply edit to TypeScript implementation
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
			const mergeGen = merger.merge3Files(true);
			let res = mergeGen.next();
			while (!res.done) {
				res = mergeGen.next();
			}
			const finalOutput = res.value as string;
			expect(finalOutput).toBe(trace.t[expectedMergeResultIndex]);

			// 3. Verify unresolved count (conflict mapping)
			expect(merger.differ.getUnresolvedCount()).toBe(
				expectedUnresolvedCount,
			);
		}
	});
});
