import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "@jest/globals";
import { Merger } from "../src/matchers/merge.ts";

describe("Merger", () => {
	let merger: Merger;

	beforeEach(() => {
		merger = new Merger();
	});

	it("can initialize", () => {
		const sequences = [
			["line1\n", "line2\n", "line3\n"], // LOCAL
			["line1\n", "line2\n", "line3\n"], // BASE
			["line1\n", "line2\n", "line3\n"], // REMOTE
		];

		merger.initialize(sequences, sequences);

		expect(merger.texts).toBe(sequences);
	});

	it("handles Delete/Delete splitting heuristics", () => {
		const local = ["A\n", "B\n", "C\n"];
		const base = ["A\n", "B\n", "C\n"];
		const remote = ["A\n", "C\n"]; // B deleted

		const sequences = [local, base, remote];
		merger.initialize(sequences, sequences);

		const finalMergedText = merger.merge3Files(true);

		expect(finalMergedText).not.toBeNull();
	});
});

describe("End-to-End Meld Parity", () => {
	it("matches exact output of the original Python Meld backend", () => {
		const testCasesPath = require.resolve("./test_cases.txt");
		const expectedOutputsPath = require.resolve("./expected_outputs.txt");

		const casesContent = readFileSync(testCasesPath, "utf-8");
		const expectedContent = readFileSync(expectedOutputsPath, "utf-8");

		// Split exact same way python does
		const cases = casesContent
			.trim()
			.split("---")
			.filter((c) => c.trim() !== "");
		const expected = expectedContent.trim().split("\n---\n");

		expect(cases.length).toBe(expected.length);

		for (let i = 0; i < cases.length; i++) {
			const rawCase = cases[i];
			if (!rawCase) {
				continue;
			}

			const parts = rawCase.trim().split("===");

			// Replicate the python reading logic EXACTLY
			const extract = (part: string | undefined) =>
				(part || "")
					.trim()
					.split("\n")
					.filter((p) => p !== "");
			const local = extract(parts[0]);
			const base = extract(parts[1]);
			const remote = extract(parts[2]);

			const merger = new Merger();
			const sequences = [local, base, remote];

			merger.initialize(sequences, sequences);

			const finalMergedText = merger.merge3Files(true);

			// Note: Since our version drops trailing newlines from lines and expected includes them (because of "\n".join())
			expect(finalMergedText).toBe(expected[i]);
		}
	});
});
