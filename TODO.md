# Future Improvements & Known Issues

## New Ideas and Features

### Agent / LLM Integration

Expose weld-merge to VS Code Agent Mode / Copilot through VS Code Language
Model Tools (`contributes.languageModelTools`), gated behind `weld.agent.enable`
(default off) since some users won't want AI/agent interaction. Already
implemented for `weld_apply_automerge_all`, `weld_apply_automerge`,
`weld_list_conflicts`, and `weld_get_conflict`.

No MCP integration for now. Weld's useful agent operations depend on VS Code
extension-host APIs such as the Git API, `workspace.applyEdit`, and editor UI.
An MCP version would need either a separate headless implementation or a socket
bridge back into the extension host, which adds remote-development and
multi-instance complexity without helping the primary Copilot-in-VS-Code
workflow.

Design principle: Weld's tools are shortcuts for information/computation an
agent could otherwise only get by running Weld's own deterministic algorithms
(listing conflicts, reading conflict regions, running Weld's auto-merge). They
must not become a channel for the model to write arbitrary or model-chosen
content into files — that belongs to the editor's native file-editing tools,
which already work fine once an agent has the conflict info Weld provides. Do
not add a "resolve/apply this specific text" tool; if a tool would let the
model author the replacement content (a full text override, or even a
side-selection edit that a native edit could just as easily perform once
`weld_get_conflict` has supplied exact line ranges and content), that's out of
scope for weld-merge's LM tools.

Remaining Language Model Tools:
- `weld_open_3view` — open the 3-view diff editor for a file (read-only, no
  state changes); requires design work to support opening without an active
  conflict in git state (see annoyance note about re-opening the 3-view editor)
- `prepareInvocation` confirmation messages for mutating tools (currently only
  `weld_apply_automerge_all` and `weld_apply_automerge`) so agent mode shows a
  meaningful confirmation instead of the generic one

#### `weld_get_conflict` / `weld_list_conflicts` redesign (implemented)

This redesign replaced the old `matchesWeldMergedContent`/live-document shape.
The contract below records the implementation decisions and remaining test
work; do not regress them when extending the tools.

- **Read from disk, not the VS Code in-memory buffer.** A native file-edit
  tool (the agent's own `Edit`/`Write`) acts on disk; it has no access to
  VS Code's `TextDocument` buffer. The current code calls
  `workspace.openTextDocument(uri).getText()`, which returns the dirty
  in-memory buffer if the file is open unsaved — wrong source of truth. Read
  via `workspace.fs.readFile` instead (matches the pattern already used in
  `gitUtils.ts`/`treeView.ts`), so line ranges/content match what an edit
  tool would actually see and change. Drop `isDirty`/`version`/
  `matchesWeldMergedContent` entirely — there's only one source of truth now.
- **Terminology: git vocabulary, not UI vocabulary.** No "panes." Weld's own
  computed auto-merge result (`snapshot.mergedContent`) is an internal
  reference value used to detect clean vs. conflicting hunks — do not name or
  expose it as a top-level field (rejected names: `merged`, `panes`). The
  live file on disk is called `current`.
- **Don't duplicate content the agent can already read cheaply.** The agent
  has full, free access to the current file's text through normal file tools.
  `current` only needs to report *line ranges* (where each conflict/hunk
  sits on disk right now), not duplicate the file's text.
- **Git stage content (base/local/remote) is not cheap** for the agent to
  fetch itself — it requires raw `git show :N:path` calls, and the model may
  not know that convention. Provide it, but bounded: return full stage-region
  text only up to the `maxStageLines` size budget (default small). If a region
  or its requested context exceeds the budget, mark the stage response
  `truncated` and return a `rawGitAccess` block with the exact stage number
  and equivalent `git show` command for base/local/remote, so the model can
  fetch the omitted content itself only when it actually needs to.
  Small conflicts arrive complete in one call; large ones don't blow up the
  response.
- **Two tiers of conflict information, not one:**
  - **Initial conflicts** (base-anchored, from git stages — what's in
    `conflictChangeIndexes` today): base/local/remote regions for each real
    conflict, unchanged in spirit from today.
  - **Auto-merge suggestions — narrow, not "everything non-conflict," and
    NOT simply "both sides present."** Verified by direct experiment
    (see scratch probes run against `createConflictSnapshot` and real
    `git merge-file`): `snapshot.changes` entries where only one side
    changed (`change[0]` or `change[1]` is `null`) are **not** reliably
    "git already resolved this" — they cover two structurally
    indistinguishable cases:
    1. Git's own single-side merge result (already applied to disk outside
       any markers, never worth re-reporting), **and**
    2. The exact "Weld resolves what git couldn't" case this feature exists
       for — e.g. local deletes a line, remote inserts a new line at the
       same position. Confirmed with real `git merge-file`: this produces
       a genuine conflict (exit code 1, real `<<<<<<<` markers), yet Weld's
       differ represents it as two independent single-sided hunks
       (`[delete, null]` then `[null, insert]`) with non-`"conflict"` tags
       and cleanly resolves it. This has the *identical shape* in
       `snapshot.changes` to case 1 — there is no field on `DiffChunk`/
       `ThreeWayChange` that distinguishes them, so a
       "both-sides-present" filter (an earlier, wrong draft of this note)
       silently drops exactly the valuable case and keeps only the
       useless one.
    - **Correct signal: run real `git merge-file` once per file** (already
      done for the initial 3-view state, see `buildInitialConflictedState`
      in `diffPayload.ts`, including the documented exit-code-as-
      conflict-count convention from the git docs). Any line region that
      is inside `git merge-file`'s own `<<<<<<<`/`>>>>>>>` markers (i.e.
      git itself could not resolve it) but is *not* in Weld's
      `conflictChangeIndexes` is a genuine "Weld resolved what git
      couldn't" suggestion — surface only these, regardless of whether the
      underlying `snapshot.changes` pair is single- or both-sided. Do not
      surface anything still tagged `"conflict"` by Weld — those are
      exactly the `(??)` markers the user would see unresolved in the UI.
    - No per-hunk fuzzy-matching against a possibly-edited disk file is
      needed here (per Weld and Meld both only ever offering auto-merge
      from a clean base) — this comparison is entirely between git's stage
      1/2/3 content and Weld's own snapshot, independent of the live file.
  - **`unresolvedHunks`** (disk-anchored): re-run the same three-way diff
    (`createThreeWayChanges`) with the live disk content as the middle
    sequence instead of the base stage, filter to hunks still tagged
    `"conflict"`. This is what the UI's 3-way diff view shows as red/conflict
    even after the user declines the full auto-merge replacement and edits
    the file directly. **Do not call this "conflicts"** — git's own conflict
    state and Weld's `(??)` markers are different concepts, and many real
    resolutions still show hunks here without being wrong. Use
    **`unresolved`** — reads correctly even to a small model with no
    Weld-specific context, without implying marker syntax or git status.
  - This is a genuine simplification: the old per-conflict
    `getCurrentConflictRegion` null-check/overlap-filter dance goes away
    entirely. `unresolvedHunks` is a single whole-file pass, not something
    computed per `conflictIndex`.
