import { describe, expect, it } from "@jest/globals";
import { GitTextMerger } from "../src/matchers/gitTextMerger.ts";

function runGitMerge(
	local: string[],
	base: string[],
	remote: string[],
	markConflicts = true,
) {
	const merger = new GitTextMerger();
	merger.initialize([local, base, remote], [local, base, remote]);
	const merged = merger.merge3FilesGit(markConflicts);
	return { merged, unresolved: merger.differ.unresolved };
}

describe("GitTextMerger/basic", () => {
	it("merges clean non-overlapping changes without conflict markers", () => {
		const local = ["header", "left-only", "base-line", "tail"];
		const base = ["header", "base-line", "tail"];
		const remote = ["header", "base-line", "right-only", "tail"];

		const { merged, unresolved } = runGitMerge(local, base, remote);

		expect(merged).toContain("left-only");
		expect(merged).toContain("right-only");
		expect(merged).not.toContain("<<<<<<< HEAD");
		expect(merged).not.toContain(">>>>>>> REMOTE");
		expect(unresolved).toEqual([]);
	});

	it("emits git-style conflict markers and tracks unresolved lines", () => {
		const local = ["keep", "local-change", "tail"];
		const base = ["keep", "base-line", "tail"];
		const remote = ["keep", "remote-change", "tail"];

		const { merged, unresolved } = runGitMerge(local, base, remote);
		const lines = merged.split("\n");

		expect(merged).toContain("<<<<<<< HEAD");
		expect(merged).toContain("||||||| BASE");
		expect(merged).toContain("=======");
		expect(merged).toContain(">>>>>>> REMOTE");

		const headIdx = lines.indexOf("<<<<<<< HEAD");
		const baseIdx = lines.indexOf("||||||| BASE");
		const sepIdx = lines.indexOf("=======");
		const remoteIdx = lines.indexOf(">>>>>>> REMOTE");

		expect(headIdx).toBeGreaterThan(-1);
		expect(baseIdx).toBeGreaterThan(headIdx);
		expect(sepIdx).toBeGreaterThan(baseIdx);
		expect(remoteIdx).toBeGreaterThan(sepIdx);

		expect(lines[headIdx + 1]).toBe("local-change");
		expect(lines[baseIdx + 1]).toBe("base-line");
		expect(lines[sepIdx + 1]).toBe("remote-change");

		expect(unresolved).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("applies single-sided changes without conflicts", () => {
		const local = ["one", "two-local", "three"];
		const base = ["one", "two-base", "three"];
		const remote = ["one", "two-base", "three"];

		const { merged, unresolved } = runGitMerge(local, base, remote);

		expect(merged).toBe("one\ntwo-local\nthree");
		expect(merged).not.toContain("<<<<<<< HEAD");
		expect(unresolved).toEqual([]);
	});

	it("keeps base content when conflicts are not marked", () => {
		const local = ["alpha", "local", "omega"];
		const base = ["alpha", "base", "omega"];
		const remote = ["alpha", "remote", "omega"];

		const { merged, unresolved } = runGitMerge(local, base, remote, false);

		expect(merged).toBe("alpha\nbase\nomega");
		expect(merged).not.toContain("<<<<<<< HEAD");
		expect(merged).not.toContain("||||||| BASE");
		expect(merged).not.toContain(">>>>>>> REMOTE");
		expect(unresolved).toEqual([]);
	});
});

describe("GitTextMerger/edge-cases", () => {
	it("handles empty base file with non-overlapping additions", () => {
		const local = ["local-line"];
		const base: string[] = [];
		const remote = ["remote-line"];

		const { merged, unresolved } = runGitMerge(local, base, remote);

		expect(merged).toContain("local-line");
		expect(merged).toContain("remote-line");
		expect(unresolved.length).toBeGreaterThan(0);
	});

	it("places conflict markers at file start when first line conflicts", () => {
		const local = ["local-first", "same"];
		const base = ["base-first", "same"];
		const remote = ["remote-first", "same"];

		const { merged } = runGitMerge(local, base, remote);

		expect(merged.startsWith("<<<<<<< HEAD")).toBe(true);
		expect(merged).toContain("local-first");
		expect(merged).toContain("base-first");
		expect(merged).toContain("remote-first");
	});

	it("places conflict markers at file end when last line conflicts", () => {
		const local = ["same", "local-last"];
		const base = ["same", "base-last"];
		const remote = ["same", "remote-last"];

		const { merged } = runGitMerge(local, base, remote);
		const lines = merged.split("\n");

		expect(lines.at(-1)).toBe(">>>>>>> REMOTE");
		expect(merged).toContain("local-last");
		expect(merged).toContain("remote-last");
	});

	it("captures all content when multiple adjacent lines conflict", () => {
		const local = ["local-A", "local-B", "tail"];
		const base = ["base-A", "base-B", "tail"];
		const remote = ["remote-A", "remote-B", "tail"];

		const { merged, unresolved } = runGitMerge(local, base, remote);

		expect(merged).toContain("local-A");
		expect(merged).toContain("local-B");
		expect(merged).toContain("base-A");
		expect(merged).toContain("base-B");
		expect(merged).toContain("remote-A");
		expect(merged).toContain("remote-B");
		expect(unresolved.length).toBeGreaterThan(0);
	});
});
