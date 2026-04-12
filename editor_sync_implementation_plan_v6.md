# Redesign: CustomTextEditorProvider Document Synchronization (v5)

## Problem Statement

The current sync between the webview (Monaco editor) and the VS Code `TextDocument` is broken:

1. **Feedback loops**: Webview edits echo back and re-apply.
2. **Stale saves**: Debounced sync (300ms) means Ctrl+S can save before edits reach the TextDocument.
3. **Untyped deltas**: `contentChangedDelta` uses `unknown[]` with unsafe casts.
4. **Shared state**: `_editQueue` is per-provider, not per-editor.

### Constraints

- 100k+ line files (no full-content replacement on every keystroke)
- Support VS Code undo/redo and split editors
- No `any`/`unknown` casts or lint suppressions
- **Never assume ordering based on timing**

---

## Core Design: Monaco as a Local Cache

The TextDocument is the **source of truth**. Monaco is a **local cache**.

- **Writes**: Edits apply to Monaco immediately (optimistic) and write back to the TextDocument.
- **Invalidation**: External edits update `lastExternalChangeVersion`. Stale webview messages (carrying an older `lastExternalChangeVersion`) are dropped, and a `fullSync` is sent.
- **Recovery**: On any inconsistency, `fullSync` replaces the entire Monaco content.
- **Ordering**: User-initiated save goes through the same postMessage queue as edits — guaranteed FIFO.
- **Code comments**: All sync-related code must include extensive inline comments explaining the flow, rationale, and which Design Issue each mechanism addresses. This is complex distributed state and the justifications must live in the code, not just this document.

---

## Design Issues & Rationale

### Issue 1: Can `expectedVersions` entries get stuck?

**Question**: Can predicted version entries be stuck forever in a tracking set?

**Conclusion**: Yes — edit failures, no-op edits, and non-+1 increments can all cause stale entries. Don't use a set of expected versions at runtime. Use `expectedVersions` as a **test-only** verification tool. At runtime, use a boolean flag + version-increment check.

---

### Issue 2: Webview → extension message version field

**Question**: What version does the webview tag its messages with?

**Conclusion**: `lastExternalChangeVersion` — the value the webview last received from the extension in a `loadDiff`, `externalEdit`, or `fullSync` message. The webview stores this and sends it back with every outgoing message (`contentChanged`, `save`). When the extension receives a message, it compares the webview's `lastExternalChangeVersion` against its own to detect stale messages.

---

### Issue 3: Is `document.version + 1` prediction atomic?

**Question**: Can something change `document.version` between reading it and calling `applyEdit()`?

**Conclusion**: With serialized edits (one `applyEdit` at a time) and no `await` between reading the version and calling `applyEdit`, the read is reliable. The +1 check is used for echo suppression, not prediction. Moot — we check AFTER the event fires, not before.

---

### Issue 4: Extension → webview message version field

**Question**: What version does the extension tag its messages with?

**Conclusion**: `lastExternalChangeVersion`. This is `document.version` recorded at the moment of an external change (or at bootstrap). Set in `loadDiff`, `externalEdit`, and `fullSync` messages. The webview stores this value and echoes it back in its own messages.

---

### Issue 5: Echo suppression mechanism

**Question**: How do we suppress echoes from our own `applyEdit()`?

**Thought process**: Monaco is synchronous — a boolean flag works. The workspace is async — a boolean alone could suppress legitimate external events during `await applyEdit()`. However, checking that `document.version` incremented by exactly +1 catches interleaving: if version jumps by ≥2, an external edit interleaved and we trigger `fullSync`.

**Conclusion**: Boolean flag `isApplyingEdit` + version-increment-by-1 check. Both must be true to suppress. Version ≥2 jump → `fullSync`.

---

### Issue 6: Save ordering

**Question**: type "a" → Ctrl+S → type "b". How do we ensure save happens between "a" and "b"?

**Thought process**: Save and edits go through different channels (Ctrl+S via VS Code main process, edits via webview postMessage). There is no cross-channel ordering guarantee. We must not assume ordering based on timing.

