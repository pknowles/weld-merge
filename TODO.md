# Future Improvements & Known Issues

## Partially edited files

When opening a conflicted files, we follow Meld's behaviour of clobbering the
contents with the auto-merged result, with a warning of course.

Possible idea: instead of completely overwriting the file, we can parse the
document for typical Git conflict markers (`<<<<<<<` ... `=======` ...
`>>>>>>>`) and selectively inject the Meld auto-merged chunks *only* where those
markers exist using the VS Code WorkspaceEdit API. This way, any manual
resolutions or unrelated modifications the user has made outside of the
remaining conflict zones are perfectly preserved without the need for a warning
popup or diffing the original git state.

## Funcional breakages

Check auto-reload works if there are no pending changes - need to reload base, local, remote panes and re-run auto-merge.

Off-by-one error for DiffCurtain connecting to the very last line of a file.

## Perf improvements

Update SVG connection attributes rather than re-render the entire SVG. This involves keeping track of which we've displayed/culled, only updating the svg if those changed, and otherwise just updating the path coordinates.

## Fix commit message titles

Make sure the toggle compare-with-base icons are always visible - currently if there's not enough spacing they disappear

Make the commit title fill the space but use a ... ellipsis when the title is too long; remove the square brackets around it

Check the commit message font matches the rest - it looks odd. Maybe even just replace the message with an icon to see the card.

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

## Assorted Polish

- **Scroll Perf**: Throttle `setRenderTrigger` or move curtain drawing out of React; use `React.memo` for `CodePane`; cache line positions to avoid synchronous `getTopForLineNumber` calls during scroll.
- **Maintainability**: Replace magic indices (0-4) with an `enum`/`const` mapping or just use arrays.
- **Fix Returns**: Handle failures properly, e.g. from `getGitState`, without silently passing empty strings.
- **UX**: Rethink `Ctrl+K` to avoid interfering with global VS Code chord prefixes.
- **Refactor `DiffCurtain`**: Split into `CurtainContainer` + `CurtainSVG`. The container should always render to maintain 40px flexbox stability, while the SVG/drawing logic only activates when editors are ready. This will allow removing the `undefined` editor types from the core drawing functions.

Questionable code in c06d4923:

1. Hardcoded Race Condition Workarounds
   The agent used setTimeout everywhere to paper over race conditions between Monaco's lifecycle and React's render cycle.

   In meldPane.tsx, it uses setTimeout(..., 50) just to force a scroll sync
   after mounting. In CodePane.tsx, it uses setTimeout(..., 500) (line 610) to
   automatically trigger a "Next Conflict" navigation after mount. This is
   particularly annoying as it might jump the user's view unexpectedly half a
   second after the page loads.
2. Aggressive Content Syncing The sync logic in CodePane.tsx (lines 485-498)
   uses computeMinimalEdits and then m.pushEditOperations on every external
   sync. While this preserves undo history, doing this via a useEffect that
   triggers on an externalSyncId is a bit "hammer-ish" and could lead to
   performance issues or cursor jumping if the sync frequency increases.

3. Fragile Testing Mocks The mocking of Monaco in test/webview_e2e.test.tsx
   (lines 8-51) is extremely verbose and "brittle"—it defines specific numeric
   values for KeyCode and KeyMod (e.g., CtrlCmd: 2048). If the version of Monaco
   ever changes its internal enum values (which it occasionally does), these
   tests will pass incorrectly or fail mysteriously.

4. Search/Navigation Coupling In CodePane.tsx, the onSubmit handler (line 501)
   manually splits the entire editor contents by line just to find conflict
   markers (<<<<<<<, etc.):