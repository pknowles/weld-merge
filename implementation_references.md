# Implementation References

## Delete/Modify Conflict Restore

- `src/extension.ts`
  - `restoreConflictedFile()` first uses `git checkout -m` for both-modified conflicts.
  - `restoreDeleteModifyConflict()` restores delete/modify conflicts by checking out the surviving side's content, then recreating unmerged index stages with `git update-index --index-info`.
  - `getRepoRelativePath()` converts an absolute VS Code file URI path into the repository-relative path required by Git index plumbing.
  - Command handlers take a concrete `ConflictedItem`; command dispatchers use the `ConflictedItem` carried by tree rows when present, and only resolve from a URI for active-editor/webview entrypoints.

- `src/treeView.ts`
  - `GitFile.conflictedItem` keeps the VS Code Git API repository context attached to conflict-tree command arguments, so commands do not rediscover the repository from the URI.

- `src/gitUtils.ts`
  - `execGit()` runs Git commands and returns stdout.
  - `execGitWithInput()` runs Git commands that need stdin, currently used for `git update-index --index-info`.

- `src/repoContext.ts`
  - `createConflictedItem()` attaches repository context, the original VS Code Git API `mergeChanges` entry, and the `conflictStatus()` method to a conflicted URI.
  - `createConflictedItemFromUri()` is only for active-editor/URI fallback paths and resolved-file rows where we start from a bare URI rather than a current `mergeChanges` entry.
  - `ConflictedItem.conflictStatus()` computes both-modified, delete/modify, and unexpected both-deleted status from readable stage 2/3 content via `repository.show()`. This is slower than trusting `mergeChanges.status`, but more reliable in Cursor/remote hosts. `mergeChanges.status` is used only as advisory metadata for concise mismatch warnings.

- `test/vscode/suite/custom_editor_resolution.test.ts`
  - `MeldCustomEditorProvider.resolveCustomTextEditor - conflict status handling` verifies delete/modify handling, both-added editor initialization, and the stubbed both-deleted safety path.
  - `MeldCustomEditorProvider.resolveCustomTextEditor - status/stage mismatch` covers Cursor-style bogus `BOTH_DELETED` statuses where VS Code Git can still read all conflict stages.
  - `handleOpenMeldDiff - conflict status handling` verifies the registered command opens the custom editor for both-modified conflicts and handles delete/modify conflicts through the prompt without opening `vscode.openWith`.
  - `MeldCustomEditorProvider.handleDeleteModifyConflict - Compare` verifies the delete/modify prompt opens `vscode.diff` once, does not re-prompt, and leaves the conflict unresolved.
  - `restoreConflictedFile - stage detection` verifies native delete/modify conflicts stay unresolved after restore.
  - `restoreConflictedFile - after dialog resolution` verifies restore recreates the unmerged index after a user has already staged Keep/Delete through the dialog.
  - `assertDeleteModifyConflictRestored()` checks the working-tree content, `git ls-files -u` stages, and `git status --short` conflict code (`DU`/`UD`).

- `test/vscode-remote-ssh/`
  - `npm run test:vscode:remote-ssh` is a manual smoke test, intentionally excluded from `pre-checkin`.
  - `Dockerfile` builds a small local image from the official Debian slim base with `sshd`, `git`, and VS Code Remote-SSH prerequisites.
  - `runTest.ts` creates a real conflicted Git repo with normal Git conflict markers, mounts it into the SSH container, connects to the container IP directly on port 22 without publishing a host port, points VS Code's development extension path at the mounted source through a `vscode-remote://` URI, opens the repo through VS Code Remote-SSH, and runs the remote smoke suite with the hidden `weld.remoteSmokeTest` setting enabled only in the temporary profile.
  - `suite/remote_ssh_smoke.test.ts` verifies Weld activates in the remote extension host, sees the remote conflict, executes the real remote tree item command through the remote smoke-test bridge, opens the Weld custom editor, reads expected base/local/remote stage contents through the remote VS Code Git API, and observes the expected auto-merged document content.

- `package.json`
  - `extensionKind: ["workspace"]` keeps Weld in the workspace extension host, which is required for Remote-SSH because the Git repository and Git API live on the remote side.

- `src/webview/conflictLabels.ts` and `src/webview/diffPayload.ts`
  - `extractConflictLabels()` recognizes both normal and diff3 Git conflict markers.
  - `buildInitialConflictedState()` reruns `git merge-file -p` using the current repo Git config and labels extracted from the working file. Auto-merge only replaces the file when that output matches the working file byte-for-byte, proving the conflicted text is trivial to recreate with Git.

## Webview Ready Error Surface

- `src/webview/meldWebviewPanel.ts`
  - `_formatWebviewException()` turns exceptions thrown while handling webview messages into structured error payloads. The ready callback title is intentionally explicit: `Error: exception during ready callback`.

- `src/webview/ui/App.tsx`
  - `LoadingError` renders structured error payloads as an alert while the merge editor is still waiting for initial diff data.

- `test/webview_e2e.test.tsx`
  - `renders ready callback exceptions as an obvious error alert` verifies the webview displays the structured error title and message.
