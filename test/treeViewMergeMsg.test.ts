import { describe, expect, it } from "@jest/globals";
import { parseMergeMsgConflicts } from "../src/treeView.ts";

describe("parseMergeMsgConflicts", () => {
	it("parses commented Git conflict blocks in MERGE_MSG order", () => {
		const paths = parseMergeMsgConflicts([
			"Merge branch 'feature'",
			"",
			"# Conflicts:",
			"#\tsrc/a.ts",
			"#\tdocs/readme.md",
			"",
		]);

		expect(paths).toEqual(["src/a.ts", "docs/readme.md"]);
	});

	it("parses un-commented conflict blocks produced by plumbing callers", () => {
		const paths = parseMergeMsgConflicts([
			"Manual merge message",
			"",
			"Conflicts:",
			"\tsubmodule/path",
			"\ttracked.txt",
		]);

		expect(paths).toEqual(["submodule/path", "tracked.txt"]);
	});

	it("returns no paths when there is no conflict header", () => {
		const paths = parseMergeMsgConflicts([
			"Merge branch 'feature'",
			"#\tlooks-like-a-path-but-has-no-header",
		]);

		expect(paths).toEqual([]);
	});

	it("ignores malformed indentation and blank entries", () => {
		const paths = parseMergeMsgConflicts([
			"# Conflicts:",
			"#  src/not-tab-indented.ts",
			"##\talso-not-a-conflict-entry.ts",
			"#\t",
			"#\tvalid.ts",
		]);

		expect(paths).toEqual(["valid.ts"]);
	});

	it("deduplicates repeated conflict paths while preserving first occurrence", () => {
		const paths = parseMergeMsgConflicts([
			"# Conflicts:",
			"#\trepeated.ts",
			"#\tunique.ts",
			"#\trepeated.ts",
		]);

		expect(paths).toEqual(["repeated.ts", "unique.ts"]);
	});

	it("stops at a non-comment termination line", () => {
		const paths = parseMergeMsgConflicts([
			"# Conflicts:",
			"#\tbefore.txt",
			"Signed-off-by: User <user@example.com>",
			"#\tafter.txt",
		]);

		expect(paths).toEqual(["before.txt"]);
	});
});
