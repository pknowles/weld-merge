// biome-ignore-all lint: fuzz tests are chaotic
import "@jazzer.js/jest-runner";
import { Merger } from "../../src/matchers/merge.ts";

describe("Merger Fuzzing", () => {
	it.fuzz("initialize and merge3Files should not throw", (data: Buffer) => {
		if (data.length < 3) return;

		let texts: string[][];
		// Detect corpus format (split by \0\0\0)
		const joined = data.toString();
		if (joined.includes("\0\0\0")) {
			const parts = joined.split("\0\0\0");
			if (parts.length < 3) return;
			texts = parts.map((s) => s.split("\n"));
		} else {
			// Random format
			texts = [];
			let offset = 0;
			for (let i = 0; i < 3; i++) {
				const lineCount = (data[offset] || 0) % 10;
				offset++;
				const lines: string[] = [];
				for (let j = 0; j < lineCount; j++) {
					if (offset >= data.length) break;
					lines.push(`Line ${data[offset]!}`);
					offset++;
				}
				texts.push(lines);
			}
		}

		if (texts.length < 3) return;

		function runMerge(local: string[][], remote: string[][]) {
			const merger = new Merger();
			for (const _ of merger.initialize(local, remote)) {
				/* consume */
			}
			// Merger.merge3Files yields nulls and returns the merged string.
			// To check chunks, we can iterate over differ.allChanges()
			const gen = merger.merge3Files(true);
			while (!gen.next().done) {
				/* consume nulls */
			}

			// Validate structural invariants on the differ's changes
			for (const change of merger.differ.allChanges()) {
				for (const chunk of change) {
					if (chunk) {
						expect(chunk.startA).toBeGreaterThanOrEqual(0);
						expect(chunk.endA).toBeGreaterThanOrEqual(chunk.startA);
						expect(chunk.startB).toBeGreaterThanOrEqual(0);
						expect(chunk.endB).toBeGreaterThanOrEqual(chunk.startB);
					}
				}
			}
			return merger;
		}

		// Initial run
		runMerge(texts, texts);

		// Operational Equivalence: Identity
		// merge(A, A, A) -> check if all chunks are 'equal'
		const identityMerger = new Merger();
		const sameTexts = [texts[0]!, texts[0]!, texts[0]!];
		for (const _ of identityMerger.initialize(sameTexts, sameTexts)) {
			/* consume */
		}
		const identityGen = identityMerger.merge3Files(true);
		while (!identityGen.next().done) {
			/* consume */
		}
		for (const change of identityMerger.differ.allChanges()) {
			for (const chunk of change) {
				if (chunk) {
					expect(chunk.tag).toBe("equal");
				}
			}
		}

		// Operational Equivalence: Convergence (LOCAL == REMOTE)
		if (texts[0] && texts[1]) {
			const convMerger = new Merger();
			const convTexts = [texts[0]!, texts[1]!, texts[0]!];
			for (const _ of convMerger.initialize(convTexts, convTexts)) {
				/* consume */
			}
			const convGen = convMerger.merge3Files(true);
			while (!convGen.next().done) {
				/* consume */
			}
			for (const change of convMerger.differ.allChanges()) {
				const [c0, c1] = change;
				if (c0 && c1) {
					// Both sides must agree on the tag and range
					expect(c0.tag).toBe(c1.tag);
					expect(c0.startB).toBe(c1.startB);
					expect(c0.endB).toBe(c1.endB);
					// If they agree, it shouldn't be a conflict
					expect(c0.tag).not.toBe("conflict");
				} else if (c0 || c1) {
					// If one side has a chunk, the other must too (since LOCAL == REMOTE)
					throw new Error(
						`Asymmetric chunks in convergence test: ${JSON.stringify(change)}`,
					);
				}
			}
		}
	});
});
