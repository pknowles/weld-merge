// biome-ignore-all lint: fuzz tests are chaotic
import "@jazzer.js/jest-runner";
import { Merger } from "../../src/matchers/merge.ts";

describe("Merger Fuzzing", () => {
	it.fuzz("initialize and merge3Files should not throw", (data: Buffer) => {
		if (data.length < 3) return;

		const texts: string[][] = [];
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

		if (texts.length < 3) return;

		const merger = new Merger();
		const init = merger.initialize(texts, texts);
		for (const _ of init) {
			// consume generator
		}

		const mergeGen = merger.merge3Files(true);
		for (const _ of mergeGen) {
			// consume generator
		}
	});
});
