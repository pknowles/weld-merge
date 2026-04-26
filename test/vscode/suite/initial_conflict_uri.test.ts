import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { commands, extensions, Uri, window, workspace } from "vscode";
import type { WeldExtensionApi } from "../../../src/extension.ts";

// Reproduces the Compare feature's initial-conflict URI round-trip using the
// real VS Code host. setInitialConflictContent stores the original conflicted
// text under a URI built from the document URI with the scheme swapped to
// `weld-initial-conflict:`. The registered TextDocumentContentProvider must
// receive the same URI and look the content back up.
//
// Regression guard: an earlier version embedded an encoded form of the
// document URI into the conflict URI's path; Uri.parse decoded it during
// normalisation, so the provider's lookup key never matched what was stored.
//
// We obtain setInitialConflictContent via `ext.activate()` (not a source
// import) so that we write into the same module instance the extension's
// registered content provider reads from.

async function activateWeld(): Promise<WeldExtensionApi> {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	if (!ext) {
		throw new Error("weld extension must be discoverable");
	}
	return (await ext.activate()) as WeldExtensionApi;
}

describe("initial conflict content URI round-trip (VS Code host)", () => {
	it("openTextDocument on the returned URI yields the stored content", async () => {
		const api = await activateWeld();
		const docUri = Uri.file(
			`/tmp/weld-compare-roundtrip-${Date.now()}.txt`,
		);
		const content =
			"<<<<<<< HEAD\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> other\n";

		const conflictUri = api.setInitialConflictContent(docUri, content);
		const doc = await workspace.openTextDocument(conflictUri);
		try {
			assert.equal(doc.getText(), content);
		} finally {
			await window.showTextDocument(doc);
			await commands.executeCommand("workbench.action.closeActiveEditor");
		}
	});
});
