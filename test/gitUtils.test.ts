import { describe, expect, it } from "@jest/globals";
import { Uri } from "vscode";
import {
	getUnresolvedReasons,
	parseGitDirPointer,
	scanStrayMarkers,
} from "../src/gitUtils.ts";

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

// ─── scanStrayMarkers ─────────────────────────────────────────────────────────

describe("scanStrayMarkers", () => {
	it("returns nothing for clean content", () => {
		expect(
			scanStrayMarkers("normal file content\nno markers here"),
		).toEqual([]);
	});

	it("reports a full marker block as one range, not three", () => {
		const text =
			"before\n<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> b\nafter";
		const markers = scanStrayMarkers(text);
		expect(markers).toEqual([{ range: [2, 7], kind: "gitMarker" }]);
	});

	it("reports a standalone marker line outside any block as its own range", () => {
		const text = "before\n=======\nafter";
		expect(scanStrayMarkers(text)).toEqual([
			{ range: [2, 3], kind: "gitMarker" },
		]);
	});

	it("reports an unclosed block through end of file", () => {
		const text = "<<<<<<< HEAD\nlocal\n=======\nremote";
		const markers = scanStrayMarkers(text);
		expect(markers).toEqual([{ range: [1, 5], kind: "gitMarker" }]);
	});

	it("reports a Weld (??) sentinel as its own range, separate from git markers", () => {
		const text = "<<<<<<< HEAD\n(??) also here\n=======\n>>>>>>> b";
		const markers = scanStrayMarkers(text);
		expect(markers).toContainEqual({ range: [2, 3], kind: "weldSentinel" });
		expect(markers).toContainEqual({ range: [1, 5], kind: "gitMarker" });
	});

	it("does not detect markers that appear mid-line", () => {
		const text = "prefix <<<<<<< not a marker\nprefix (??) also not";
		expect(scanStrayMarkers(text)).toEqual([]);
	});

	// git's conflict-marker-size gitattribute lets a repo configure a marker
	// length other than the default 7 (this codebase's own
	// makeContextConflictWithMarkerStyle test fixture covers 4/9/10). Matching
	// a floor rather than the exact default is what makes those non-default
	// lengths detectable at all — see GIT_MARKER_START_REGEX's comment in
	// gitUtils.ts for why 4 specifically, and the noted TODO.md follow-up for
	// reading the real configured length instead of guessing a floor.
	for (const markerLength of [4, 7, 9, 10]) {
		it(`detects a configured ${markerLength}-character marker length`, () => {
			const start = "<".repeat(markerLength);
			const middle = "=".repeat(markerLength);
			const end = ">".repeat(markerLength);
			const text = `${start} HEAD\nlocal\n${middle}\nremote\n${end} branch`;
			const markers = scanStrayMarkers(text);
			expect(markers).toEqual([{ range: [1, 6], kind: "gitMarker" }]);
		});
	}

	it("does not detect a marker shorter than the length floor (known limitation)", () => {
		const text = "<<< HEAD\nlocal\n===\nremote\n>>> branch";
		expect(scanStrayMarkers(text)).toEqual([]);
	});

	it("agrees with getUnresolvedReasons on whether text has stray markers", () => {
		const clean = "clean text\nno markers";
		const withMarkers =
			"<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> b\n(??) also";
		expect(scanStrayMarkers(clean)).toEqual([]);
		expect(getUnresolvedReasons(clean)).toEqual([]);
		expect(scanStrayMarkers(withMarkers).length).toBeGreaterThan(0);
		expect(getUnresolvedReasons(withMarkers).length).toBeGreaterThan(0);
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
