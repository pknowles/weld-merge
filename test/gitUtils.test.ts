import { describe, expect, it } from "@jest/globals";
import { Uri } from "vscode";
import { getUnresolvedReasons, parseGitDirPointer } from "../src/gitUtils.ts";

// ─── getUnresolvedReasons ─────────────────────────────────────────────────────

describe("getUnresolvedReasons", () => {
	it("returns empty array for clean content", () => {
		expect(
			getUnresolvedReasons("normal file content\nno markers here"),
		).toEqual([]);
	});

	it("detects git-style conflict markers", () => {
		const text =
			"some text\n<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> branch\n";
		const reasons = getUnresolvedReasons(text);
		expect(reasons).toContain("merge conflict markers");
	});

	it("detects (??) markers from the JS merger", () => {
		const text = "line\n(??) conflict here\nmore lines";
		const reasons = getUnresolvedReasons(text);
		expect(reasons).toContain("(??) markers");
	});

	it("detects both marker types in the same file", () => {
		const text =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>>\n(??) also here";
		const reasons = getUnresolvedReasons(text);
		expect(reasons).toContain("merge conflict markers");
		expect(reasons).toContain("(??) markers");
	});

	it("only reports each marker type once even with multiple occurrences", () => {
		const text =
			"<<<<<<< A\n=======\n>>>>>>> B\n<<<<<<< C\n=======\n>>>>>>> D\n";
		const reasons = getUnresolvedReasons(text);
		expect(
			reasons.filter((r) => r === "merge conflict markers"),
		).toHaveLength(1);
	});

	it("does not detect markers that appear mid-line (must be line-start)", () => {
		const text = "prefix <<<<<<< not a marker\nprefix (??) also not";
		expect(getUnresolvedReasons(text)).toEqual([]);
	});

	it("detects ======= as a conflict marker", () => {
		const text = "=======\n";
		expect(getUnresolvedReasons(text)).toContain("merge conflict markers");
	});

	it("detects ||||||| (diff3 base marker) as a conflict marker", () => {
		const text = "||||||| base\n";
		expect(getUnresolvedReasons(text)).toContain("merge conflict markers");
	});
});

// ─── parseGitDirPointer ───────────────────────────────────────────────────────

describe("parseGitDirPointer", () => {
	const root = Uri.file("/repo");

	it("absolute path: returns uri with that path", () => {
		const result = parseGitDirPointer("/absolute/.git", root);
		expect(result.path).toBe("/absolute/.git");
	});

	it("relative path: resolves against repo root", () => {
		const result = parseGitDirPointer("subdir/.git", root);
		expect(result.path).toBe("/repo/subdir/.git");
	});

	it("relative path with subdirectories: resolves all segments", () => {
		const result = parseGitDirPointer("a/b/c", root);
		expect(result.path).toBe("/repo/a/b/c");
	});

	it("trims leading and trailing whitespace from pointer", () => {
		const result = parseGitDirPointer("  /trimmed/.git  \n", root);
		expect(result.path).toBe("/trimmed/.git");
	});

	it("throws for an empty or whitespace-only pointer", () => {
		expect(() => parseGitDirPointer("", root)).toThrow();
		expect(() => parseGitDirPointer("   \n", root)).toThrow();
	});

	it("preserves the scheme from the repo root uri", () => {
		// Relative resolution inherits the root's scheme.
		const result = parseGitDirPointer("sub/.git", root);
		expect(result.scheme).toBe(root.scheme);
	});
});
