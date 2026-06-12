# Coverage Gap Test Backlog

Re-audited from `test-output/coverage/combined/lcov.info` after the full
coverage pipeline that merges Jest, VS Code integration, restored-tabs, and
browser webview integration coverage.

Current combined baseline:

- Lines: 7370 / 9810, 75.13%
- Functions: 835 / 1163, 71.80%
- Branches: 2162 / 3073, 70.35%

This backlog is intentionally not a line-chasing checklist. The goal is to add
tests that would fail for real product regressions and kill plausible mutants:
wrong command routing, swallowed Git errors, stale editor state, lost user
edits, incorrect conflict reconstruction, and misleading UI state.

Three source files are absent from LCOV because they are setup or type-only:
`src/jest.setup.ts`, `src/webview/submoduleUi/types.ts`, and
`src/webview/ui/meldPaneTypes.ts`. They should not drive test work unless they
gain runtime behavior.

## Priority Order

1. `src/treeView.ts`: lowest line/function coverage and high user visibility.
   A small mocked-provider suite covers many constructors, branches, errors,
   and submodule classification paths.
2. `src/extension.ts`: command routing and repository watcher behavior. These
   paths decide whether user actions mutate the right repository or fail
   clearly.
3. `src/matchers/gitTextMerger.ts` plus `src/matchers/merge.ts`: core merge
   correctness. Scenario matrices here are high value because exact output and
   unresolved-line assertions catch subtle algorithm regressions.
4. `src/matchers/diffutil.ts`: diff cache and incremental edit invariants.
   The existing tests mostly prove "no NaN"; recompute-equivalence tests would
   catch real merge-editor regressions and should move ahead of slower command
   integration work where practical.
5. `src/submoduleConflict.ts`: Git index plumbing. Tests should verify exact
   Git commands and inputs, because coverage without command assertions would
   miss dangerous mutations.
6. `src/webview/meldWebviewPanel.ts`: lifecycle and synchronization. Focus on
   lost-edits, stale-state, and error-posting paths rather than merely loading
   the editor.
7. `src/webview/ui/CodePane.tsx`: interaction details with Monaco mocks. Lower
   priority than extension/Git logic, but still valuable for clipboard, save,
   popover, and base-compare behavior.
8. `src/gitUtils.ts`: shared foundation with high line coverage but meaningful
   branch gaps. Do not chase it before the files above, but add focused branch
   tests when touching conflict-state or Git-error behavior.

## Priority 1: Tree View Behavior

Target: `src/treeView.ts`, currently 168 / 379 lines, 44.3%.

High bang-for-buck test shape: one unit suite with mocked Git API repositories,
mocked `workspace.fs.readFile`, and mockable submodule classifiers. Assert the
returned `TreeItem` labels, `contextValue`, `description`, `tooltip`,
`resourceUri`, `command.command`, and `command.arguments`; do not settle for
row counts.

Existing coverage note: `test/vscode/suite/tree_view.test.ts` already covers
basic conflict detection after open, detection in a repo initialized during the
session, pre-existing conflict detection, submodule/text conflict coexistence,
and conflict disappearance after commit, abort, or `.git` deletion. Do not
rebuild those scenarios unless adding stronger assertions to the existing host
tests. `test/treeViewMergeMsg.test.ts` already covers the pure
`parseMergeMsgConflicts()` parser, and `test/treeViewTelemetry.test.ts` covers
basic refresh/materialization telemetry. The gaps below are the missing
behavioral assertions and provider branches that still explain the 44.3% line
coverage.

1. Mixed repository root listing with per-repository failure isolation:
   - Fixture: one supported repo with text merge changes, one supported repo
     that throws while reading conflict state, and one unsupported-scheme repo.
   - Assert: supported rows remain, unsupported repo is ignored, failing repo
     contributes exactly one `ErrorTreeItem`, and the error tooltip preserves
     the cause chain.
   - Failure caught: one bad repo blanking the whole tree, remote schemes being
     shown incorrectly, or errors losing actionable details.

2. Strengthen existing conflicted text versus conflicted submodule assertions:
   - Fixture: extend the existing host tests or add a targeted unit fixture
     with a normal file and active submodule gitlink conflict.
   - Assert: in addition to existing `contextValue` and `command.command`
     checks, assert label, description, tooltip, `resourceUri`, repo path,
     URI, and full command arguments.
   - Failure caught: a row looking correct by context value while carrying the
     wrong URI, repository, or user-facing metadata.

