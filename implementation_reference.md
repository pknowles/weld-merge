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
- **`repoContext.ts`**: Resolves per-file Git repository context via `vscode.git`. Custom-editor startup uses typed acquisition helpers that activate/wait for the Git API, open the requested repository, await the repository's first status-backed state event through a shared acquisition promise, and then return fully usable objects (`ReadyRepository`/`ConflictedItem`) or throw typed errors; editor startup code does not consume nullable Git API results directly.
- **`gitUtils.ts`**: Shared git helpers for subprocess-backed commands, validated repository-relative paths, URI-safe `.git` resolution, and conflict-state detection via `workspace.fs`.
- **`conflictSnapshot.ts`**: Shared text-conflict boundary. It reads base/local/remote stages and builds the canonical `Merger` snapshot and conflict indexes used by the merge editor.
- **`submoduleConflict.ts`**: Submodule conflict domain boundary. Uses VS Code Git API merge changes for discovery, then path-scoped raw Git for gitlink stage/object/index plumbing that the Git API cannot expose. It also contains read-only submodule history queries for the resolver graph/search/file list. This intentionally avoids `git ls-files`.
- **`log.ts`**: Shared `LogOutputChannel` initialization/access for extension-host diagnostics.
- **`treeView.ts`**: Implementation of the "Conflicted Files" view in the SCM panel, including resolved-file parsing from `MERGE_MSG` through `workspace.fs`.
- **`webview/meldWebviewPanel.ts`**: Manages the custom editor lifecycle, lifecycle of the Webview, and message passing.
- **`webview/submoduleConflictEditor.ts`**: Readonly custom editor for submodule conflicts. The editor URI stores only repository root URI and repo-relative submodule path; every open/reload recomputes live state from Git, so no serializer or saved conflict snapshot is needed.

