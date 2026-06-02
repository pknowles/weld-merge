import { describe, expect, it } from "@jest/globals";
import { Uri } from "vscode";
import {
	parseCommitBlob,
	parseCommitLogOutput,
	parseShaLines,
	parseSubmoduleConflictUri,
	submoduleConflictUri,
} from "../src/submoduleConflict.ts";

// Field separator used by git log --format=%x01
const SEP = "\x01";
// Record separator used by git log --format=%x00
const RS = "\x00";

const WRONG_FIELD_COUNT_PATTERN = /11 fields/;

// Builds a minimal valid commit blob with all 11 required fields.
function makeBlob(
	overrides: Partial<{
		hash: string;
		shortHash: string;
		authorName: string;
		authorEmail: string;
		authorDate: string;
		committerName: string;
		committerEmail: string;
		committerDate: string;
		parents: string;
		refs: string;
		body: string;
	}> = {},
): string {
	const f = {
		hash: "abc123def456abc123def456abc123def456abc1",
		shortHash: "abc123d",
		authorName: "Alice",
		authorEmail: "alice@example.com",
		authorDate: "2024-01-15T10:00:00+00:00",
		committerName: "Alice",
		committerEmail: "alice@example.com",
		committerDate: "2024-01-15T10:00:00+00:00",
		parents: "deadbeef1234deadbeef1234deadbeef12345678",
		refs: "HEAD -> main",
		body: "fix: resolve the issue\n\nDetailed explanation here.",
		...overrides,
	};
	return [
		f.hash,
		f.shortHash,
		f.authorName,
		f.authorEmail,
		f.authorDate,
		f.committerName,
		f.committerEmail,
		f.committerDate,
		f.parents,
		f.refs,
		f.body,
	].join(SEP);
}

// ─── parseShaLines ────────────────────────────────────────────────────────────

describe("parseShaLines", () => {
	it("returns empty array for empty output", () => {
		expect(parseShaLines("")).toEqual([]);
	});

	it("returns empty array for whitespace-only output", () => {
		expect(parseShaLines("   \n  \n")).toEqual([]);
	});

	it("parses a single SHA", () => {
		expect(parseShaLines("abc123\n")).toEqual(["abc123"]);
	});

	it("parses multiple SHAs, one per line", () => {
		expect(parseShaLines("sha1\nsha2\nsha3\n")).toEqual([
			"sha1",
			"sha2",
			"sha3",
		]);
	});

	it("trims whitespace from each SHA", () => {
		expect(parseShaLines("  sha1  \n  sha2  \n")).toEqual(["sha1", "sha2"]);
	});
});

// ─── parseCommitBlob ─────────────────────────────────────────────────────────