3. Resolved rows reconstructed from `MERGE_MSG` through the provider:
   - Fixture: active conflict state, `MERGE_MSG` with comments, duplicate
     paths, blank lines, and one path still present in `mergeChanges`.
     Prefer a focused provider test using a mocked `workspace.fs.readFile`
     returning the `MERGE_MSG` content plus a mocked repository
     `state.mergeChanges`; the parser itself is already covered.
   - Assert: only resolved paths appear, active unmerged paths are filtered
     out, duplicate or malformed lines do not create duplicate tree rows, and
     resolved submodule paths use the submodule command.
   - Failure caught: users losing the ability to stage resolved conflicts or
     seeing stale unmerged rows.

4. Git API mismatch warning:
   - Fixture: active merge/cherry-pick/rebase state, no merge changes, and no
     resolved paths.
   - Assert: `WarningTreeItem` label includes the operation, description is
     `Git API mismatch`, and tooltip tells the user to refresh Git.
   - Failure caught: empty trees during active conflicts with no diagnostic.

5. Event contract:
   - Fixture: subscribe to `onDidRefresh`, `onDidChangeTreeData`, and
     `onDidGetChildren`.
   - Assert: extend `test/treeViewTelemetry.test.ts` so `refresh()` fires
     exactly one refresh event and one undefined tree change; `getChildren()`
     and `getChildren(element)` both record materialization, with child lookups
     returning `[]`.
   - Failure caught: telemetry/refresh UI drifting away from provider calls.

## Priority 2: Extension Commands And Repository Watchers

Target: `src/extension.ts`, currently 765 / 1332 lines, 57.4%.

High bang-for-buck test shape: VS Code integration tests for user-facing
commands plus small extracted-unit tests where the helper is independent of the
extension host. The slow host tests should assert full user-visible behavior;
unit tests are appropriate only after extracting pure seams such as
`repositoryRefreshKey`, `refreshKeyIsEmpty`, active-editor target resolution, or
a repository-watcher state machine. The critical assertions are command IDs,
arguments, refresh calls, notification messages, and preserved causes.

1. Command dispatch matrix:
   - Exercise `openMergeEditor`, `openMeldDiff`, `autoMerge`,
     `checkoutConflicted`, `rerereForget`, and `smartAdd` from all supported
     entry points: tree item, URI command argument, active editor, and no active
     editor.
   - Assert: normal text conflicts route to `git.openMergeEditor` or
     `vscode.openWith`; submodule tree items route to
     `SubmoduleConflictEditorProvider.open`; unsupported schemes and
     outside-repository files show/log command-specific errors.
   - Failure caught: a command working from the tree but failing from editor
     context, or submodules entering the text merge editor.

2. Auto-merge-all batch semantics:
   - Fixture: zero conflicted files, all-success, and partial failure on the
     second file.
   - Assert: zero case shows the no-op message and does not refresh; success
     logs every merged URI and refreshes once; partial failure includes the
     failing URI, successful count, and original cause, then refreshes only if
     at least one file was changed.
   - Failure caught: batch commands swallowing failures or refreshing after no
     mutation.

3. Restore/checkout/rerere safety:
   - Fixture: confirmation cancelled and confirmed, `checkout -m` success,
     delete/modify fallback, and unexpected Git failure.
   - Assert: cancel makes no Git calls; confirm fires the right refresh events;
     delete/modify restore writes exact index-info lines; unexpected failures
     surface the original Git message.
   - Failure caught: destructive actions running without confirmation or
     delete/modify conflicts being restored incorrectly.

4. Smart add guardrails:
   - Fixture: unresolved conflict markers, unresolved `(??)` auto-merge markers,
     clean text, and `repository.add` throwing.
   - Assert: unresolved text never calls Git; clean text calls `add` with the
     file path and refreshes; Git failure uses `showExceptionMessage` and
     returns `false`.
   - Failure caught: staging unresolved content or hiding Git add failures.

5. Repository watcher lifecycle:
   - Fixture: supported repo opened twice, unsupported repo opened, supported
     repo closed, and repeated `onDidChange` events with identical state.
   - Assert: watcher is registered once per supported root, duplicate opens are
     ignored, close disposes and clears cached refresh keys, duplicate refresh
     state is deduped, first empty startup state does not broadcast a fake
     change, and real state changes fire webview refresh notifications.
   - Failure caught: duplicate Git watchers, stale repository state, and noisy
     webview reloads.
   - Practicality note: this likely needs either a real VS Code host test or a
     small extraction from `setupGitRepoWatchers()`/`watchRepo()` before it can
     be unit-tested meaningfully. Do not write a brittle test that mocks half of
     `vscode` inline.

