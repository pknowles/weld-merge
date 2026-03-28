# Implementation Reference

## Core Algorithms (The "Meld" Port)
Found in `src/matchers/`. High-performance, side-effect-free TypeScript logic.
- **`myers.ts`**: `O(NP)` diffing algorithm with Meld-style k-mer matching.
- **`diffutil.ts`**: Advanced sequence management, chunk tracking, and alignment logic.
- **`merge.ts`**: 3-way merge logic and `AutoMergeDiffer` heuristics.
- **`gitTextMerger.ts`**: Entry point for running the 3-way merge on raw text strings.

## Extension Host (VS Code Plumbing)
Entry point and Git integration.
- **`extension.ts`**: Extension lifecycle, command registrations, and workspace event handling.
- **`repoContext.ts`**: Resolves per-file Git repository context via `vscode.git` (`repository`, `rootUri`, `rootFsPath`, and repo-relative path).
- **`gitUtils.ts`**: Shared git helpers for subprocess-backed commands plus URI-safe `.git` resolution and conflict-state detection via `workspace.fs`.
- **`submoduleConflict.ts`**: Submodule conflict domain boundary. Uses VS Code Git API merge changes for discovery, then path-scoped raw Git for gitlink stage/object/index plumbing that the Git API cannot expose. It also contains read-only submodule history queries for the resolver graph/search/file list. This intentionally avoids `git ls-files`.
- **`log.ts`**: Shared `LogOutputChannel` initialization/access for extension-host diagnostics.
- **`treeView.ts`**: Implementation of the "Conflicted Files" view in the SCM panel, including resolved-file parsing from `MERGE_MSG` through `workspace.fs`.
- **`webview/meldWebviewPanel.ts`**: Manages the custom editor lifecycle, lifecycle of the Webview, and message passing.
- **`webview/submoduleConflictEditor.ts`**: Readonly custom editor for submodule conflicts. The editor URI stores only repository root URI and repo-relative submodule path; every open/reload recomputes live state from Git, so no serializer or saved conflict snapshot is needed.

## Webview UI (React Frontend)
Located in `src/webview/ui/`.
- **`App.tsx`**: Main UI container, state orchestration, and message bus handling.
- **`CodePane.tsx`**: Individual editor panels (Monaco integration).
- **`DiffCurtain.tsx`**: SVG-based connecting lines ("curtains") and action buttons between panels.
- **`meldPane.tsx`**: High-level layout for a 3-panel merge view.
- **`src/webview/submoduleUi/`**: Submodule conflict resolver UI. Receives one authoritative snapshot on `ready`, then lazy-loads commit search results and per-commit changed files. The graph preserves Git-provided commit order and renders it with local HTML rows plus a narrow SVG lane strip, keeping ordering/topology data from Git while limiting UI code to lane coordinates and interaction.

## Frontend Logic & Synchronization
- **`appHooks.ts`**: React hooks for overall application state and message handling.
- **`useSynchronizedScrolling.ts`**: Logic for proportional scrolling across differently sized diff chunks.
- **`scrollMapping.ts`**: Calculations for mapping line indices between Local/Base/Remote/Merged.
- **`highlightUtil.ts`**: Logic for generating Monaco-compatible line decorations from diff chunks.
- **`editorActions.ts`**: Functions for modifying text content in response to UI actions (arrows/crosses).

## Testing

