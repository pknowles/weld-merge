import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "@jest/globals";
import { Differ } from "../src/matchers/diffutil.ts";
import { Merger } from "../src/matchers/merge.ts";
import { getPaneHighlights } from "../src/webview/ui/highlightUtil.ts";
import {
	applyMeldStyleContentChanges,
	contentChangeForFullReplacementFromLines,
} from "../src/webview/ui/mergedPaneEdits.ts";
import type { DiffChunk, FileState } from "../src/webview/ui/types.ts";

const parseMeldTestCases = (): [string[], string[], string[]][] => {
	const raw = readFileSync(
		join(process.cwd(), "test/test_cases.txt"),
		"utf-8",
	);
	return raw
		.trim()
		.split("---")
		.filter((s) => s.trim() !== "")
		.map((c) => {
			const parts = c.trim().split("===");
			const extract = (p: string | undefined) =>
				(p ?? "")
					.trim()
					.split("\n")
					.filter((l) => l !== "");
			return [
				extract(parts[0]),
				extract(parts[1]),
				extract(parts[2]),
			] as [string[], string[], string[]];
		});
};

const toFiles = (texts: string[][]): FileState[] =>
	texts.slice(0, 3).map((lines, i) => ({
		label: ["local", "base", "remote"][i] ?? "",
		content: lines.join("\n"),
		lines,
	}));

const toWebviewFiles = (
	local: string[],
	merged: string[],
	remote: string[],
): [null, FileState, FileState, FileState, null] => [
	null,
	{ label: "Local", content: local.join("\n"), lines: local },
	{ label: "Merged", content: merged.join("\n"), lines: merged },
	{ label: "Remote", content: remote.join("\n"), lines: remote },
	null,
];