## Priority 3: Merge Engine Scenario Matrix

Targets: `src/matchers/gitTextMerger.ts`, currently 84 / 145 lines, 57.9%;
`src/matchers/merge.ts`, currently 381 / 563 lines, 67.7%.

High bang-for-buck test shape: table-driven unit tests using real
`GitTextMerger` and `Merger` inputs. Assert exact merged output and exact
`differ.unresolved` line indices. Mutation resistance comes from asserting the
shape of conflict blocks, not just "contains marker".

Existing coverage note: `test/test_merge.test.ts` already has Meld parity
goldens and trailing-newline cases. Read and extend those tests before adding a
parallel setup. The missing value is explicit invariants: marker order,
side-selection, unresolved-line indices, and documented `markConflicts=false`
behavior.

1. Initialization and valid-text failures:
   - Call `merge3FilesGit()` before `initialize()` and initialize with missing
     panes.
   - Assert the explicit "called before initialize()" error or documented
     current null-pane behavior.
   - Failure caught: invalid usage becoming silent empty output.

2. Non-conflicting one-sided changes:
   - Cases: local-only replace, remote-only replace, local insert, remote
     delete, clean prefix and suffix, with and without terminal newline.
   - Assert exact output, no conflict markers, and empty unresolved list.
   - Failure caught: local/remote side swapped or clean context dropped.

3. Both sides make the same logical change:
   - Cases: same replacement, same insertion, same deletion.
   - Assert the change appears once and no unresolved lines are recorded.
   - Failure caught: false-positive conflicts that waste user time.

4. True conflict marker contract:
   - Cases: one-line conflict, multi-line unequal-width conflict, overlapping
     insert conflict.
   - Assert exact marker order: `<<<<<<< HEAD`, local block, `||||||| BASE`,
     base block, `=======`, remote block, `>>>>>>> REMOTE`; assert the base
     block spans `min(startA)` through `max(endA)`.
   - Failure caught: malformed files that Git or users cannot interpret.

5. `markConflicts=false` behavior:
   - Cases: conflict with markers disabled in `GitTextMerger` and `Merger`.
   - Assert the current documented output and unresolved list.
   - Failure caught: downstream callers accidentally receiving conflict markers
     or silently losing conflict content.

6. Auto-merge fine-grained conflict splitting:
   - Cases: conflicting multi-line region where sub-lines have both equal and
     differing sections.
   - Assert equal sub-sections become replace chunks and differing sub-sections
     remain conflicts.
   - Failure caught: the fine-grained matcher being bypassed or inverted.

7. Unresolved-line maintenance after edits:
   - Cases: change sequence on the middle pane with positive, zero, and
     negative size changes, including deletion across unresolved ranges.
   - Assert unresolved indices are removed or shifted exactly.
   - Failure caught: "complete merge" thinking conflicts remain or are gone
     after user edits.

## Priority 4: Diff Cache And Incremental Edit Invariants

Target: `src/matchers/diffutil.ts`, currently 595 / 933 lines, 63.8%.

High bang-for-buck test shape: public API tests that compare incremental
updates with a fresh recompute. Where a helper is currently protected/private,
prefer a small test subclass over testing through random UI behavior. Existing
`test/test_differ.test.ts` only checks that large deletions do not produce
`NaN`; it does not prove the diff cache is correct after edits.

1. `ignoreBlanks` matrix:
   - Cases: replace becomes insert, replace becomes delete, both sides blank
     disappears, missing text arrays leave the chunk unchanged.
   - Assert resulting chunk tags and bounds.
   - Failure caught: whitespace-only changes appearing as conflicts or real
     changes disappearing.

2. Chunk lookup semantics:
   - Cases: pane 0, 1, and 2; exact hit; before first chunk; between chunks;
     after last chunk; invalid pane.
   - Assert `getChunk()` reverses left/right chunks correctly and
     `locateChunk()` returns `[found, previous, next]` consistently.
   - Failure caught: navigation jumping to the wrong diff or conflict.

3. Incremental `changeSequence()` equivalence:
   - Cases: insert, delete, replace on each pane; deletion spanning a chunk
     boundary; five-pane mode.
   - Assert merge cache, conflicts list, pane bounds, and `seqLength` match a
     full recompute from the edited texts.
   - Failure caught: stale diff cache after typing in the merge editor.

4. Merge-block invariants:
   - Cases: empty side groups, overlapping inserts at the same base position,
     non-insert overlaps, and same-tag delete conflicts.
   - Assert explicit invariant errors are reachable where expected and
     compatible inserts stay separate while real overlaps become conflicts.
   - Failure caught: internal cache corruption becoming wrong merge output.

