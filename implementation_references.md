# Implementation References

## Delete/Modify Conflict Restore

- `src/extension.ts`
  - `restoreConflictedFile()` first uses `git checkout -m` for normal conflicts.
  - `restoreDeleteModifyConflict()` restores delete/modify conflicts by checking out the surviving side's content, then recreating unmerged index stages with `git update-index --index-info`.
  - `getRepoRelativePath()` converts an absolute VS Code file URI path into the repository-relative path required by Git index plumbing.
  - Command handlers take a concrete `ConflictedItem`; command dispatchers use the `ConflictedItem` carried by tree rows when present, and only resolve from a URI for active-editor/webview entrypoints.

- `src/treeView.ts`
  - `GitFile.conflictedItem` keeps the VS Code Git API repository context attached to conflict-tree command arguments, so commands do not rediscover the repository from the URI.

- `src/gitUtils.ts`
  - `execGit()` runs Git commands and returns stdout.
  - `execGitWithInput()` runs Git commands that need stdin, currently used for `git update-index --index-info`.
  - `findMergeChange()` locates a file in VS Code Git API `mergeChanges` by canonical URI string rather than `fsPath`, preserving remote URI identity.
  - `getConflictRouting()` routes normal, delete/modify, and unexpected both-deleted conflicts from VS Code Git API `mergeChanges.status` using named `GitStatus` constants. `repository.show()` is only used where callers need stage content, not as a conflict-shape probe.

- `test/vscode/suite/custom_editor_resolution.test.ts`
  - `MeldCustomEditorProvider.resolveCustomTextEditor - conflict type routing` verifies delete/modify routing, both-added editor initialization, and the stubbed both-deleted safety path.
  - `handleOpenMeldDiff - conflict type routing` verifies the registered command opens the custom editor for normal conflicts and routes delete/modify conflicts to the prompt without opening `vscode.openWith`.
  - `MeldCustomEditorProvider.handleDeleteModifyConflict - Compare` verifies the delete/modify prompt opens `vscode.diff` once, does not re-prompt, and leaves the conflict unresolved.
  - `restoreConflictedFile - stage detection` verifies native delete/modify conflicts stay unresolved after restore.
  - `restoreConflictedFile - after dialog resolution` verifies restore recreates the unmerged index after a user has already staged Keep/Delete through the dialog.
  - `assertDeleteModifyConflictRestored()` checks the working-tree content, `git ls-files -u` stages, and `git status --short` conflict code (`DU`/`UD`).

## Webview Ready Error Surface

- `src/webview/meldWebviewPanel.ts`
  - `_formatWebviewException()` turns exceptions thrown while handling webview messages into structured error payloads. The ready callback title is intentionally explicit: `Error: exception during ready callback`.

- `src/webview/ui/App.tsx`
  - `LoadingError` renders structured error payloads as an alert while the merge editor is still waiting for initial diff data.

- `test/webview_e2e.test.tsx`
  - `renders ready callback exceptions as an obvious error alert` verifies the webview displays the structured error title and message.