The solution is to put save in the **same postMessage channel** as edits. The webview intercepts Ctrl+S via a Monaco keybinding action (the codebase already intercepts Ctrl+C/X/V this way) and sends `{ command: "save", lastExternalChangeVersion }` through postMessage. The extension processes it in FIFO order with edits:

```
postMessage queue: [contentChanged("a"), save, contentChanged("b")]
Extension processes: apply "a" → save document → apply "b"
```

All messages carry `lastExternalChangeVersion`. If stale (message's value < extension's value), drop — whether it's an edit or a save.

For external saves (triggered by other extensions/commands, not via webview), `onWillSaveTextDocument` with `waitUntil(editQueue)` drains already-queued edits. Edits still in IPC transit are a known VS Code API limitation.

**Conclusion**: Route save through postMessage. `onWillSaveTextDocument` as fallback for external saves with a comment explaining the limitation.

---

### Issue 7: Bootstrap — initial load

**Question**: How do we ensure the initial content is perfectly synchronized?

**Thought process**: Having `loadDiff` send content while also setting up `onDidChangeTextDocument` creates two paths. We need airtight sync. If the user chose "keep" (no edit applied), we still need to send the current document contents. If the initial `applyEdit` fires `onDidChangeTextDocument`, we could double-send or miss an event.

**Conclusion**: Bootstrap has two phases, but the second phase is a single atomic block:

**Phase 1** (before webview is ready): Apply the initial edit (if needed) **without** any `onDidChangeTextDocument` listener. The echo is naturally ignored because the listener doesn't exist yet.

**Phase 2** (in the `"ready"` message handler, one synchronous block): All of the following happen atomically — no `await` between them, so no other code can interleave:
1. Set up the `onDidChangeTextDocument` listener
2. Set up the `onWillSaveTextDocument` fallback
3. Read `document.getText()` for the payload content
4. Record `lastExternalChangeVersion = document.version`
5. Send `loadDiff(content, metadata, lastExternalChangeVersion)` to the webview

Because these are all synchronous, the content sent to the webview is guaranteed to match exactly what the listener will track going forward — no missed events, no double-sends.

---

### Issue 8: External events during `applyEdit()`

**Question**: Is `applyEdit()` atomic? Can external events fire while `isApplyingEdit` is true?

**Conclusion**: `applyEdit()` is NOT atomic. External events CAN interleave. Detected by version incrementing by ≥2 during our edit. Triggers `fullSync`. See Issue 5.

---

### Issue 9: `expectedVersions` in tests

**Conclusion**: Test-only tool. Mock TextDocuments expose version history for asserting ordering in concurrent tests.

---

### Issue 10: `contentChanges` for edit matching

**Question**: Can we match events against our pending edits?

**Conclusion**: Not needed at runtime. The flag + version check is sufficient. Change data is available for debugging if issues arise.

---

### Issue 11: Multiple in-flight webview edits

**Question**: User types rapidly. E1, E2, E3 all sent with syncVersion V. Is E2 a false conflict?

**Thought process**: If we compare `msg.syncVersion` against `document.version`, E2 at syncVersion V would appear stale after E1 bumps the document to V+1. But E2 is valid — it was applied on top of E1 in Monaco.

**Conclusion**: Compare against `lastExternalChangeVersion`, not `document.version`. If no external edit has occurred, all webview edits are valid regardless of how many are in-flight. No acks needed — the webview's `lastExternalChangeVersion` stays at V until the extension sends a new one via `externalEdit` or `fullSync`.

---

### Issue 12: Webview handling of incoming changes

**Question**: Should the webview track pending edits to decide whether to apply incoming changes?

**Thought process**: The webview can't reliably know if it's "stale" — it doesn't know what's in the IPC pipeline. The protocol should work without the webview needing to distinguish. The webview just processes whatever it receives:
- `externalEdit(changes, lastExternalChangeVersion)`: apply changes to Monaco, update local `lastExternalChangeVersion`.
- `fullSync(content, lastExternalChangeVersion)`: replace Monaco content, update local `lastExternalChangeVersion`.

Both messages carry `lastExternalChangeVersion` from the extension. The webview trusts it.