5. Events and performance telemetry:
   - Cases: multiple listeners on one event, unknown event no-op,
     `window.__WELD_PERF_STATS__` present and absent.
   - Assert argument forwarding, one positive `diffTimes` sample for
     `changeSequence()`, and no throw when stats are absent.
   - Failure caught: telemetry or UI refresh hooks silently breaking.

## Priority 5: Submodule Conflict Git Plumbing

Target: `src/submoduleConflict.ts`, currently 536 / 843 lines, 63.6%.

High bang-for-buck test shape: mocked `execGit`/`execGitWithInput` unit tests
for command construction and parser behavior, plus one small integration fixture
if practical. Assert exact Git arguments, exact stdin for `update-index`, and
wrapped error causes.

1. `load()` availability and classification:
   - Cases: merge change missing, raw diff is text conflict, raw diff is
     malformed, old mode is `160000`, new mode is `160000`, raw Git command
     fails.
   - Assert unavailable errors return the right type/message and unexpected Git
     errors are not converted to `false`.
   - Failure caught: treating normal files as submodules or hiding Git failures.

2. Restore reconstruction matrix:
   - Cases: no active conflict state, both sides missing, base missing, local
     missing, remote missing, all stages present.
   - Assert no index mutation before validation; then assert `update-index
     --index-info` receives the stage-0 removal plus only present stage lines.
   - Failure caught: corrupting the index or inventing missing gitlink stages.

3. Path validation:
   - Cases: URI equals repo root, URI outside repo, path contains newline, path
     contains tab, nested valid submodule path.
   - Assert invalid paths throw before any Git command and valid paths are
     normalized to slash-separated repo-relative paths.
   - Failure caught: command injection-ish paths or mutations outside the repo.

4. Resolved-index removal fallback:
   - Cases: `git rm --cached` succeeds, `git rm --cached` fails and
     `update-index --force-remove` succeeds, both fail.
   - Assert fallback command order and that the double-failure message includes
     fallback failure while preserving the original remove error as cause.
   - Failure caught: resolved submodule restore failing on already-staged paths
     without a useful error.

5. Stage and commit lookup:
   - Cases: invalid SHA, missing commit, valid commit, short SHA search hit,
     short SHA search miss with grep results, non-revision lookup error.
   - Assert invalid SHA fails before Git calls; missing commit wraps `cat-file`;
     lookup miss returns grep results; non-revision error is rethrown with
     prefix context.
   - Failure caught: staging arbitrary input or losing useful search results.

6. Commit graph parsing:
   - Cases: malformed log record field count, empty subject/body, refs and
     parents parsing, malformed `diff-tree` line, root commit parent ref.
   - Assert parser output exactly and root commits use `EMPTY_TREE_SHA`.
   - Failure caught: graph UI crashing on ordinary history shapes.

## Priority 6: Meld Webview Panel Lifecycle

Target: `src/webview/meldWebviewPanel.ts`, currently 957 / 1267 lines, 75.5%.
Function and branch coverage are much lower than line coverage, so the missing
value is mostly decision-path testing.

High bang-for-buck test shape: VS Code integration tests around the real custom
editor plus focused unit tests for private-adjacent helpers only if the public
message flow is too costly. Assert posted webview messages, document content,
save/applyEdit ordering, and visible errors.

1. Open failure states:
   - Cases: unsupported URI, not in repository, Git API unavailable, repository
     unavailable, editor disposed.
   - Assert the exact fallback HTML or no-op behavior and no partial webview
     initialization.
   - Failure caught: blank editor panels or misleading "loading" hangs.

2. Conflict-status routing:
   - Cases: normal conflict, both-deleted, delete/modify with local remaining,
     delete/modify with remote remaining.
   - Assert normal path initializes the webview; both-deleted logs diagnostics
     and optionally shows output; delete/modify opens the prompt and routes
     Keep/Delete/Compare choices to exact Git or diff commands.
   - Failure caught: unsupported conflict states entering the normal merge UI.

3. Ready handshake and stale messages:
   - Cases: non-ready message before ready, duplicate ready, ready throwing
     during snapshot build.
   - Assert pre-ready messages are dropped, duplicate ready posts a formatted
     error, and the first `loadDiff` contains the current document text and
     config.
   - Failure caught: webview messages racing the initial snapshot.

4. Editor synchronization:
   - Cases: contentChanged queued before save, stale webview edit, external
     edit, echo suppression after `applyEdit`, interleaved external change.
   - Assert saves happen after edits, stale edits trigger `fullSync`, external
     edits post incremental `externalEdit`, and echo changes are not forwarded.
   - Failure caught: lost user edits or cursor-jumping echo loops.

