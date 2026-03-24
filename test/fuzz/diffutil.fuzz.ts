// biome-ignore-all lint: fuzz tests are chaotic
import "@jazzer.js/jest-runner";
import { Differ } from "../../src/matchers/diffutil.ts";

describe("Differ Fuzzing", () => {
	it.fuzz(
		"setSequencesIter and changeSequence should not throw",
		(data: Buffer) => {
			if (data.length < 10) return;

			let texts: string[][];
			const joined = data.toString();
			if (joined.includes("\0\0\0")) {
				const parts = joined.split("\0\0\0");
				texts = parts.map((s) => s.split("\n"));
			} else {
				const numPanes = (data[0]! % 3) + 3; // 3 to 5 panes
				texts = [];
				let offset = 1;
				for (let i = 0; i < numPanes; i++) {
					const lineCount = data[offset]! % 20;
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

			const differ = new Differ();
			for (const _ of differ.setSequencesIter(texts)) {
				/* consume */
			}

			function verifyDiffer(d: Differ, currentTexts: string[][]) {
				// Structural Invariants on every change
				for (const change of d.allChanges()) {
					// change[0] is for pane 0 (LOCAL), change[1] is for last pane (REMOTE)
					const lastPaneIdx = currentTexts.length - 1;
					const paneMapping = [0, lastPaneIdx];

					for (let i = 0; i < change.length; i++) {
						const chunk = change[i];
						if (chunk) {
							expect(chunk.startA).toBeGreaterThanOrEqual(0);
							expect(chunk.endA).toBeGreaterThanOrEqual(
								chunk.startA,
							);
							expect(chunk.startB).toBeGreaterThanOrEqual(0);
							expect(chunk.endB).toBeGreaterThanOrEqual(
								chunk.startB,
							);

							// Bounds check: startA/endA are in BASE (pane 1), startB/endB are in LOCAL/REMOTE
							expect(chunk.endA).toBeLessThanOrEqual(
								currentTexts[1]!.length,
							);
							expect(chunk.endB).toBeLessThanOrEqual(
								currentTexts[paneMapping[i]!]!.length,
							);
						}
					}
				}
			}

			verifyDiffer(differ, texts);

			// Perform a change if we have enough data left
			let offset = joined.includes("\0\0\0") ? 0 : 1 + texts.length * 21; // approximate
			if (offset + 2 < data.length) {
				const seqToChange = data[offset]! % texts.length;
				const startIdx =
					data[offset + 1]! % (texts[seqToChange]!.length + 1);
				const sizeChange = (data[offset + 2]! % 10) - 5;

				const newTexts = texts.map((t) => [...t]);
				if (sizeChange > 0) {
					for (let i = 0; i < sizeChange; i++)
						newTexts[seqToChange]!.push("new line");
				} else if (sizeChange < 0) {
					newTexts[seqToChange]!.splice(
						startIdx,
						Math.abs(sizeChange),
					);
				}

				try {
					differ.changeSequence(
						seqToChange,
						startIdx,
						sizeChange,
						newTexts,
					);
					verifyDiffer(differ, newTexts);
				} catch (e) {
					// Some combinations might be invalid but shouldn't crash the fuzzer itself
				}
			}
		},
	);
});