## Webview UI (React Frontend)
Located in `src/webview/ui/`.
- **`App.tsx`**: Main UI container, state orchestration, and message bus handling.
- **`CodePane.tsx`**: Individual editor panels (Monaco integration). Pane
  headers render compact click-only commit detail popovers for Base/Local/Remote
  commit metadata and actions.
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
- Webview mocking in ./test/webview_* and ./test/webview/*
- For VS Code integration tests, use ./test/vscode/*
- For browser webview integration tests, use ./test/webview-integration/*
- For browser benchmarks, use Playwright with ./test/benchmarking/
- xvfb may be used if real windows MUST be displayed
- `test/vscode/launchTelemetrySuite/launch_telemetry.test.ts` runs in its own
  VS Code extension host with two conflicted repositories already in the
  workspace, enables the hidden `weld.launchTelemetry` setting, then reads
  activation-owned telemetry from `WeldExtensionApi` so launch work is counted
  from extension activation rather than from the later Mocha attach point. The
  counters are disabled in normal production activation and report refresh-repo
  trigger reasons rather than capturing stack traces.
- `scripts/test_restored_tabs.ts` provides the true restored-tab startup
  coverage. It runs normal development VS Code windows, not the
  `--extensionTestsPath` harness: a seed launch opens two real Weld custom
  text merge tabs and two real submodule resolver tabs in a fixed profile and
  closes cleanly, then an assertion launch reopens only the same
  workspace/profile and verifies VS Code restored all four tabs while Weld
  telemetry remains bounded. `npm run pre-checkin` includes this as `npm run
  test:vscode:restored-tabs`.
- `test/vscode/suite/launch_telemetry.test.ts` keeps the complementary
  active-host regression checks. It opens two real conflicted repositories,
  spies on the bundled extension objects exposed through `WeldExtensionApi`,
  and counts tree refreshes, Git state changes, meld state events, and
  submodule snapshot posts so restored-tab behavior cannot silently add
  repeated runtime work.

Test coverage with jest, mutations with stryker, fuzz testing with jazzer should be kept up to date.

- `scripts/collect_coverage.ts` is the `npm run coverage` entrypoint. It builds
  the extension and webview bundles with source maps, runs Jest coverage, runs
  VS Code integration tests and restored-tabs tests with raw V8 coverage,
  instruments the browser webview bundle with Istanbul, runs browser webview
  integration tests with Playwright, merges the LCOV files, and ratchets the
  checked-in coverage thresholds. The VS Code c8 conversion must include
  `out/extension.js`, not `src/**`: the VS Code extension host executes the
  bundled extension, and c8 uses `out/extension.js.map` to remap that execution
  back to files such as `src/webview/meldWebviewPanel.ts`. Browser webview
  coverage is different: Playwright reads `window.__coverage__` from the
  Istanbul-instrumented `out/webview/index.js`, then
  `istanbul-lib-source-maps` remaps that coverage back to `src/webview/ui/**`.
- Generated test/tool output should be written under the visible repo-root
  `test-output/` directory when the owning tool allows it. Jest coverage,
  Stryker temp/report files, Playwright artifacts, and benchmark metrics are
  configured there; VS Code download caches and fuzz corpora/crash artifacts
  remain tool-owned exceptions.
- `scripts/run_stryker_guarded.ts` is the `npm run test:mutate` entrypoint. It
  runs Stryker in the active checkout, refuses to start with unmerged index
  entries, and fails after mutation testing if tracked Git status changed.
- `test/runGit.ts` gates test Git commands to paths under `tmpdir()`. VS Code
  integration helpers and the Remote-SSH runner use this guard so conflict
  fixtures cannot accidentally run mutating Git commands in the project
  checkout.

## Benchmarking Telemetry

Granular performance telemetry is **opt-in only** and has zero production impact. It activates only when the Playwright test injects `window["__WELD_PERF_STATS__"]` before the benchmark run.

- **`src/matchers/diffutil.ts`** — `Differ.changeSequence()`: records total diff engine wall time per call to `diffTimes[]`.
- **`src/webview/ui/CodePane.tsx`** — `useCodePaneLogic`: the `isMiddle`-gated `onDidChangeModelContent` listener stamps `inputStartTimeRef.current` on each user edit. The decoration `useEffect` times `ed.deltaDecorations(...)` into `highlightJsTimes[]`, then schedules a single rAF to record end-to-end latency (from model change to after Monaco's next repaint opportunity) into `fullRenderTimes[]`.
- **`src/webview/ui/DiffCurtain.tsx`** — `useFilteredDiffs` `useMemo`: records visible-chunk computation time into `curtainRenderTimes[]`.
- **`test/benchmarking/config.ts`** — owns benchmark paths. The HTML fixture stays in `test/benchmarking/benchmark.html`; generated benchmark metrics and CPU profiles go to `test-output/benchmarking/results/`.
- **`test/benchmarking/ui_stress.test.ts`**: The "massive 50k document" test injects the stats gate, types 150 keystrokes with a double-rAF yield between each, then extracts avg/max for all four metrics. Also post-processes the `.cpuprofile` via exact function-name matching (`changeSequence`, `useFilteredDiffs`, `deltaDecorations`). **Verify these names against a real `.cpuprofile` run** — if they change (minification/rename), the profile metrics silently report `0`.

## Delete/Modify Conflict Restore

- `src/extension.ts`
  - `restoreConflictedFile()` first uses `git checkout -m` for both-modified conflicts.
  - `restoreDeleteModifyConflict()` restores delete/modify conflicts by checking out the surviving side's content, then recreating unmerged index stages with `git update-index --index-info`.
  - `repositoryRelativePath()` in `gitUtils.ts` converts an absolute VS Code file URI into the validated repository-relative path required by Git index plumbing.
  - Command handlers take a concrete `ConflictedItem`; command dispatchers use the `ConflictedItem` carried by tree rows when present, and only resolve from a URI for active-editor/webview entrypoints.

- `src/treeView.ts`
  - `GitFile.conflictedItem` keeps the VS Code Git API repository context attached to conflict-tree command arguments, so commands do not rediscover the repository from the URI.
  - `parseMergeMsgConflicts()` parses the conflict block from `.git/MERGE_MSG`
    for resolved-file recovery. It accepts Git's commented `#\tpath` entries
    and un-commented `\tpath` entries, ignores malformed indentation, stops at
    the first non-comment non-empty line after the conflict block begins, and
    deduplicates paths while preserving first-seen order.

- `src/gitUtils.ts`
  - `execGit()` runs Git commands and returns stdout.
  - `execGitWithInput()` runs Git commands that need stdin, currently used for `git update-index --index-info`.

- `src/repoContext.ts`
  - `readyRepositoryForRoot()` is the custom-editor startup boundary for
    repository state. It waits for the Git API to be initialized, opens the
    requested repository through the Git API, and constructs `ReadyRepository`
    only after the repository's first status-backed state event has populated
    `mergeChanges`. Open repositories are tracked as shared acquisition
    promises, so multiple editors wait on the same eventual object and VS Code
    close events reject pending acquisition attempts.
  - `conflictedItemForDocument()` performs the same initialized acquisition for
    real text documents, using `getRepositoryRoot()`/`openRepository()` at the
    Git API boundary and converting documented absence into typed errors instead
    of leaking `null` into editor code.
  - `createConflictedItem()` attaches repository context, the original VS Code Git API `mergeChanges` entry, and the `conflictStatus()` method to a conflicted URI.
  - `createConflictedItemFromUri()` is only for active-editor/URI fallback paths and resolved-file rows where we start from a bare URI rather than a current `mergeChanges` entry.
  - `ConflictedItem.conflictStatus()` computes both-modified, delete/modify, and unexpected both-deleted status from readable stage 2/3 content via `repository.show()`. This is slower than trusting `mergeChanges.status`, but more reliable in Cursor/remote hosts. `mergeChanges.status` is used only as advisory metadata for concise mismatch warnings.

- `test/vscode/suite/custom_editor_resolution.test.ts`
  - `MeldCustomEditorProvider.resolveCustomTextEditor - conflict status handling` verifies delete/modify handling, both-added editor initialization, and a real Git index both-deleted state created with `git update-index --index-info`.
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

- `test/webview_react.test.tsx`
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
