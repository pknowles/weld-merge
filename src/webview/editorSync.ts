// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import type { MonacoContentChange } from "./ui/types.ts";

interface EditState {
	editQueue: Promise<void>;
	lastExternalChangeVersion: number;
	// Set to document.version right before applyEdit(), cleared after.
	// undefined = not applying; number = applying, this was version before.
	versionBeforeEdit: number | undefined;
}

interface ProcessContentChangedArgs {
	changes: MonacoContentChange[];
	msgVersion: number;
	editState: EditState;
	currentDocumentVersion: number;
	applyEdit: (changes: MonacoContentChange[]) => Promise<void>;
	postFullSync: () => void;
}

/**
 * Determines what to do when a document change is detected.
 * Called from onDidChangeTextDocument handler.
 */
function classifyDocumentChange(
	newVersion: number,
	editState: EditState,
): "suppress" | "fullSync" | "externalEdit" {
	if (editState.versionBeforeEdit === undefined) {
		// Not applying our own edit — this is an external change.
		return "externalEdit";
	}

	// We're mid-applyEdit(). Check if this is our echo or something interleaved.
	if (newVersion === editState.versionBeforeEdit + 1) {
		// Version incremented by exactly 1 — our echo. Suppress.
		return "suppress";
	}

	// Version jumped by ≥2: an external edit interleaved during our applyEdit().
	return "fullSync";
}

/**
 * Handles incoming content changes from the webview.
 */
async function processContentChanged(
	args: ProcessContentChangedArgs,
): Promise<void> {
	const {
		changes,
		msgVersion,
		editState,
		currentDocumentVersion,
		applyEdit,
		postFullSync,
	} = args;

	// Stale check: has an external edit happened since the webview last synced?
	if (msgVersion < editState.lastExternalChangeVersion) {
		postFullSync();
		return;
	}

	// Record version before edit for echo detection (Issue 5 in plan).
	editState.versionBeforeEdit = currentDocumentVersion;
	try {
		await applyEdit(changes);
	} finally {
		editState.versionBeforeEdit = undefined;
	}
}

export type { EditState };
export { classifyDocumentChange, processContentChanged };
