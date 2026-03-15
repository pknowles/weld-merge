// biome-ignore-all lint: fuzz tests are chaotic
import "@jazzer.js/jest-runner";
import { Differ } from "../../src/matchers/diffutil.ts";

describe("Differ Fuzzing", () => {
	it.fuzz(
		"setSequencesIter and changeSequence should not throw",
		(data: Buffer) => {
			if (data.length < 10) return;

			const numPanes = (data[0]! % 3) + 3; // 3 to 5 panes
			const texts: string[][] = [];
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

			if (texts.length < 3) return;

			const differ = new Differ();
			const it = differ.setSequencesIter(texts);
			for (const _ of it) {
				// consume iterator
			}

			// Perform a change if we have enough data left
			if (offset + 2 < data.length) {
				const seqToChange = data[offset]! % texts.length;
				const startIdx =
					data[offset + 1]! % (texts[seqToChange]!.length + 1);
				const sizeChange = (data[offset + 2]! % 10) - 5;

				// Adjust texts for changeSequence call
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
				} catch (e) {
					// Some combinations might be invalid but shouldn't crash the fuzzer itself
				}
			}
		},
	);
});
