# Implementation References

## Delete/Modify Conflict Restore

- `src/extension.ts`
  - `restoreConflictedFile()` first uses `git checkout -m` for normal conflicts.
  - `restoreDeleteModifyConflict()` restores delete/modify conflicts by checking out the surviving side's content, then recreating unmerged index stages with `git update-index --index-info`.
  - `getRepoRelativePath()` converts an absolute VS Code file URI path into the repository-relative path required by Git index plumbing.

- `src/gitUtils.ts`
  - `execGit()` runs Git commands and returns stdout.
  - `execGitWithInput()` runs Git commands that need stdin, currently used for `git update-index --index-info`.

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
