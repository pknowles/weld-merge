import { describe, expect, it } from "@jest/globals";
import { Uri } from "vscode";
import {
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	isSupportedScheme,
	statusFromStages,
} from "../src/repoContext.ts";

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
	it("accepts file:// and vscode-remote:// URIs", () => {
		expect(isSupportedScheme(Uri.file("/some/path"))).toBe(true);
		expect(
			isSupportedScheme(
				Uri.from({ scheme: "vscode-remote", path: "/path" }),
			),
		).toBe(true);
	});

	it("rejects any other scheme", () => {
		expect(
			isSupportedScheme(Uri.from({ scheme: "untitled", path: "/x" })),
		).toBe(false);
		expect(
			isSupportedScheme(
				Uri.from({ scheme: "weld-initial-conflict", path: "/x" }),
			),
		).toBe(false);
	});
});
