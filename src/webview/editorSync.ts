// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import type { MonacoContentChange } from "./ui/types.ts";

export interface EditState {
	editQueue: Promise<void>;
	lastExternalChangeVersion: number;
	pendingVersionEcho: number;
}

/**
 * Determines what to do when an external document change is detected.
 */
export function classifyDocumentChange(
	newVersion: number,
	editState: EditState,
): "suppress" | "fullSync" | "externalEdit" {
	if (newVersion === editState.pendingVersionEcho) {
		editState.pendingVersionEcho = -1;
		return "suppress";
	}
	// If it jumped significantly while we weren't expecting an echo, sync.
	if (
		editState.pendingVersionEcho !== -1 &&
		newVersion > editState.pendingVersionEcho
	) {
		editState.pendingVersionEcho = -1;
		return "fullSync";
	}
	return "externalEdit";
}

/**
 * Handles incoming content changes from the webview.
 */
export async function processContentChanged(
	changes: MonacoContentChange[],
	msgVersion: number,
	editState: EditState,
	applyEdit: (changes: MonacoContentChange[]) => Promise<void>,
	postFullSync: () => void,
): Promise<void> {
	// Stale check: has an external edit happened since the webview last synced?
	if (msgVersion < editState.lastExternalChangeVersion) {
		postFullSync();
		return;
	}

	// Expect an echo at next version. This relies on the VS Code document-change
	// event firing before applyEdit resolves.
	editState.pendingVersionEcho = editState.lastExternalChangeVersion + 1;

	try {
		await applyEdit(changes);
	} catch (e) {
		editState.pendingVersionEcho = -1;
		throw e;
	}
}