- Unit test what we can in ./test/test_*
- Webview mocking in ./test/webview_*
- For e2e vscode interaction, use ./test/vscode/*
- For e2e browser interaction and benchmarks, use playwrite, e.g. in ./test/benchmarking/
- xvfb may be used if real windows MUST be displayed

Test coverage with jest, mutations with stryker, fuzz testing with jazzer should be kept up to date.

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

## Submodule Conflict Resolution

- Intent:
  - Submodule conflicts are gitlink conflicts, not text-file conflicts. They
    should be launched from the conflict tree because command-palette launch has
    no unambiguous submodule target.
  - The submodule resolver is a readonly custom editor keyed by a synthetic URI
    containing only stable identity (`repositoryRoot`, `submodulePath`). VS Code
    can restore that URI after reload, and Weld rebuilds the current snapshot
    from Git instead of saving conflict data.
  - VS Code's Git API remains the source for repository lifecycle and conflict
    path discovery. Raw Git is isolated to `submoduleConflict.ts`. Mutating raw
    Git is limited to gitlink stage/index operations because
    `repository.show(":2", path)` cannot read submodule gitlink stages and the
    Git API cannot write unmerged gitlink index entries. The resolver also uses
    read-only Git commands inside the submodule repo for graph/search/file-list
    data because the Git API does not expose those queries for an arbitrary
    nested repository.

- `src/submoduleConflict.ts`
  - `SubmoduleConflict.load()` is the single validation boundary for live
    submodule conflicts. It starts from a VS Code Git API repository and URI,
    checks the path-scoped raw diff for gitlink mode `160000`, and reads staged
    base/local/remote SHAs with `git rev-parse :1:path`, `:2:path`, `:3:path`.
    It throws `SubmoduleConflictUnavailableError` only for expected domain
    states where the conflict is gone or the path is not a submodule conflict;
    operational failures keep their original error path and are shown as errors.
  - `SubmoduleConflict.stage()` stages the selected submodule commit with
    `git update-index --cacheinfo 160000` after verifying the selected SHA is a
    real commit in the submodule repository.
  - `SubmoduleConflict.restore()` reconstructs stage 1/2/3 gitlink index
    entries for resolved submodule conflicts using `update-index --index-info`.
  - Resolved submodule classification is based on the active conflict refs
    (`HEAD`, other ref, and their merge base), not the current diff from `HEAD`,
    because staging the local gitlink can leave a resolved conflict with no
    diff while the merge operation is still active.
  - Active conflicted submodule rows use a lightweight gitlink-mode probe for
    tree classification. Full `SubmoduleConflict.load()` is reserved for
    resolver actions that need the staged base/local/remote SHAs.
  - The initial commit graph asks Git for one `log --topo-order --reverse`
    stream over base/local/remote, bounded by the parent(s) of a small ancestor
    window ending at the staged base SHA. This preserves the old resolver's
    "earlier history" context without using ancestor arithmetic like `base~20`,
    while keeping side-branch ordering exactly in Git's hands instead of merging
    separate ranges in TypeScript.

- `src/treeView.ts`
  - `conflictedSubmodule` and `resolvedSubmodule` items reuse the existing
    `meld-auto-merge.openMeldDiff` command. The command dispatches submodule
    rows to the submodule resolver and text rows to the normal merge editor.

- `src/webview/submoduleConflictEditor.ts`
  - Implements `CustomReadonlyEditorProvider<SubmoduleConflictDocument>` for
    `weld.submoduleConflict`.
  - Custom editor URIs use the `*.weld-submodule-conflict` synthetic suffix so
    VS Code can restore tabs by URI identity without advertising this editor as
    an "Open With" option for every file.
  - On `ready`, posts a fresh `snapshot`; on repo state changes, rebuilds that
    same snapshot or posts `conflictLost` if the merge was aborted/resolved.
    Snapshot refreshes are versioned per webview panel so older live-state reads
    cannot overwrite newer ones after rapid Git state-change events.
    Only `SubmoduleConflictUnavailableError` becomes `conflictLost`; missing
    submodule checkouts, failed Git commands, malformed history output, and
    unavailable repositories are reported through the webview error surface.
  - `showFileDiff` reads the selected commit directly and diffs root commits
    against Git's empty tree.

- `src/webview/submoduleUi/`
  - Commit file lists use `null` for "not loaded yet" and `[]` for "loaded and
    empty", so empty commits do not look like permanently loading commits.
  - The commit graph preserves the Git-provided commit order instead of sorting
    in React. Git owns commit order, parent topology, ref names, and author
    metadata; the renderer owns only lane coordinates, SVG paths, row layout,
    and selection/hover visuals. This intentionally replaced `@gitgraph/react`
    because its generated SVG layout hid text, produced hard-to-control
    spacing/orientation, and made full-row interaction unreliable.
  - `GitGraph.tsx` processes the `git log --topo-order --reverse` snapshot
    newest-to-oldest only to assign x positions for SVG lanes, then renders
    newest commits at the top and older commits lower in the scroll view. It
    renders Git's `%D` decorations as inline badges, alongside Weld's
    Base/Local/Remote markers.
  - Truncated history is surfaced explicitly instead of hidden: commits whose
    parents fall outside the visible window contribute dashed "Earlier
    history" stubs, and merge commits with off-screen secondary parents render
    a short dashed side branch so long histories do not make merges look
    linear.
  - The resolver layout follows the original left-pane flow: `Resolve:
    <submodule path>`, commit chooser/search, Stage action, graph, draggable
    divider, and selected commit details on the right.

- Tests:
  - `test/submoduleConflict.test.ts` covers URI identity, live gitlink stage
    loading, staging a selected commit, rejecting nonexistent selected SHAs,
    root-base snapshot building, pre-base graph context, root-commit changed
    files, Git topo-order preservation, resolved submodule classification,
    active text-conflict rejection, and restoring unmerged gitlink stages.
  - `test/vscode/suite/tree_view.test.ts` covers tree detection and launch
    command shape for real submodule conflicts in the VS Code host.
