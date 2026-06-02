import { describe, expect, it } from "@jest/globals";
import { Uri } from "vscode";

const UNKNOWN_STATUS_PATTERN = /UNKNOWN_STATUS_9999/;

import {
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	GitStatus,
	getGitStatusName,
	isSupportedScheme,
	statusFromStages,
} from "../src/repoContext.ts";

// ─── getGitStatusName ─────────────────────────────────────────────────────────

describe("getGitStatusName", () => {
	it("returns the name for a known status index", () => {
		// GitStatus values are assigned by index order in gitStatusNames.
		// BOTH_MODIFIED is the first entry (index 0).
		expect(getGitStatusName(GitStatus.BOTH_MODIFIED)).toBe("BOTH_MODIFIED");
	});

	it("returns BOTH_ADDED name for BOTH_ADDED status", () => {
		expect(getGitStatusName(GitStatus.BOTH_ADDED)).toBe("BOTH_ADDED");
	});

	it("returns DELETED_BY_US name for DELETED_BY_US status", () => {
		expect(getGitStatusName(GitStatus.DELETED_BY_US)).toBe("DELETED_BY_US");
	});

	it("returns DELETED_BY_THEM name for DELETED_BY_THEM status", () => {
		expect(getGitStatusName(GitStatus.DELETED_BY_THEM)).toBe(
			"DELETED_BY_THEM",
		);
	});

	it("returns BOTH_DELETED name for BOTH_DELETED status", () => {
		expect(getGitStatusName(GitStatus.BOTH_DELETED)).toBe("BOTH_DELETED");
	});

	it("returns a fallback string for an unknown status code", () => {
		expect(getGitStatusName(9999)).toMatch(UNKNOWN_STATUS_PATTERN);
	});

	it("is consistent: name round-trips through the GitStatus map", () => {
		// Every known status code should produce its own name.
		for (const [name, code] of Object.entries(GitStatus)) {
			expect(getGitStatusName(code)).toBe(name);
		}
	});
});

// ─── statusFromStages ─────────────────────────────────────────────────────────
// Determines conflict kind from which git index stages are readable.

describe("statusFromStages", () => {
	it("both stages present → bothModified", () => {
		expect(statusFromStages("local-content", "remote-content")).toEqual({
			kind: "bothModified",
		});
	});

	it("local present, remote absent → deleteModify with LOCAL remaining", () => {
		const result = statusFromStages("local-content", null);
		expect(result).toEqual({
			kind: "deleteModify",
			remainingStage: GIT_STAGE_LOCAL,
		});
	});

	it("local absent, remote present → deleteModify with REMOTE remaining", () => {
		const result = statusFromStages(null, "remote-content");
		expect(result).toEqual({
			kind: "deleteModify",
			remainingStage: GIT_STAGE_REMOTE,
		});
	});

	it("both absent → bothDeleted", () => {
		expect(statusFromStages(null, null)).toEqual({ kind: "bothDeleted" });
	});

	it("empty string counts as present (non-null content)", () => {
		// An empty file is still a readable stage — different from null (missing).
		expect(statusFromStages("", "remote")).toEqual({
			kind: "bothModified",
		});
	});
});

// ─── isSupportedScheme ────────────────────────────────────────────────────────

describe("isSupportedScheme", () => {
	it("accepts file:// URIs", () => {
		expect(isSupportedScheme(Uri.file("/some/path"))).toBe(true);
	});

	it("accepts vscode-remote:// URIs", () => {
		const remote = Uri.from({ scheme: "vscode-remote", path: "/path" });
		expect(isSupportedScheme(remote)).toBe(true);
	});

	it("rejects untitled:// URIs", () => {
		const untitled = Uri.from({ scheme: "untitled", path: "/scratch" });
		expect(isSupportedScheme(untitled)).toBe(false);
	});

	it("rejects weld-initial-conflict:// URIs", () => {
		const internal = Uri.from({
			scheme: "weld-initial-conflict",
			path: "/conflict",
		});
		expect(isSupportedScheme(internal)).toBe(false);
	});

	it("rejects unknown schemes", () => {
		const unknown = Uri.from({ scheme: "http", path: "/x" });
		expect(isSupportedScheme(unknown)).toBe(false);
	});
});