const webviewDiffsFromMergeCache = (
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

const merge3 = (local: string[], base: string[], remote: string[]) => {
	const merger = new Merger();
	merger.initialize([local, base, remote], [local, base, remote]);
	return merger.merge3Files(true).split("\n");
};

const applyWebviewWholeBufferUpdate = (
	differ: Differ,
	local: string[],
	merged: string[],
	remote: string[],
	newMerged: string[],
) => {
	applyMeldStyleContentChanges(differ, local, merged, remote, [
		contentChangeForFullReplacementFromLines(merged, newMerged.join("\n")),
	]);
};

const highlights = (
	texts: string[][],
): ReturnType<typeof getPaneHighlights>[] => {
	const d = new Differ();
	d.setSequences(texts);
	const files = toFiles(texts);
	return [0, 1, 2].map((p) =>
		getPaneHighlights(p, files, d.diffs, false, false),
	);
};

describe("edit-then-revert round-trip: highlights match a fresh recompute after revert", () => {
	it("single-line base edit and revert", () => {
		const left = ["a", "b", "c", "d", "e"];
		const base = ["a", "b", "c", "d", "e"];
		const right = ["a", "X", "c", "X", "e"];
		const files = toFiles([left, base, right]);

		const incr = new Differ();
		incr.setSequences([left, base, right]);
		incr.changeSequence(1, 1, 0, [
			left,
			["a", "EDIT", "c", "d", "e"],
			right,
		]);
		incr.changeSequence(1, 1, 0, [left, base, right]);

		const incrH = [0, 1, 2].map((p) =>
			getPaneHighlights(p, files, incr.diffs, false, false),
		);
		expect(incrH).toEqual(highlights([left, base, right]));
	});

	it("multi-line insert and revert on base pane", () => {
		const left = ["a", "b", "c"];
		const base = ["a", "b", "c"];
		const right = ["a", "X", "c"];
		const files = toFiles([left, base, right]);

		const incr = new Differ();
		incr.setSequences([left, base, right]);
		incr.changeSequence(1, 2, 3, [
			left,
			["a", "b", "NEW1", "NEW2", "NEW3", "c"],
			right,
		]);
		incr.changeSequence(1, 2, -3, [left, base, right]);

		const incrH = [0, 1, 2].map((p) =>
			getPaneHighlights(p, files, incr.diffs, false, false),
		);
		expect(incrH).toEqual(highlights([left, base, right]));
	});

	it("large deletion and revert", () => {
		const base = Array.from({ length: 50 }, (_, i) => `line${i}`);
		const left = base.map((l, i) => (i % 5 === 0 ? `LEFT_${l}` : l));
		const right = base.map((l, i) => (i % 7 === 0 ? `RIGHT_${l}` : l));
		const files = toFiles([left, base, right]);

		const incr = new Differ();
		incr.setSequences([left, base, right]);
		incr.changeSequence(1, 15, -20, [
			left,
			[...base.slice(0, 15), ...base.slice(35)],
			right,
		]);
		incr.changeSequence(1, 15, 20, [left, base, right]);

		const incrH = [0, 1, 2].map((p) =>
			getPaneHighlights(p, files, incr.diffs, false, false),
		);
		expect(incrH).toEqual(highlights([left, base, right]));
	});

	it("left pane edit and revert", () => {
		const left = ["function foo() {", "  return 1;", "}"];
		const base = ["function foo() {", "  return 1;", "}"];
		const right = ["function foo() {", "  return 42;", "}"];
		const files = toFiles([left, base, right]);

		const incr = new Differ();
		incr.setSequences([left, base, right]);
		incr.changeSequence(0, 1, 0, [
			["function foo() {", "  return 999;", "}"],
			base,
			right,
		]);
		incr.changeSequence(0, 1, 0, [left, base, right]);

		const incrH = [0, 1, 2].map((p) =>
			getPaneHighlights(p, files, incr.diffs, false, false),
		);
		expect(incrH).toEqual(highlights([left, base, right]));
	});
});

describe("edit-then-revert larger sequences: highlights match a fresh recompute", () => {
	it("highlights after large edit+revert match fresh setSequences", () => {
		const base = Array.from({ length: 30 }, (_, i) => `line${i}`);
		const left = base.map((l, i) => (i % 3 === 0 ? `L_${l}` : l));
		const right = base.map((l, i) => (i % 4 === 0 ? `R_${l}` : l));
		const files = toFiles([left, base, right]);

		const incr = new Differ();
		incr.setSequences([left, base, right]);
		incr.changeSequence(1, 10, -10, [
			left,
			[...base.slice(0, 10), ...base.slice(20)],
			right,
		]);
		incr.changeSequence(1, 10, 10, [left, base, right]);

		const incrH = [0, 1, 2].map((p) =>
			getPaneHighlights(p, files, incr.diffs, false, false),
		);
		expect(incrH).toEqual(highlights([left, base, right]));
	});

	it("sequence of interleaved edits matches fresh recompute at each step", () => {
		const left = ["alpha", "beta", "gamma", "delta", "epsilon"];
		const base = ["alpha", "beta", "gamma", "delta", "epsilon"];
		const right = ["alpha", "CHANGE", "gamma", "CHANGE", "epsilon"];

		const incr = new Differ();
		incr.setSequences([left, base, right]);

		const steps: Array<{
			seq: number;
			start: number;
			size: number;
			texts: string[][];
		}> = [
			{
				seq: 1,
				start: 1,
				size: 0,
				texts: [
					left,
					["alpha", "TEMP1", "gamma", "delta", "epsilon"],
					right,
				],
			},
			{
				seq: 1,
				start: 3,
				size: 0,
				texts: [
					left,
					["alpha", "TEMP1", "gamma", "TEMP2", "epsilon"],
					right,
				],
			},
			{
				seq: 1,
				start: 1,
				size: 0,
				texts: [
					left,
					["alpha", "beta", "gamma", "TEMP2", "epsilon"],
					right,
				],
			},
			{
				seq: 1,
				start: 3,
				size: 0,
				texts: [
					left,
					["alpha", "beta", "gamma", "delta", "epsilon"],
					right,
				],
			},
		];

		for (const { seq, start, size, texts } of steps) {
			incr.changeSequence(seq, start, size, texts);
			const files = toFiles(texts);
			const incrH = [0, 1, 2].map((p) =>
				getPaneHighlights(p, files, incr.diffs, false, false),
			);
			expect(incrH).toEqual(highlights(texts));
		}
	});
});

describe("Meld test cases: incremental highlights match fresh recompute after procedural edits", () => {
	it("replace first base line then restore", () => {
		for (const [local, base, remote] of parseMeldTestCases()) {
			if (base.length === 0) {
				continue;
			}
			const files = toFiles([local, base, remote]);
			const incr = new Differ();
			incr.setSequences([local, base, remote]);
			incr.changeSequence(1, 0, 0, [
				local,
				["SENTINEL_ROUNDTRIP", ...base.slice(1)],
				remote,
			]);
			incr.changeSequence(1, 0, 0, [local, base, remote]);
			const incrH = [0, 1, 2].map((p) =>
				getPaneHighlights(p, files, incr.diffs, false, false),
			);
			expect(incrH).toEqual(highlights([local, base, remote]));
		}
	});

	it("delete first base line then restore", () => {
		for (const [local, base, remote] of parseMeldTestCases()) {
			if (base.length < 2) {
				continue;
			}
			const files = toFiles([local, base, remote]);
			const incr = new Differ();
			incr.setSequences([local, base, remote]);
			incr.changeSequence(1, 0, -1, [local, base.slice(1), remote]);
			incr.changeSequence(1, 0, 1, [local, base, remote]);
			const incrH = [0, 1, 2].map((p) =>
				getPaneHighlights(p, files, incr.diffs, false, false),
			);
			expect(incrH).toEqual(highlights([local, base, remote]));
		}
	});

	it("insert a line at start of base then remove it", () => {
		for (const [local, base, remote] of parseMeldTestCases()) {
			const files = toFiles([local, base, remote]);
			const incr = new Differ();
			incr.setSequences([local, base, remote]);
			incr.changeSequence(1, 0, 1, [
				local,
				["INSERTED_SENTINEL", ...base],
				remote,
			]);
			incr.changeSequence(1, 0, -1, [local, base, remote]);
			const incrH = [0, 1, 2].map((p) =>
				getPaneHighlights(p, files, incr.diffs, false, false),
			);
			expect(incrH).toEqual(highlights([local, base, remote]));
		}
	});
});

describe("webview-shaped merged-pane replacement", () => {
	const syntheticCase: [string, string[], string[], string[]] = [
		"interleaved synthetic changes",
		["a", "L1", "c", "L2", "e", "L3", "g"],
		["a", "base1", "c", "base2", "e", "base3", "g"],
		["a", "R1", "c", "R2", "e", "R3", "g"],
	];
	const meldCases: [string, string[], string[], string[]][] =
		parseMeldTestCases()
			.slice(-4)
			.map(([local, base, remote], i) => [
				`test_cases.txt trailing case ${i + 1}`,
				local,
				base,
				remote,
			]);

	it.each([
		syntheticCase,
		...meldCases,
	])("copying local into merged clears local-vs-merged diffs: %s", (_name, local, base, remote) => {
		const merged = merge3(local, base, remote);
		const newMerged = local.slice();
		const differ = new Differ();
		differ.setSequences([local, merged, remote]);

		applyWebviewWholeBufferUpdate(differ, local, merged, remote, newMerged);

		const diffs = webviewDiffsFromMergeCache(differ);
		expect(diffs[1]).toEqual([]);

		const files = toWebviewFiles(local, newMerged, remote);
		expect(getPaneHighlights(1, files, diffs, false, false)).toEqual([]);
	});

	it.each([
		syntheticCase,
		...meldCases,
	])("copying remote into merged clears remote-vs-merged diffs: %s", (_name, local, base, remote) => {
		const merged = merge3(local, base, remote);
		const newMerged = remote.slice();
		const differ = new Differ();
		differ.setSequences([local, merged, remote]);

		applyWebviewWholeBufferUpdate(differ, local, merged, remote, newMerged);

		const diffs = webviewDiffsFromMergeCache(differ);
		expect(diffs[2]).toEqual([]);

		const files = toWebviewFiles(local, newMerged, remote);
		expect(getPaneHighlights(3, files, diffs, false, false)).toEqual([]);
	});
});
