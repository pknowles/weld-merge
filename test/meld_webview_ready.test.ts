import { afterEach, describe, it } from "@jest/globals";
import { extractConflictLabels } from "../src/webview/conflictLabels.ts";
import {
	deleteInitialConflictContent,
	getInitialConflictContent,
	setInitialConflictContent,
} from "../src/webview/initialConflictContentStore.ts";
import {
	assertReadyMessageIsFirst,
	type ReadyState,
} from "../src/webview/readyStateGuard.ts";

const MISSING_CONTENT_PREFIX =
	/^No initial conflict content registered for URI /;

describe("readyStateGuard.assertReadyMessageIsFirst", () => {
	it("passes silently on the first call", () => {
		const state: ReadyState = {
			snapshot: null,
			handled: false,
			handling: false,
		};
		expect(() =>
			assertReadyMessageIsFirst(state, "file:///repo/conflict.txt"),
		).not.toThrow();
	});

	it("throws when a second ready arrives mid-handling", () => {
		const state: ReadyState = {
			snapshot: null,
			handled: false,
			handling: true,
		};
		expect(() =>
			assertReadyMessageIsFirst(state, "file:///repo/conflict.txt"),
		).toThrow(
			"Unexpected duplicate ready message for file:///repo/conflict.txt.",
		);
	});

	it("throws when a second ready arrives after completion", () => {
		const state: ReadyState = {
			snapshot: null,
			handled: true,
			handling: false,
		};
		expect(() =>
			assertReadyMessageIsFirst(state, "file:///repo/conflict.txt"),
		).toThrow(
			"Unexpected duplicate ready message for file:///repo/conflict.txt.",
		);
	});
});

describe("conflictLabels.extractConflictLabels", () => {
	it("extracts local/base/remote labels from full 3-way markers", () => {
		const labels = extractConflictLabels(
			[
				"<<<<<<< HEAD",
				"local",
				"||||||| base-commit",
				"base",
				"=======",
				"incoming",
				">>>>>>> feature-branch",
			].join("\n"),
		);
		expect(labels).toEqual({
			kind: "diff3",
			localLabel: "HEAD",
			baseLabel: "base-commit",
			remoteLabel: "feature-branch",
		});
	});

	it("extracts local/remote labels from normal 2-way markers", () => {
		const labels = extractConflictLabels(
			[
				"<<<<<<< HEAD",
				"local",
				"=======",
				"incoming",
				">>>>>>> feature-branch",
			].join("\n"),
		);
		expect(labels).toEqual({
			kind: "normal",
			localLabel: "HEAD",
			remoteLabel: "feature-branch",
		});
	});

	it("returns null when the text contains no markers", () => {
		expect(extractConflictLabels("just some regular text\n")).toBeNull();
	});
});

describe("initialConflictContentStore", () => {
	const conflictUri = "weld-initial-conflict:/repo/conflict-store-test.txt";

	afterEach(() => {
		deleteInitialConflictContent(conflictUri);
	});

	it("stores content and returns it via the same URI", () => {
		const content = "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch";
		setInitialConflictContent(conflictUri, content);
		expect(getInitialConflictContent(conflictUri)).toBe(content);
	});

	it("throws for URIs that have never been registered", () => {
		expect(() =>
			getInitialConflictContent("weld-initial-conflict:/not-stored"),
		).toThrow(
			'No initial conflict content registered for URI "weld-initial-conflict:/not-stored".',
		);
	});

	it("deletes content by the conflict URI", () => {
		setInitialConflictContent(conflictUri, "some text");
		deleteInitialConflictContent(conflictUri);
		expect(() => getInitialConflictContent(conflictUri)).toThrow(
			MISSING_CONTENT_PREFIX,
		);
	});
});