- **Separately, detect literal leftover conflict-marker text** — checked-in
  markers, broken/half-deleted markers, or Weld's own `(??)` sentinel
  accidentally saved. This is a plain string scan for
  `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`/`(??)`, independent of the diff
  machinery above (diffing content doesn't see marker syntax as special).
  Report marker text and ranges found on disk so the model knows even if
  Weld's own diff thinks the file is otherwise resolved.
- **Commit metadata** (hash, title, author, date — no body by default, could
  be long) for local HEAD and remote/incoming is shown per-file in the UI and
  entirely absent from the tools today. Add to `weld_list_conflicts` (small,
  fixed-size, one repo-level fetch covers every conflicted file in that
  repo). Reuse `getCommitInfo`/`getRemoteRef`/`getBaseCommitInfo`, currently
  private to `diffPayload.ts` — extract into `conflictSnapshot.ts` alongside
  `getGitState`/`fetchConflictStages` (same precedent already established).
- **Testing gaps to close, consolidated into existing real-repo fixtures**
  (per the project's testing guidance — real git repos are expensive to set
  up, reuse fixtures already opened for other assertions in the same test
  rather than creating new ones):
  - `weld_apply_automerge`/`weld_apply_automerge_all` have **zero** coverage
    today against anything but plain text conflicts. Add cases for:
    - both-added conflicts (no base stage at all — `getGitFileContent`
      for stage 1 would fail; confirm this throws a clean, informative
      error rather than crashing oddly)
    - deleted-by-us / deleted-by-them (one side has no local or no remote
      stage; same concern)
    - both-deleted
    - submodule gitlink conflicts (structurally not mergeable text at all;
      confirm a clean typed rejection, not an attempt to merge SHAs as text)
  - These fixtures already exist in `test/vscode/suite/helpers.ts`
    (`makeBothAddedConflict`, `makeDeletedByUsConflict`,
    `makeDeletedByThemConflict`, `makeBothDeletedConflict`,
    `makeSubmoduleConflictFixture`) and are already used by
    `weld_list_conflicts`/`weld_get_conflict` tests — extend those same
    `describe` blocks with auto-merge assertions instead of opening new repos.
  - New disk-vs-buffer regression test: write directly to disk via
    `workspace.fs.writeFile` (not `workspace.applyEdit`, which only touches
    the in-memory buffer) inside an existing conflict-repo fixture, confirm
    `weld_get_conflict`'s `current` ranges reflect disk content, not any
    stale/absent in-memory buffer state.
  - **Deferred test-fixture consolidation:** one repo with one file containing every kind of
    hunk, plus every non-text conflict kind in the same repo** — see
    `/home/pknowles/programming/tmp-conflict` for a hand-built example
    already covering both-added/deleted-by-us/deleted-by-them/submodule
    conflicts plus a text file mixing multiple hunk shapes in one commit
    graph. It does **not** currently include a git-conflicts-but-Weld-
    resolves hunk (delete-a-line-vs-insert-adjacent-line, confirmed above to
    produce a real `git merge-file` conflict that Weld's differ resolves
    cleanly) — add one when building the new fixture, since that's the
    entire point of the auto-merge-suggestions feature and it's currently
    unrepresented anywhere. One repo, one file, every kind of conflict/hunk
    exercised together keeps the expensive part (spinning up a real git repo
    in the VS Code test host) to a single setup for the whole family of
    assertions below.
  - **Scenario coverage implemented in focused real-repo fixtures in
    `test/vscode/suite/agent-tools.test.ts`; verify small-model-legible
    output, not just "doesn't crash," for each:**
    - **Covered — user deletes the entire conflict region.** The disk-anchored
      `unresolvedHunks` re-diff should still find and range the gap (local
      and remote both "want" content the disk doesn't have). Marker-text
      scan finds nothing (markers are gone too) — the tool must not imply
      "resolved" just because no markers are present; `unresolvedHunks`
      is the mechanism that has to catch this, not the marker scan.
    - **Covered — user replaces the entire conflict region with unrelated text.** Same
      mechanism as above; disk content differs from both local and remote,
      hunk stays in `unresolvedHunks`.
    - **Covered — user replaces the region with a text block copied from just before
      or after it (deliberately adversarial to the diff alignment).** Real
      previously unverified risk: if the copied text matches base/local/remote
      content at a *different* offset, the underlying Myers-based three-way
      diff could align it to the wrong position, misreport the range, or
      make the diff look cleaner than it is. The integration assertion verifies
      the reported range remains at the replaced line under this adversarial
      input.
    - **Covered — user truncates the entire file.** `workspace.fs.readFile` still
      succeeds (short file, not a missing one) — the risk is downstream:
      `expandSideRange` in `conflictSnapshot.ts` already throws on
      out-of-bounds ranges, but that guards `base`/`local`/`remote` (stage
      content, unaffected by disk truncation). The disk-anchored
      `unresolvedHunks`/`current` pass is new code with no existing
      equivalent to check against — verify it degrades to a sensible
      "conflict region no longer exists in a truncated file" result rather
      than an uncaught range error surfaced as an opaque tool failure.
    - **Covered — user replaces the entire file with something completely
      different.** Same category of risk as truncation — confirm a clean
      "nothing recognizable here" result, not a crash or a false-positive
      partial match.
    - **Covered — different git conflict marker styles**
      (`merge.conflictStyle` = `merge`/`diff3`/`zdiff3`, and marker length
      via `%L`). Only relevant to the literal marker-text scan (the
      diff-based mechanisms never look at marker syntax at all) — the scan
      must not assume exactly 7 `<` characters or the presence/absence of
      the `|||||||` base line, since `zdiff3` and custom lengths change
      both.
    - **Covered — large chunks cap the response.** A real 40-line hunk fixture
      asserts that a small conflict arrives complete in one call and a large
      one truncates with correct per-stage `rawGitAccess` fallbacks.
    - For each of the above, the concrete question to answer per scenario:
      **would a small model still get data it can act on correctly, or would
      it be more confused than if it had just been asked to resolve the raw
      conflict markers by hand from the start?** A scenario that degrades to
      a clear, honest "can't map this" is fine; a scenario that returns a
      wrong-but-confident-looking range or diff is worse than not having the
      tool at all, and must be caught in testing before this ships.

### Take-all Buttons

Buttons to copy local or remote into merged would avoid having to copy/paste.

## Annoyances

Running "auto-merge all conflicted files" prevents the nice auto-merge feature
of meld where conflict markers are replaced with "(??)" in the 3-view editor
when the user finally opens it. Maybe when we check to see if the user has
modified the file since the conflict was created, which auto-merge does, we can
also check against the auto-merge result. If it matches, it is safe to do the
(??) replacement. Or is it safe to do (??) replacement if we find existing
conflicts? Probably not since they could be checked in from previous bad merges.

To re-open the 3-view merge editor, a conflict must exist. If the user already
resolved conflicts the only way to get this back is to checkout conflicted, but
this resets the file contents. We should have an option to restore the
conflicted state without actually changing the file so that the user can open
the 3-view window. Possibly even a way to open the 3-view window without
restoring the conflicted git state, but that might be confusing.

There's too many happy path popups. On linux, there is generally no output when
things work. Output is reserved for when things don't work. This is ideal. For
example, when checking out conflicted files we get a toast popup, but this
immediately covers exactly where the user wants to click to go to the next
conflicted file.

If the user is already looking at the conflicted files list we should not show a
toast popup when conflicted files are detected. Too much clutter.

When a dirty (modified) file is open in a regular vscode editor AND our 3-way
editor, then the user tries to close the default editor, there's a popup asking
to save changes. If the user clicks "no" to discard, the file state is reverted
to what's on disk. This is unexpected because the file is still open in the
3-way editor. I.e. I typically just want to clean up my tabs and not change the
contents of the file.

If there are no conflicts after auto-merge completes, I want to know. Maybe
display the number of conflicts remaining.

The Save & Complete Merge button takes up to much space. This could be a button
at the top of the UI, inline with the next/prev chunks and conflicts buttons.

VSCode tests produce an absurd amount of spurious errors on teardown. It's meant
to be fixed but clearly not.

Tabs left open from a previous session where the conflict is now resolved have
bad UX:
1. 3-way merge editors don't say ANYTHING about there not being a conflict anymore
2. submodule tabs say the file is no longer conflicted, which is likely a
   default thrown away from a far better message already present in the tree
   view

We should follow the tree view and distinguish between conflict-resolved vs
there wasn't a conflict (e.g. merge was aborted or continued)

## Low Priority Visual Polish

Opening the right-hand compare-with-base panel can produce a visible flicker in
the already-open editor area at the start of the slide-in animation. The current
Playwright diagnostic samples Local/Merged/Remote with 1k-line dummy files,
scattered changed ranges, and the viewport near 90% height; it does not detect a
scroll-position jump or blank Monaco content in those existing panes. This
suggests the visible flicker is likely layout/repaint caused by the right column
animation changing available width, not a scroll sync reset.

There is known asymmetry in compare-with-base behavior: the right base pane
detaches Monaco immediately on close (apparently "so the closing animation
cannot leak a Monaco scroll/layout event into Remote"), while the left base pane
keeps Monaco alive until its close animation finishes to (apparently this is to
"preserve the existing left-side fade behavior"). This is a smell.

## Behaviour Differences to GNOME Meld

The initial merge is correct, but after making changes the diffs/highlighting do
not get the same result. I have seen this in the real Meld app, but the aim here
was to match what Meld does exactly, so the current behaviour is incorrect.
This may have been solved by 74436a8d7e610543e945234617fc608148e58c13.

## Repository discovery

Race condition on launch: `ConflictedFilesProvider` and
`getTrackedRepositories()` check once for repositories and apparently there are
no listeners. There must be some though because we already detect the conflict
state changing.

Maybe use `onDidOpenRepository()` or some actual GIT API to detect repositories.
E.g. a user runs git init for the first time in the project folder? Maybe avoid
`repository.state` if it can just become stale?

`gitApi.getRepository(uri)` for workspace/project root isn't necessarily a git
repository. How does vscode handle subdirectories with git repositories?

What about worktrees? Should `ConflictedFilesProvider` have an optional top
level list of worktrees? Probably.

There is a change in progress for merging submodule commit hash conflicts, but
what about merge conflicts within submodules? Similar issue to worktrees.

`fetchConflictStages()` has no catch -> error path in `_initializeWebview()`.

## Perf improvements

Update SVG connection attributes rather than re-render the entire SVG. This involves keeping track of which we've displayed/culled, only updating the svg if those changed, and otherwise just updating the path coordinates.

## Content-addressed URIs for Compare view caching

The Compare feature stores initial conflict content in memory and serves it via a
`TextDocumentContentProvider` with URIs like `weld-initial-conflict:/path/to/file.txt`.

VS Code caches virtual documents for ~5 minutes after the editor closes (this is
intentional - `onDidCloseTextDocument` fires on document disposal, not editor close).

**Improvement:** Make URIs content-addressed by including the git blob SHAs:
```
weld-initial-conflict:/path/to/file.txt?base=<sha>&ours=<sha>&theirs=<sha>
```

Since `git merge-file -p` is deterministic (same inputs → same output), this enables:
- **Cache hits**: Same conflict state → same URI → VS Code serves cached doc → skip `git merge-file` entirely
- **Correct invalidation**: Different inputs → different URI → fresh computation
- **No stale content bugs**: Current implementation keys only on file path, which could serve stale content if the user does multiple merges on the same file within the ~5 min cache window

The ~5 minute disposal becomes beneficial LRU cache eviction rather than a "leak".

## Browser / web extension host support

Three operations still spawn the `git` executable (`merge-file -p`, `checkout -m`, `rerere forget`) — see README Known Limitations. If browser support is ever wanted, redesign these against VS Code git APIs before adding heuristics or partial fallbacks.

## Fix commit message titles

Match the commit mssage card contents in upstream vscode?

## Detect when the user forgot to resolve a conflict and preserve conflict markers

This is a feature meld doesn't have; probably because it's hard.

## Robust Tracking of "Resolved" Files During a Merge

Currently, the extension parses `.git/MERGE_MSG` to determine which files were originally conflicted but have now been resolved (so we can list them in the "Resolved" section of the TreeView and allow users to run `checkout -m` on them).

This is a good heuristic, but `MERGE_MSG` is not 100% reliable as it could potentially be missing, modified, or not cover cherry-picks or specific rebases properly.

A more robust solution for the future is to identify the overlapping files between our current HEAD and the other branch being merged/cherry-picked. The logic in bash looks like this:

```bash
# 1. Identify the 'other' side (Merge or Cherry-pick)
if [ -f .git/MERGE_HEAD ]; then
    OTHER_HEAD="MERGE_HEAD"
elif [ -f .git/CHERRY_PICK_HEAD ]; then
    OTHER_HEAD="CHERRY_PICK_HEAD"
elif [ -f .git/REVERT_HEAD ]; then
    OTHER_HEAD="REVERT_HEAD"
elif [ -d .git/rebase-merge ]; then
    # During a rebase, the commit being applied is usually here:
    OTHER_HEAD=$(cat .git/rebase-merge/stopped-sha)
elif [ -d .git/rebase-apply ]; then
    # During git am, the current patch's SHA is here:
    OTHER_HEAD=$(cat .git/rebase-apply/original-commit)
fi

# 2. Identify the common ancestor
BASE=$(git merge-base HEAD $OTHER_HEAD)

# 3. Find the overlap and reset to conflict state
comm -12 <(git diff --name-only $BASE..HEAD | sort) \
         <(git diff --name-only $BASE..$OTHER_HEAD | sort) \
| xargs git checkout -m
```

This logic can be implemented directly using the VS Code CLI/Node.js to get an exact list of files involved in the complex operation, ensuring accurate resolved tracking in all edge cases. Currently, if parsing fails, we gracefully degrade to just missing the resolved files, guaranteeing that actual conflicted files *always* show up via `git diff --name-only --diff-filter=U`.

## Gemini's Lazy Load Monaco Idea

To solve a possible delay reading a 10MB index.tsx all at once...

*   **Remove Sync Import**: Remove `import * as monaco` in `src/webview/ui/index.tsx`.
*   **Copy Local Files**: Add a build script to copy `node_modules/monaco-editor/min/vs` directly into `out/vs`.
*   **Webview URI Configuration**: Make `MeldWebviewPanel.ts` expose a Webview URI for `out/vs` to the frontend (`window.__MONACO_VS_URI__`).
*   **Configure Loader**: Set `loader.config({ paths: { vs: window.__MONACO_VS_URI__ } })` so Monaco lazy-loads instead of bundling entirely.
*   **Fix Workers**: Fix cross-origin worker issues by returning a Blob in `getWorkerUrl` that uses `importScripts('${window.__MONACO_VS_URI__}/base/worker/workerMain.js')` so bundler plugins are not required.

### Profiler Insights - First Launch

The trace confirms several bottlenecks that back up the lazy-load idea:
*   **Startup Latency**: `EvaluateScript` (~863ms) and `v8.compile` (~221ms) consume **>1s** during webview initialization for the **11MB** bundle. This effectively blocks the main thread during the critical first paint.
*   **Persistent Animations**: Long-running `Animation` slices (up to **3.8s**) account for nearly **70%** of the 5.5s trace session. This suggests that the side-panel transitions (`AnimatedColumn`) or SVG overlays (`DiffCurtain`) may be triggering redundant layout work or failing to terminate.
*   **Execution Hotspots**:
    *   `performWorkUntilDeadline` (React Scheduler) is the dominant function call, indicating React is struggling with a high volume of work or double-rendering (check `React.StrictMode` impact).
    *   `onmessage` and `l.onmessage` show overhead in the webview-to-extension message bus coordination.

### Profiler Insights - Resizing & Scrolling

The traces `Trace-20260307T154206_resizing.json` and `Trace-20260307T154834_scrolling.json` reveal significant localized bottlenecks:
*   **Synchronous Layout Thrashing**: During scrolling, `DiffCurtain.tsx` calls `getTopForLineNumber()` multiple times per diff chunk. In a file with many changes, this triggers hundreds of synchronous layout hits to Monaco's engine per frame, exceeding the 16ms budget.
*   **Async Task Loop**: 43,019 `v8::Debugger::AsyncTaskRun` slices indicate a scroll-synchronization feedback loop. The `scrollLock` release in `requestAnimationFrame` (in `useSynchronizedScrolling.ts`) creates a window where events are queued before the lock resets.
*   **React Render Storm**: `setRenderTrigger` is called on every scroll pixel, forcing a full reconciliation of the `Meld` app, all 5 editors, and all SVG curtains 60+ times per second.
*   **Highlight Calculation Sink**: `getHighlights(index)` is called during every `App` render. For every `replace` chunk, it performs string slicing, joining, and calls `diffChars()` (character-level diffing) on the main thread. This is a massive CPU sink that should be memoized or computed once per content change.
*   **Resize Overhead**: Resizing the window triggers ~1,800 layout passes. Monaco resizes every pixel, and `ResizeObserver` callbacks in the curtains trigger forced layouts by measuring `getBoundingClientRect()`.
*   **CSS Animation Bloat**: Scrollbar fade animations are running for ~780ms, likely because layout thrashing prevents them from settling or fading out smoothly.

## Open Blank 3-way merge

For people that want a 3-way merge with copy/pasted content. We'd need to make
all panels editable and maybe default one of the base windows to be open and
share content. What about saving? Vscode has this for 2-way diff and IIRC can
save individual panels. Low !/$.

## PaneFiles / PaneDiffs: replace 5/4-slot tuples with named objects

The webview currently models panes as `PaneFiles` (5 slots: `baseLeft, local,
merged, remote, baseRight`) and `PaneDiffs` (4 slots: `baseLeftDiff, lmDiff,
mrDiff, baseRightDiff`). Most slots are only populated when the user toggles
"compare with base". Two of the five file slots carry the same base content,
just positioned differently for the left/right comparison lanes.

Problems:
- Magic indices 0..4 scattered across `CodePane.tsx`, `App.tsx`, `meldPane.tsx`,
  `DiffCurtain.tsx`, `scrollMapping.ts`, `panesMapping.ts`, `highlightUtil.ts`,
  `editorActions.ts`, `appHooks.ts`, and tests.
- Nullable slots everywhere to represent "not yet loaded".
- Duplicated base content across slots 0 and 4.
- Shape-conversion code in `handleLoadDiff` just to stuff payload data into the
  5-slot layout.

Desired shape (indicative, finalise during refactor):
```ts
interface PaneState {
  local: FileState;
  merged: FileState;
  remote: FileState;
  base?: FileState;           // fetched once, optional UI toggle
  lmDiff: DiffChunk[];
  mrDiff: DiffChunk[];
  baseLeftDiff?: DiffChunk[]; // computed lazily when base is shown
  baseRightDiff?: DiffChunk[];
}
```

Benefits:
- Boundary payload can match internal shape; no conversion in `handleLoadDiff`.
- Base content is sent once, not duplicated.
- All consumers access named fields, no magic indices.
- Nullability is localised to the genuinely optional `base*` fields.

Scope: large, touches all the files listed above plus snapshots and tests.
Track as a dedicated refactor; do not fold into unrelated changes.

## Code duplication

Gemini's summary of jscpd (currently thresholded in `.jscpd.json`):

- src/matchers/myers.ts: Contains 4 separate clones (10-13 lines each), mostly within the core diffing logic.
- test/webview/ui/diffCurtainButtons.test.tsx: Has a significant 31-line internal clone of test setup/logic.
- src/extension.ts ↔ src/treeView.ts: Shares an 18-line block and a 9-line block, likely related to command registration or VS Code utility logic.
- src/webview/ui/editorActions.ts: Contains internal clones of 18 and 15 lines in action handlers.
- src/webview/ui/appHooks.ts ↔ highlightUtil.ts: Shares a 10-line logic block.

## Assorted Polish

- **Architectural Debt**:
  - Resolve **"State vs. Ref"** duplication: Data is mirrored in `useState` and `useRef` for high-frequency coordinate sync (e.g., in `App.tsx` and `useSynchronizedScrolling`).
  - Decompose **"God Hook"** `useAppState` in `App.tsx`: Break orchestration into domain-specific hooks (Messaging, Scrolling, Navigation).
  - Remove **`biome-ignore`** suppressions (e.g., `App.tsx:438`) and fix underlying lint/performance violations.
  - Decouple **Global Styles** from component templates: Move string-injected CSS in `App.tsx` to a structured CSS file.
  - Refactor **`scrollMapping.ts`**: Remove floating-point epsilon hacks (`1e-10`) and "fighting" the coordinate system in favor of discrete boundary validation.
- **Scroll Perf**: Throttle `setRenderTrigger` or move curtain drawing out of React; use `React.memo` for `CodePane`; cache line positions to avoid synchronous `getTopForLineNumber` calls during scroll.
- **Maintainability**: Replace magic indices (0-4) with an `enum`/`const` mapping or just use arrays.
- **Fix Returns**: Handle failures properly, e.g. from `getGitState`, without silently passing empty strings.
- **UX**: Rethink `Ctrl+K` to avoid interfering with global VS Code chord prefixes.
- **Refactor `DiffCurtain`**: Split into `CurtainContainer` + `CurtainSVG`. The container should always render to maintain 40px flexbox stability, while the SVG/drawing logic only activates when editors are ready. This will allow removing the `undefined` editor types from the core drawing functions.
- **Cull unnecessary `useEffect`s**: Many effects in `src/webview/ui/*` bridge state that is already derivable from props or should just be computed during render. Reserve `useEffect` for crossing the boundary to something non-React (Monaco events, `window`, `postMessage`, timers, DOM observers).
  - *Unnecessary (mirror-prop-to-ref)*: `useCodePaneSyncRefs` in `CodePane.tsx:518-537` — three effects that mirror `p.actions.*` and `p.file.content` into refs so event handlers can read them. Cleaner pattern: write the ref inline during render (`ref.current = latest`) or, better, inline the current action in the Monaco listener closure via a single `useRef` + updater called from the owner.
  - *Unnecessary (publish imperative handle)*: `CodePane.tsx:599-638` assigns `applyExternalEditsRef.current = { applyIncrementalEdits, applyFullSync }` inside an effect. This is what `useImperativeHandle` exists for.
  - *Necessary (external event source)*: `useCodePaneRenderTrigger` in `CodePane.tsx:544-565` subscribes to `model.onDidChangeContent` / `editor.onDidLayoutChange`. Effect is the right tool: external, needs cleanup.
  - *Necessary (one-shot side effect)*: `appHooks.ts:423-427` posts `{command: "ready"}` to the host. Has to happen after mount, once.
  - *Suggested structure*:
    - One small hook per external system (`useMonacoEvents(ed, handlers)`, `useWindowMessage(handler)`, `useVscodeReady(api)`).
    - For "latest callback in a listener" use a single `useRef` updated during render, not an effect per field.
    - For parent-visible imperative handles use `useImperativeHandle`, not a manually assigned ref.
    - Keep effect dep arrays narrow and stable; if a dep is a new object each render, hoist it or memoize it at the source rather than widening the dep list.
  - *Ratchet render-count baselines after the real fix*: `test/webview_render_count.test.tsx` pins today's App-level render counts via React's `Profiler` API. Observed today: mount + `loadDiff` = 5 commits; single user edit in merged = 1 commit. The per-edit number is already optimal — but it's only that low because the test runs a single edit inside one `act()` batch; multi-pane scroll sync, layout change cascades, and the `renderTrigger` global invalidator (every Monaco `onDidChangeContent` / `onDidLayoutChange` bumps App) will show up as soon as realistic scenarios are tested. Add scenarios (initial scroll, `fullSync`, compare-with-base toggle, typing with layout changes) as `renderTrigger` is removed, and lower the `EXPECTED_*` constants at the top of that file each time. Do not raise a baseline to accommodate a new regression.

Rename _mergeCache. It's more of a "current merged change list" than a cache. Maybe mergedDiffChunks?

## Testing Improvements

Add tests for opening deleted-by-us and deleted-by-them conflicts that have been resolved as deleting. Currently I think we still try to open these files even though they don't exist on disk.

- **Upgrade save tests to @vscode/test-electron**: The queue-ordering tests in
  `test/edit_queue_ordering.test.ts` verify that saves are properly ordered with
  edits in the promise queue, but they don't test actual `document.save()`
  integration with VS Code. For full e2e coverage of save behavior (including
  dirty state, file writes, and error handling), migrate to @vscode/test-electron
  which runs tests in an actual VS Code instance.

Consolidate biome `"includes": ["**/*.test.ts", "**/*.test.tsx"]` and `["test/**"]`

Questionable code in c06d4923:

1. Hardcoded Race Condition Workarounds
   In CodePane.tsx, a `setTimeout(..., 500)` automatically triggers "Next Conflict" navigation after mount. This is
   particularly annoying as it might jump the user's view unexpectedly half a
   second after the page loads.
2. Aggressive Content Syncing The sync logic in CodePane.tsx (lines 485-498)
   uses computeMinimalEdits and then m.pushEditOperations on every external
   sync. While this preserves undo history, doing this via a useEffect that
   triggers on an externalSyncId is a bit "hammer-ish" and could lead to
   performance issues or cursor jumping if the sync frequency increases.

3. Fragile Testing Mocks The mocking of Monaco in test/webview_react.test.tsx
   (lines 8-51) is extremely verbose and "brittle"—it defines specific numeric
   values for KeyCode and KeyMod (e.g., CtrlCmd: 2048). If the version of Monaco
   ever changes its internal enum values (which it occasionally does), these
   tests will pass incorrectly or fail mysteriously.

4. Search/Navigation Coupling In CodePane.tsx, the onSubmit handler (line 501)
   manually splits the entire editor contents by line just to find conflict
   markers (<<<<<<<, etc.):