describe("parseCommitBlob", () => {
	it("parses a well-formed commit blob into a CommitInfo", () => {
		const blob = makeBlob();
		const commit = parseCommitBlob(blob);
		expect(commit.hash).toBe("abc123def456abc123def456abc123def456abc1");
		expect(commit.shortHash).toBe("abc123d");
		expect(commit.authorName).toBe("Alice");
		expect(commit.authorEmail).toBe("alice@example.com");
	});

	it("extracts the subject as the first non-empty body line", () => {
		const blob = makeBlob({ body: "fix: the thing\n\nBody here." });
		expect(parseCommitBlob(blob).subject).toBe("fix: the thing");
	});

	it("extracts message as body lines after the subject", () => {
		const blob = makeBlob({ body: "subject\n\nbody line 1\nbody line 2" });
		const commit = parseCommitBlob(blob);
		expect(commit.message).toContain("body line 1");
		expect(commit.message).toContain("body line 2");
		expect(commit.message).not.toContain("subject");
	});

	it("sets subject to empty string when body has no non-blank lines", () => {
		const blob = makeBlob({ body: "   \n\n  " });
		expect(parseCommitBlob(blob).subject).toBe("");
	});

	it("parses multiple parents as an array", () => {
		const blob = makeBlob({ parents: "sha1111 sha2222" });
		expect(parseCommitBlob(blob).parents).toEqual(["sha1111", "sha2222"]);
	});

	it("parses a root commit with no parents as empty array", () => {
		const blob = makeBlob({ parents: "" });
		expect(parseCommitBlob(blob).parents).toEqual([]);
	});

	it("parses refs as a comma-separated array", () => {
		const blob = makeBlob({ refs: "HEAD -> main, tag: v1.0" });
		expect(parseCommitBlob(blob).refs).toEqual([
			"HEAD -> main",
			"tag: v1.0",
		]);
	});

	it("parses empty refs as empty array", () => {
		const blob = makeBlob({ refs: "" });
		expect(parseCommitBlob(blob).refs).toEqual([]);
	});

	it("sets files to null (files are loaded separately)", () => {
		expect(parseCommitBlob(makeBlob()).files).toBeNull();
	});

	it("throws for a blob with fewer than 11 fields", () => {
		const bad = "hash\x01short\x01name"; // only 3 fields
		expect(() => parseCommitBlob(bad)).toThrow(WRONG_FIELD_COUNT_PATTERN);
	});

	it("throws for a blob with more than 11 fields", () => {
		const extra = `${makeBlob()}${SEP}extra-field`;
		expect(() => parseCommitBlob(extra)).toThrow(WRONG_FIELD_COUNT_PATTERN);
	});
});

// ─── parseCommitLogOutput ─────────────────────────────────────────────────────

describe("parseCommitLogOutput", () => {
	it("returns empty array for empty output", () => {
		expect(parseCommitLogOutput("")).toEqual([]);
	});

	it("parses a single record", () => {
		const output = makeBlob() + RS;
		const commits = parseCommitLogOutput(output);
		expect(commits).toHaveLength(1);
		expect(commits[0]?.hash).toBe(
			"abc123def456abc123def456abc123def456abc1",
		);
	});

	it("parses multiple records separated by the record separator", () => {
		const output = [
			makeBlob({ hash: "a".repeat(40), shortHash: "aaaaaaa" }),
			makeBlob({ hash: "b".repeat(40), shortHash: "bbbbbbb" }),
		].join(RS);
		const commits = parseCommitLogOutput(output);
		expect(commits).toHaveLength(2);
		expect(commits[0]?.hash).toBe("a".repeat(40));
		expect(commits[1]?.hash).toBe("b".repeat(40));
	});

	it("skips blank records between separators", () => {
		const output = RS + makeBlob() + RS + RS;
		expect(parseCommitLogOutput(output)).toHaveLength(1);
	});
});

// ─── submoduleConflictUri / parseSubmoduleConflictUri round-trip ──────────────

describe("submoduleConflictUri and parseSubmoduleConflictUri", () => {
	const identity = {
		repositoryRoot: Uri.file("/repo/root"),
		submodulePath: "libs/mymodule",
	};

	it("round-trips identity through URI serialization", () => {
		const uri = submoduleConflictUri(identity);
		const parsed = parseSubmoduleConflictUri(uri);
		expect(parsed.submodulePath).toBe(identity.submodulePath);
		expect(parsed.repositoryRoot.toString()).toBe(
			identity.repositoryRoot.toString(),
		);
	});

	it("URI has the weld-submodule-conflict scheme", () => {
		expect(submoduleConflictUri(identity).scheme).toBe(
			"weld-submodule-conflict",
		);
	});

	it("URI path is based on the submodule basename", () => {
		expect(submoduleConflictUri(identity).path).toContain("mymodule");
	});

	it("throws for a URI missing required query parameters", () => {
		const bad = Uri.from({
			scheme: "weld-submodule-conflict",
			path: "/bad.weld-submodule-conflict",
			query: "onlyOneParam=x",
		});
		expect(() => parseSubmoduleConflictUri(bad)).toThrow();
	});
});