If the webview has applied local optimistic edits and then receives an incremental `externalEdit`, the edit ranges reference the pre-edit document state, not Monaco's current state. This could briefly corrupt Monaco. The corruption self-corrects when the extension detects stale webview edits (via `lastExternalChangeVersion` comparison) and sends `fullSync`. External edits during active typing are rare.

**Conclusion**: Webview blindly trusts changes. No `hasPendingEdits`. `externalEdit` is always incremental (we cannot send the full 10MB file on every external keystroke for large files). `fullSync` is only sent on conflict recovery.

---

### Issue 13: User edit loss during `fullSync`

**Conclusion**: Edits that were rejected by the extension are lost from the TextDocument. They exist in Monaco's undo history but are overwritten by `fullSync`. Acceptable — external edit conflicts during active typing are rare, and `fullSync` is a safety net.

---

### Issue 14: No ack messages needed

**Question**: Does the webview need acknowledgment of its edits?

**Thought process**: The webview applies edits optimistically. It doesn't need to know if the extension accepted them. If the extension rejects (stale `lastExternalChangeVersion`), it sends `fullSync`. The webview's `lastExternalChangeVersion` only needs to be `>=` the extension's, and since the extension only updates it on external events, the webview's copy stays valid until the extension explicitly sends a new one.

**Conclusion**: No ack messages. Simpler protocol.

---

### Issue 15: Bootstrap sends full content only once

**Question**: Can we guarantee the full document is only sent once, with no double-sending?

**Thought process**: The initial `applyEdit` echo is never seen (listener set up after). The `loadDiff` sends the document content read atomically with listener setup. After that, only incremental changes or fullSync (on conflict) are sent.

**Conclusion**: Full content is sent exactly once in `loadDiff`. Subsequent syncs are incremental unless recovery triggers `fullSync`.

---

### Issue 16: Webview-side feedback loop prevention

**Question**: When the extension sends `externalEdit` changes to the webview, the webview applies them to Monaco via `model.applyEdits()`. Monaco's `onChange` fires synchronously during this call. Without suppression, `onChange` would send a `contentChanged` back to the extension — creating an infinite loop.

**Conclusion**: A trivial boolean `isApplyingSync` (a `useRef` in React) set around the `model.applyEdits()` call. `onChange` checks this flag and suppresses if `true`. This is safe because Monaco is fully synchronous — `onChange` fires during the `applyEdits` call, sees the flag, and returns immediately. No race condition is possible. The same guard applies for `fullSync` (which replaces the model value).

---

## Architecture

### Bootstrap (one-time)

**Phase 1** — before webview is ready (in `resolveCustomTextEditor` / `_initializeWebview`):

1. Compute auto-merge, diffs, metadata
2. Apply initial edit to TextDocument if needed (user may choose "keep existing")
3. No `onDidChangeTextDocument` listener exists yet — the echo from step 2 is naturally ignored

**Phase 2** — inside the `"ready"` message handler (one synchronous block, no `await`):

```typescript
// All of this is synchronous — no other code can interleave.
// This guarantees the content we send matches exactly what the listener tracks.
const changeListener = workspace.onDidChangeTextDocument(/* ... */);
const saveListener = workspace.onWillSaveTextDocument(/* ... */);
const content = document.getText();
const lastExternalChangeVersion = document.version;
webviewPanel.webview.postMessage({
    command: "loadDiff",
    data: { ...payload, files: [{ content }, ...] },
    lastExternalChangeVersion,
});
```

### Ongoing Sync

#### Webview → Extension (edits and save)

All messages go through **one postMessage channel** (FIFO guaranteed):

```typescript
{ command: "contentChanged", changes: MonacoContentChange[], lastExternalChangeVersion: number }
{ command: "save", lastExternalChangeVersion: number }
```

Extension processes each message from the **serialized edit queue** (`editQueue`). Only one message is processed at a time — this ensures `applyEdit()` calls never overlap:

```typescript
editQueue = editQueue.then(async () => {
    // 1. Stale check: has an external edit happened since the webview last synced?
    //    If so, the webview's ranges are based on outdated content. Drop and resync.
    //    (See Issue 11 — we compare against lastExternalChangeVersion, NOT document.version,
    //    because multiple in-flight webview edits all carry the same lastExternalChangeVersion
    //    and that's valid as long as no external edit has occurred.)
    if (msg.lastExternalChangeVersion < lastExternalChangeVersion) {
        postMessage({ command: "fullSync", content: document.getText(), lastExternalChangeVersion });
        return;
    }

    if (msg.command === "save") {
        await document.save();
        return;
    }

    // 2. Record version before edit for echo detection (Issue 5).
    const versionBeforeEdit = document.version;

    // 3. Set flag so onDidChangeTextDocument knows this change is ours (Issue 16).
    isApplyingEdit = true;
    try {
        const edit = convertMonacoChangesToWorkspaceEdit(document, msg.changes);
        await workspace.applyEdit(edit);
    } finally {
        isApplyingEdit = false;
    }

    // 4. By this point, onDidChangeTextDocument has already fired during the await.
    //    The handler checked isApplyingEdit (true) and version increment (Issue 5/8).
});
```

#### Extension → Webview (echo suppression + external change detection)

The `onDidChangeTextDocument` handler determines whether the change was our own echo or an external edit:

```typescript
workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== document.uri.toString()) return;

    if (isApplyingEdit) {
        // This event fired during our await applyEdit() — likely our echo.
        // Check that version incremented by exactly 1 (Issue 5).
        // If it jumped by ≥2, an external edit interleaved during the await (Issue 8).
        if (e.document.version === versionBeforeEdit + 1) {
            // Our echo only — suppress. Do not forward to webview.
            return;
        }
        // Version jumped by ≥2: external edit interleaved with ours.
        // The webview's cache is now stale — send full document.
        lastExternalChangeVersion = e.document.version;
        postMessage({ command: "fullSync", content: document.getText(), lastExternalChangeVersion });
        return;
    }

    // Not our edit — something external changed the document.
    // Send incremental changes to the webview (not fullSync — the file could be 10MB).
    lastExternalChangeVersion = e.document.version;
    postMessage({
        command: "externalEdit",
        changes: e.contentChanges,  // VS Code's TextDocumentContentChangeEvent[]
        lastExternalChangeVersion,
    });
});
```

#### Webview Reception

The webview processes whatever it receives, using `isApplyingSync` (a `useRef` boolean) to prevent Monaco's `onChange` from echoing received changes back to the extension (Issue 16):

- `externalEdit`: set `isApplyingSync = true`, apply changes to Monaco via `model.applyEdits()`, set `isApplyingSync = false`, update local `lastExternalChangeVersion`
- `fullSync`: set `isApplyingSync = true`, replace Monaco model content, set `isApplyingSync = false`, update local `lastExternalChangeVersion`

---

## Proposed Changes

### Extension Host

#### [MODIFY] [meldWebviewPanel.ts](file:///home/pknowles/programming/weld-bugfix/src/webview/meldWebviewPanel.ts)

**Remove**: `ContentChangedDeltaMessage` with `unknown[]`, `_editQueue` instance field, `lastKnownWebviewText`, `_applyContentDelta()`, `_applyContentEdit()`, `"contentChangedDelta"` case, `updateLastKnownText` parameter.

**Add**:
- `MonacoContentChange` interface (typed, no `unknown`)
- `ContentChangedMessage`: `{ command: "contentChanged"; changes: MonacoContentChange[]; lastExternalChangeVersion: number }`
- `SaveMessage`: `{ command: "save"; lastExternalChangeVersion: number }`
- Per-editor closure (inside `"ready"` handler): `editQueue`, `isApplyingEdit`, `versionBeforeEdit`, `lastExternalChangeVersion`
- `convertMonacoChangesToWorkspaceEdit()`: converts Monaco 1-based ranges to VS Code 0-based Range objects and builds a `WorkspaceEdit`
- `onDidChangeTextDocument` handler: checks `isApplyingEdit` flag AND `document.version === versionBeforeEdit + 1` to suppress our own echo. If version jumped by ≥2, sends `fullSync`. If flag is `false`, sends `externalEdit`. (See architecture pseudocode above.)
- `onWillSaveTextDocument` handler: `waitUntil(editQueue)` fallback for saves not routed through postMessage
- `"save"` message handler: calls `document.save()` in-order with edits in the serialized queue
- Bootstrap: initial edit in phase 1, listener + read + send all in `"ready"` handler (phase 2)
- **Extensive inline comments** on every sync-related code path explaining the flow, cross-referencing the Design Issues by number

