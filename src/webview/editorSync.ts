// Copyright (C) 2026 Pyarelal Knowles, GPL v2

/**
 * Editor Synchronization - Pure Logic Module
 * ==========================================
 *
 * This module contains the pure sync logic, decoupled from VS Code APIs for testability.
 * See meldWebviewPanel.ts for the high-level architecture overview.
 *
 * Key responsibilities:
 * - EditState: Per-editor state for tracking versions and serializing operations
 * - classifyDocumentChange: Determine if a document change is our echo or external
 * - processContentChanged: Handle incoming webview edits with staleness detection
 *
 * The complexity here stems from two fundamental challenges:
 *
 * 1. ECHO SUPPRESSION
 *    webview sends edit → we call applyEdit() → VS Code fires onDidChangeTextDocument
 *    We must NOT forward this event back to the webview (infinite loop). But we also
 *    must forward genuine external edits. Solution: capture document.version before
 *    applyEdit(), check if it incremented by exactly 1 after.
 *
 * 2. INTERLEAVED EXTERNAL EDITS
 *    During our async applyEdit(), another extension could also edit the document.
 *    If version jumped by ≥2, we know something interleaved. The webview's state is
 *    now unpredictably out of sync, so we trigger fullSync to recover safely.
 *
 * See docs/editor_sync_implementation_plan.md for the full design rationale.
 */

import type { MonacoContentChange } from "./ui/types.ts";

/**
 * Per-editor synchronization state. Each open editor has its own EditState instance.
 *
 * This cannot be shared across editors because each has its own:
 * - Document version timeline
 * - In-flight edit queue
 * - Echo suppression state
 */
interface EditState {
	/**
	 * Serialized promise queue for all document-mutating operations.
	 *
	 * Why a queue? Messages from the webview arrive via postMessage, which is FIFO.
	 * But _handleMessage is async and doesn't await — multiple messages can start
	 * processing concurrently. We chain onto this queue to ensure:
	 * - Edits apply in the order they were sent
	 * - Save waits for pending edits before writing to disk
	 * - versionBeforeEdit is never clobbered by concurrent operations
	 *
	 * Every contentChanged and save message chains onto this queue via .then().
	 */
	editQueue: Promise<void>;

	/**
	 * The document version at the time of the last external change (or at bootstrap).
	 *
	 * The webview stores this value and echoes it back with every message. When we
	 * receive a message, we compare msg.lastExternalChangeVersion against this field:
	 * - If msg's version < ours: the webview hasn't seen our latest external change,
	 *   so its edit ranges are based on stale content. Reject and fullSync.
	 * - If msg's version >= ours: the webview is up-to-date, apply the edit.
	 *
	 * This is ONLY updated for external changes, never for our own echoes. This allows
	 * multiple in-flight webview edits to all be valid (they share the same version)
	 * as long as no external edit has occurred.
	 */
	lastExternalChangeVersion: number;

	/**
	 * Echo suppression flag: the document version captured right before applyEdit().
	 *
	 * - undefined: No edit in progress. Any onDidChangeTextDocument event is external.
	 * - number: Edit in progress. If the new version === this + 1, it's our echo (suppress).
	 *           If version jumped by ≥2, an external edit interleaved (fullSync).
	 *
	 * Why not a simple boolean? We need to detect interleaved external edits. A boolean
	 * would tell us "we're editing" but not "did something else also edit?". By capturing
	 * the version before and checking for +1 increment, we catch interleaving.
	 *
	 * Why optional instead of -1 sentinel? Type safety. The compiler enforces we check
	 * for undefined before comparing, preventing bugs where we forget to handle the
	 * "not editing" case.
	 */
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
 * Classifies a document change event to determine the appropriate response.
 *
 * Called from onDidChangeTextDocument. The document has already changed — we're
 * deciding whether to forward it to the webview or suppress it.
 *
 * @returns
 * - "suppress": This is our own echo from applyEdit(). Do nothing.
 * - "externalEdit": Something else changed the document. Forward to webview.
 * - "fullSync": An external edit interleaved with our applyEdit(). Send full content.
 */
function classifyDocumentChange(
	newVersion: number,
	editState: EditState,
): "suppress" | "fullSync" | "externalEdit" {
	if (editState.versionBeforeEdit === undefined) {
		// No edit in progress — this change came from outside (another extension,
		// split editor, Find & Replace, etc.). Forward it to the webview.
		return "externalEdit";
	}

	// We're mid-applyEdit(). The onDidChangeTextDocument event fired during our
	// await workspace.applyEdit() call. Is this our echo or something else?

	if (newVersion === editState.versionBeforeEdit + 1) {
		// Version incremented by exactly 1. This is our echo — the change we just
		// applied. The webview already has this content (it sent it to us), so
		// forwarding would be redundant and could cause cursor jumps.
		return "suppress";
	}

	// Version jumped by ≥2. Our edit caused +1, but something else also edited
	// during the await. The webview's content is now stale. We can't send
	// incremental changes because we don't know what the webview has vs what
	// the document has. Send full content to resync.
	return "fullSync";
}

/**
 * Processes a contentChanged message from the webview.
 *
 * This runs inside the editQueue, ensuring messages are processed in order.
 * The args are captured when the message arrives, but currentDocumentVersion
 * is read when this actually executes (after any pending queue items complete).
 *
 * Flow:
 * 1. Check if the webview's lastExternalChangeVersion is stale (reject if so)
 * 2. Record versionBeforeEdit for echo suppression
 * 3. Apply the edit to the TextDocument
 * 4. Clear versionBeforeEdit (the onDidChangeTextDocument handler may have
 *    already fired during step 3 — that's fine, it used the value we set)
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
	// If so, the webview's edit ranges reference content we no longer have.
	// The only safe recovery is to send the full current document content.
	if (msgVersion < editState.lastExternalChangeVersion) {
		postFullSync();
		return;
	}

	// Record the version right before we edit. When onDidChangeTextDocument fires
	// (during the await below), classifyDocumentChange will check:
	// - If newVersion === versionBeforeEdit + 1: our echo, suppress
	// - If newVersion > versionBeforeEdit + 1: external interleaved, fullSync
	editState.versionBeforeEdit = currentDocumentVersion;
	try {
		await applyEdit(changes);
	} finally {
		// Clear regardless of success/failure. If applyEdit threw, we don't want
		// subsequent external changes to be incorrectly classified as echoes.
		editState.versionBeforeEdit = undefined;
	}
}

export type { EditState };
export { classifyDocumentChange, processContentChanged };