5. Auto-merge and modification prompts:
   - Cases: dirty document, no conflict labels, exact initial Git state,
     modified conflict state with Replace, Open Existing, Compare, and cancel.
   - Assert dirty/no-label cases do not replace; exact state replaces content;
     Compare stores initial content, closes the editor, and opens the diff; cancel
     closes without replacing.
   - Failure caught: overwriting user edits or failing to auto-merge safe files.

6. Refresh and conflict-state notifications:
   - Cases: refresh for another URI, refresh for current URI, same state key,
     new state key, and lost conflict state.
   - Assert unrelated events are ignored, same-key events do not reload,
     new-key events reload and maybe auto-merge, and lost state posts
     `conflictStateLost`.
   - Failure caught: unrelated Git writes resetting open editors.

## Priority 7: Webview UI Interaction Tests

Target: `src/webview/ui/CodePane.tsx`, currently 174 / 230 lines, 75.7%.

High bang-for-buck test shape: Jest/React tests with a mocked Monaco editor
that records registered actions, decorations, models, and disposals. Browser
integration is useful only for interactions that depend on real layout.

1. Monaco actions and edit operations:
   - Cases: copy empty selection, copy whole line, cut readonly, cut writable,
     paste resolved from async clipboard request, save action.
   - Assert clipboard text, `executeEdits`, `trigger("paste")`, and save action
     calls.
   - Failure caught: keyboard shortcuts mutating readonly panes or saving before
     edits.

2. Commit popover behavior:
   - Cases: open, outside click, Escape, viewport resize/scroll reposition,
     copy hash, show diff.
   - Assert ARIA state, focus restoration, callback arguments, and no stale
     popover after close.
   - Failure caught: inaccessible or stuck commit popovers.

3. Header controls:
   - Cases: middle pane navigation buttons, base toggle on left/right, inactive
     base side, missing callbacks.
   - Assert exact action calls and absence of irrelevant controls.
   - Failure caught: navigation controls wired to the wrong direction/type.

4. External edit bridge:
   - Cases: `applyIncrementalEdits`, `applyFullSync`, unmount, file switch.
   - Assert model edits, full content replacement, decoration cleanup, and
     disposal.
   - Failure caught: stale Monaco models after refresh or hot-exit restore.

5. Readonly and empty states:
   - Cases: null file, readonly panes, editable middle pane, highlights empty,
     commit metadata absent.
   - Assert the UI disables editing only where expected and does not throw on
     missing optional data.
   - Failure caught: restored-tabs or base-compare views crashing on partial
     payloads.

## Priority 8: Shared Git Utilities Branches

Target: `src/gitUtils.ts`, currently 253 / 277 lines, 91.3%; branches 71 / 101,
70.3%.

This file is not a top coverage target by lines, but branch mistakes here affect
tree view, extension commands, submodule conflicts, and webview refresh logic.
Add these tests opportunistically when changing Git state handling.

1. Conflict-state operation matrix:
   - Cases: merge, cherry-pick, revert, rebase, multiple state files present,
     no state, malformed/missing refs, and worktree paths where `.git` is a
     file pointing elsewhere.
   - Assert exact operation and `otherRef`, and assert missing or malformed
     state produces the intended undefined/error behavior.
   - Failure caught: commands restoring against the wrong ref.

2. `execGit` error preservation:
   - Cases: stderr-only failure, stdout-only failure, process spawn failure,
     non-string errors.
   - Assert wrapped messages include the command context and preserve the cause
     text used by caller-facing errors.
   - Failure caught: user-facing messages that hide the real Git failure.

3. Conflict-status evidence:
   - Cases: both-deleted, delete/modify local, delete/modify remote, normal
     both-modified, and unexpected status output.
   - Assert status classification and diagnostic text include the evidence a
     user or developer would need to debug the state.
   - Failure caught: extension/webview routing the user into the wrong resolver.

## Validation Standard For New Tests

For each new suite, include at least one assertion that would fail if the main
effect were removed. Good examples:

- Exact Git command arguments and stdin for index mutations.
- Exact VS Code command ID and arguments for routing.
- Exact webview message command, version, and payload shape for sync.
- Exact merge output plus unresolved line indices.
- Exact user-facing error text including the underlying cause.

After implementing a group, run `npm run coverage` and inspect both the LCOV
delta and the test itself. A test that raises coverage but would pass if the
important command, write, or message were removed should be strengthened before
moving on.