### Webview

#### [MODIFY] [CodePane.tsx](file:///home/pknowles/programming/weld-bugfix/src/webview/ui/CodePane.tsx)

- Add Ctrl+S Monaco keybinding: sends `{ command: "save", lastExternalChangeVersion }` through postMessage
- `onChange`: when `!isApplyingSync.current` and pane is the merged pane, immediately send `{ command: "contentChanged", changes, lastExternalChangeVersion }`
- Handle `"externalEdit"`: set `isApplyingSync.current = true`, apply changes via `model.applyEdits()`, set `false`, update `lastExternalChangeVersion`
- Handle `"fullSync"`: set `isApplyingSync.current = true`, replace model value, set `false`, update `lastExternalChangeVersion`
- Remove `externalSyncId`/`lastSyncId`/`computeMinimalEdits` from sync path

#### [MODIFY] [App.tsx](file:///home/pknowles/programming/weld-bugfix/src/webview/ui/App.tsx)

- Remove `onEditSync` callback
- Track `lastExternalChangeVersion` in state (initialized from `loadDiff`, updated by `externalEdit`/`fullSync`)
- `onEdit` (debounced) only recalculates diffs

#### [MODIFY] [appHooks.ts](file:///home/pknowles/programming/weld-bugfix/src/webview/ui/appHooks.ts)

- Add `"externalEdit"` and `"fullSync"` message handlers — update `lastExternalChangeVersion` in state
- Remove `"updateContent"` handler
- Keep `"loadDiff"` — now also sets initial `lastExternalChangeVersion`

#### [MODIFY] [meldPaneTypes.ts](file:///home/pknowles/programming/weld-bugfix/src/webview/ui/meldPaneTypes.ts)

- Remove `onEditSync?` and `requestSave?`

### Message Protocol

#### Webview → Extension

- `ready` — webview mounted, triggers bootstrap (phase 2)
- `contentChanged` — incremental edit (`changes: MonacoContentChange[]`, `lastExternalChangeVersion: number`)
- `save` — save request (`lastExternalChangeVersion: number`), ordered with edits in the same FIFO queue
- `requestBaseDiff`, `copyHash`, `readClipboard`, `writeClipboard`, `showDiff`, `completeMerge` — unchanged

#### Extension → Webview

- `loadDiff` — bootstrap: metadata + content + `lastExternalChangeVersion` (one-time, sent in phase 2)
- `externalEdit` — incremental external change (`changes: TextDocumentContentChangeEvent[]`, `lastExternalChangeVersion: number`)
- `fullSync` — full cache invalidation + content (`content: string`, `lastExternalChangeVersion: number`)
- `updateConfig`, `loadBaseDiff` — unchanged

> [!NOTE]
> Removed: `updateContent` (full text echo), `contentChangedDelta` (untyped). No `ack` messages.

---

## Open Questions

> [!IMPORTANT]
> **Ctrl+S interception**: VS Code may consume Ctrl+S before the webview sees it. Need to test. If it doesn't work, `onWillSaveTextDocument` is the only option with a comment explaining the limitation.

> [!IMPORTANT]
> **`HACK_SYNC_DELAY`**: `setTimeout(() => setRenderTrigger(...), 100)` in `handleLoadDiff`. Investigate now or defer?



---

## Verification Plan

### Automated Tests

- **Echo suppression**: webview edit → echo suppressed (flag + version +1), external during await (version +2) → `fullSync` triggered
- **Stale edit detection**: external edit → webview sends stale syncVersion → rejected → `fullSync`
- **Multiple in-flight**: rapid edits with same syncVersion, no external edits → all applied
- **Save ordering**: `[edit("a"), save, edit("b")]` → processed in order
- **Bootstrap**: initial content matches document state after edit
- **Version tracking (test-only)**: `expectedVersions` assertions
- **Pre-checkin**: `npm run pre-checkin` passes

### Manual Verification

- Type rapidly → all edits visible
- Ctrl+S after typing → saved file contains all edits
- Ctrl+Z → undo works
- Split editor → changes sync
