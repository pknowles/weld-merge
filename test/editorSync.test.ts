import { describe, expect, it } from "@jest/globals";
import { classifyDocumentChange } from "../src/webview/editorSync.ts";

// classifyDocumentChange only reads versionBeforeEdit; cast the rest away.
function makeState(versionBeforeEdit: number | undefined) {
	return { versionBeforeEdit } as never;
}

// ─── classifyDocumentChange ───────────────────────────────────────────────────
// Three-way classification of a document version change:
//   "externalEdit"  — no edit in progress (another tool changed the document)
//   "suppress"      — our own edit echoed back (version +1 exactly)
//   "fullSync"      — concurrent edit during our await (version jumped ≥2)

describe("classifyDocumentChange", () => {
	it("externalEdit when versionBeforeEdit is undefined (no edit in progress)", () => {
		expect(classifyDocumentChange(10, makeState(undefined))).toBe(
			"externalEdit",
		);
	});

	it("externalEdit regardless of version when no edit is in progress", () => {
		expect(classifyDocumentChange(1, makeState(undefined))).toBe(
			"externalEdit",
		);
		expect(classifyDocumentChange(999, makeState(undefined))).toBe(
			"externalEdit",
		);
	});

	it("suppress when new version is exactly versionBeforeEdit + 1 (our echo)", () => {
		expect(classifyDocumentChange(6, makeState(5))).toBe("suppress");
	});

	it("fullSync when new version is versionBeforeEdit + 2 (concurrent edit)", () => {
		expect(classifyDocumentChange(7, makeState(5))).toBe("fullSync");
	});

	it("fullSync when new version jumps by more than 2", () => {
		expect(classifyDocumentChange(20, makeState(5))).toBe("fullSync");
	});

	it("fullSync when new version equals versionBeforeEdit (no increment)", () => {
		expect(classifyDocumentChange(5, makeState(5))).toBe("fullSync");
	});

	it("suppress boundary: versionBeforeEdit=0, newVersion=1", () => {
		expect(classifyDocumentChange(1, makeState(0))).toBe("suppress");
	});

	it("fullSync boundary: versionBeforeEdit=0, newVersion=2", () => {
		expect(classifyDocumentChange(2, makeState(0))).toBe("fullSync");
	});
});
