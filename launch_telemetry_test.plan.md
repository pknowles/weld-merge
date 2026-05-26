# Plan: Launch Telemetry Tests

## Intent

When VS Code opens with two repos and two editor tabs already present, the
extension should do a small, deterministic amount of work and then stop. Every
observable operation should fire exactly as many times as its trigger event
justifies — once per repo, once per tab — with no echoing, multiplying, or
ongoing activity.

These tests instrument every observable operation in the launch sequence and
assert a count against a named constant. A count above its constant is a
failing test and an immediate bug report. Launch telemetry is opt-in through
the temporary test workspace setting `weld.launchTelemetry`; normal production
activation keeps the counters disabled. Refresh-repo work is labeled with its
real trigger reason instead of using production stack capture.

There are three layers:

1. `test/vscode/launchTelemetrySuite/launch_telemetry.test.ts` runs in a
   separate VS Code extension host with two conflicted repositories already in
   the workspace. It reads activation-owned telemetry from `WeldExtensionApi`,
   so it captures real launch work that happened before Mocha could attach
   spies.
2. `scripts/test_restored_tabs.ts` runs the true restored-tab scenario outside
   the `--extensionTestsPath` harness. It launches a normal development VS Code
   window twice with a fixed user-data-dir, fixed extensions-dir, and fixed
   workspace: the first launch opens two text merge tabs and two submodule
   resolver tabs across two conflicted repositories, then exits cleanly; the
   second launch opens only the workspace and asserts VS Code restored all four
   tabs while Weld startup telemetry stays bounded.
3. `test/vscode/suite/launch_telemetry.test.ts` keeps active-host runtime
   regression checks for tab startup and repository refresh behavior. These are
   not true launch tests because the normal VS Code suite runs inside one
   already-activated extension host.

Both layers use `waitForQuiet`; if the extension starts looping or polling, the
helper times out and fails with a clear message rather than a fixed sleep
masking the problem by waiting past the burst.

---

## Why Module Isolation Matters for Test Design

The extension is built with `esbuild --bundle`, which inlines all of
`src/repoContext.ts` — including `_firstStatusComplete`,
`_onRepositoryStateChangedEmitter`, and `notifyRepositoryStateChanged` — into
`out/extension.js`. Tests run under `tsx/cjs`, which loads `src/repoContext.ts`
as a separate module instance.

A `SubmoduleConflictEditorProvider` instantiated from `src/` subscribes to the
**source module's** `onRepositoryStateChanged` emitter. The bundled extension
fires the **bundle's** emitter. A double-snapshot regression in the bundled
code path would not produce a second message on a source-instantiated fake
panel.

All tests that count webview messages must use the **bundled**
`SubmoduleConflictEditorProvider`, obtained through `WeldExtensionApi`.

---

## Required Production Change (minimal)

Add the test seams to `WeldExtensionApi` in `src/extension.ts`, mirroring the
existing `meldCustomEditorProvider` export:

```typescript
export interface WeldExtensionApi {
    setInitialConflictContent: typeof MeldCustomEditorProvider.setInitialConflictContent;
    meldCustomEditorProvider: typeof MeldCustomEditorProvider;
    submoduleConflictEditorProvider: typeof SubmoduleConflictEditorProvider;
    restoreConflictedFile: typeof restoreConflictedFile;
    conflictedFilesProvider: ConflictedFilesProvider;
    notifyRepositoryStateChanged: typeof notifyRepositoryStateChanged;
    getTelemetrySnapshot(): WeldTelemetrySnapshot;
}
```

The editor class is exported, not an instance. A fresh instance shares the
bundle's module-level emitters — which is exactly what the runtime tests need.
`getTelemetrySnapshot()` is activation-owned and records from extension
activation onward when the hidden launch-telemetry setting is enabled, which
is what the isolated launch test needs without making normal production
activation pay diagnostic costs.

---

## All Instrumented Operations

These are every observable operation that could run amok. All are accessible
from test code without modifying production beyond the `WeldExtensionApi`
change above.

| Counter | What it measures | How to intercept |
|---|---|---|
| `treeRefresh` | `conflictedFilesProvider.refresh()` calls — the tree redraw signal | `sinon.spy(api.conflictedFilesProvider, "refresh")` |
| `treeGetChildren` | `conflictedFilesProvider.getChildren()` calls — actual tree materialization *if VS Code requested it* | `sinon.spy(api.conflictedFilesProvider, "getChildren")` |
| `stateChanges[i]` | `repo.state.onDidChange` fires per repo — the root signal everything derives from | subscribe from test after `openRepoInGitExtension` |
| `conflictStateChanged` | `MeldCustomEditorProvider.onConflictStateChanged` fires — text editor reload trigger | subscribe via `api.meldCustomEditorProvider.onConflictStateChanged.event` |
| `snapshotMessages` | `"snapshot"` messages received per submodule panel | `panel.allMessages.filter(m => m.command === "snapshot")` |
| `terminalMessages` | `"conflictLost"` or `"error"` per panel — must always be zero | `panel.allMessages.filter(m => m.command === "conflictLost" \|\| m.command === "error")` |

The isolated launch test also reads `refreshRepoReasons` from the extension's
opt-in telemetry snapshot. Reasons are explicit domain labels such as
`firstStatusComplete` and `repositoryStateChanged`; no production stack traces
are captured.

**Note on `treeGetChildren`**: VS Code only calls `getChildren()` if the tree
view is visible and expanded. In a headless test host the count may be zero
even when `refresh()` fires. Count it as a diagnostic metric; do not assert
it equals `treeRefresh` and do not use it as a settling signal.

---

## Settling Helper

Fixed sleeps prove nothing: they can pass on a loop that bursts every 600 ms
and fail on a slow CI machine that just needs more time.

### `waitForQuiet(getCount, quietWindowMs, timeoutMs)`

Polls `getCount()` every 50 ms (one debounce interval). Returns once the count
has not changed for `quietWindowMs` consecutive milliseconds. Throws if
`timeoutMs` elapses without settling — meaning the extension never stopped.

```typescript
async function waitForQuiet(
    getCount: () => number,
    quietWindowMs = 200,
    timeoutMs = 10_000,
): Promise<void> {
    const pollMs = 50;
    let last = getCount();
    let quietFor = 0;
    let elapsed = 0;
    while (quietFor < quietWindowMs) {
        await new Promise((r) => setTimeout(r, pollMs));
        elapsed += pollMs;
        if (elapsed > timeoutMs) {
            throw new Error(
                `Extension never went quiet after ${timeoutMs} ms — ` +
                    `last count: ${getCount()}`,
            );
        }
        const current = getCount();
        quietFor = current === last ? quietFor + pollMs : 0;
        last = current;
    }
}
```

### Settling sequence used by Tests 1 and 2

```
waitForMergeChanges(repo1, 1)              ← concrete lifecycle boundary: first status ran
waitForMergeChanges(repo2, 1)
await waitForQuiet(() => refreshSpy.callCount, 200ms, 10s)
                                           ← refresh() has stopped firing
snapshot counters as "at settle" baseline
await new Promise(r => setTimeout(r, 100)) ← one more debounce cycle to catch trailing events
assert counters unchanged vs baseline      ← proves nothing restarted
```

If the extension is looping, `waitForQuiet` never returns and throws after 10 s
with `last count: N` in the message — immediately identifying that something
is still calling `refresh()`.

---

## Extension-Test Launch File

`test/vscode/launchTelemetrySuite/launch_telemetry.test.ts`

Run by `test/vscode/runTest.ts` in a separate `runTests()` call before the main
suite. The runner creates a `.code-workspace` with two conflicted repositories
before launching VS Code. The test waits for both workspace repositories and
their first `mergeChanges`, then reads `api.getTelemetrySnapshot()`.

**Assertions**:

```typescript
assert.ok(snapshot.treeRefreshes <= TREE_REFRESH_CEILING);
assert.ok(snapshot.refreshRepoCalls <= REFRESH_REPO_CEILING);
assert.ok(snapshot.repositoryStateChangedEvents <= REPOSITORY_STATE_CHANGED_CEILING);
assert.ok(snapshot.conflictStateChangedEvents <= CONFLICT_STATE_CHANGED_CEILING);
assert.ok(snapshot.treeGetChildrenCalls <= TREE_GET_CHILDREN_CEILING);
```

The snapshot prints `refreshRepoReasons` even on success so an unexpected
number comes with its trigger breakdown.

---

## Restored-Tab Launch Script

`scripts/test_restored_tabs.ts`

Run by `npm run test:vscode:restored-tabs` and included in `npm run
pre-checkin`. This is the restored-tab coverage that the extension-test harness
cannot provide reliably.

The script creates:

- A temporary workspace with two conflicted repositories. Each repository has
  one normal text conflict and one submodule gitlink conflict.
- A fixed temporary user-data-dir.
- A fixed temporary extensions-dir.
- A tiny driver extension loaded with `--extensionDevelopmentPath` alongside
  Weld.

It then launches VS Code twice:

1. Seed launch: open the workspace, activate Weld, open both conflicted text
   files with `vscode.openWith(..., "weld.mergeEditor")`, open both submodule
   conflicts with `vscode.openWith(..., "weld.submoduleConflict")`, wait for
   all four tabs, write the Weld telemetry snapshot, and close the window
   cleanly.
2. Assertion launch: open only the same workspace and fixed profile, wait for
   VS Code to restore the two `weld.mergeEditor` tabs and two
   `weld.submoduleConflict` tabs, write the Weld telemetry snapshot, and close
   the window cleanly.

The assertion launch must not open files itself. If the tabs appear, they came
from VS Code's persisted workbench state. Both launches assert the same bounded
telemetry:

```typescript
treeRefreshes <= 2;
refreshRepoCalls <= 2;
repositoryStateChangedEvents <= 2;
conflictStateChangedEvents <= 2;
treeGetChildrenCalls <= 2;
```

This test protects the real user complaint: two restored editor tabs across two
repositories must not trigger blind whole-extension refreshes, repeated tree
churn, or launch loops. The production path is allowed to load only the repo
state and editor state justified by the actual Git and webview lifecycle events.

---

## Runtime Regression Test File

`test/vscode/suite/launch_telemetry.test.ts`

Picked up automatically by the glob in `test/vscode/suite/index.cjs`.

The `before()` block activates the extension and stores `WeldExtensionApi`.
Because this suite runs after extension activation, these tests deliberately
measure active-host runtime behavior: opening repositories after activation,
opening restored-tab-shaped fake panels, and firing repository refresh signals.

---

## Test 1 — Runtime Repository-Open Audit: Counts

**Question**: How many times does each operation fire when two conflicted
repositories are opened in an already-active extension host?

**Setup**: Install all counters before opening any repos. Open 2 repos with
conflicts. Run the settling sequence. Print the grouped `refreshCallSites`
summary (always, not just on failure).

**Assertions** (constants named and commented in the test file):

```typescript
// state.onDidChange: git fires at least once per repo for initial status.
// May fire more than once in some environments — assert bounded, not exact.
assert.ok(stateChanges[0] >= 1 && stateChanges[0] <= STATE_CHANGES_CEILING);  // 1–3
assert.ok(stateChanges[1] >= 1 && stateChanges[1] <= STATE_CHANGES_CEILING);  // 1–3

// refresh(): one scheduleRefresh at watchRepo startup + one on first
// state.onDidChange per repo, both debounced at 50 ms — may coalesce.
// Upper bound: 2 per repo × 2 repos = 4. Coalescing can reduce this to 1.
assert.ok(treeRefresh <= REFRESH_CEILING);   // 4

// getChildren(): reported for diagnostic value only. May be less than
// treeRefresh if the tree view is hidden in the headless test host.
// Do not assert equality with treeRefresh.
console.log(`getChildren calls: ${treeGetChildren} (refresh calls: ${treeRefresh})`);

// onConflictStateChanged: fired once per refreshRepo call per repo.
assert.ok(conflictStateChanged <= CONFLICT_STATE_CHANGED_CEILING);   // 4

// After the quiet window: nothing new fired.
assert.equal(treeRefresh, treeRefreshAtSettle);
assert.equal(stateChanges[0], stateChangesAtSettle[0]);
assert.equal(stateChanges[1], stateChangesAtSettle[1]);
```

---

## Test 2 — Steady-State Silence: No Ongoing Activity

**Question**: Is the extension doing any work when nothing is happening?

**Setup**: Open 2 repos. Run the settling sequence. Install counters **after**
the quiet window — measuring silence only, not launch.

**Assertions**: After 5 seconds of no user activity:

```typescript
assert.equal(treeRefresh, 0);
assert.equal(treeGetChildren, 0);
assert.equal(stateChanges[0], 0);
assert.equal(stateChanges[1], 0);
assert.equal(conflictStateChanged, 0);
```

These are hard invariants — always zero. Any non-zero value means the
extension is polling or has a leaking listener.

---

## Test 3 — Tab Startup Isolation: Opening Tabs Must Not Touch the Tree

**Question**: Does the act of opening an editor tab cause any tree work?

**Setup**: Open 2 repos. Run the settling sequence. Install counters. Open 2
bundled submodule editor tabs, fire `ready` on both, wait for both snapshots.
Run `waitForQuiet` on `treeRefresh`.

**Assertions**:

```typescript
// Tab startup must not trigger any tree work.
assert.equal(treeRefresh, 0);
assert.equal(treeGetChildren, 0);

// Each tab receives exactly one snapshot and no terminal messages.
// Total postMessage count is not asserted — it is implementation detail.
assert.equal(snapshots1, SNAPSHOTS_PER_TAB);   // 1
assert.equal(snapshots2, SNAPSHOTS_PER_TAB);   // 1
assert.equal(terminal1, 0);
assert.equal(terminal2, 0);
```

---

## Test 4 — Race: Exactly One Snapshot When Tab Fires Ready Before First Status

**Question**: If `ready` arrives before the repository's first
`state.onDidChange`, does the tab still get exactly one snapshot — no double
from the subsequent `refreshRepo → notifyRepositoryStateChanged`?

**Guaranteeing the race window**: Use a controlled `state.onDidChange` emitter
(held by the test) so the race is explicit, not a timing hope. The fake
repository exposes the same `rootUri` and settled `mergeChanges` as the real
one, but `state.onDidChange` is the test's emitter.

### Critical: The Stub Must Go In Before `openRepoInGitExtension`

`watchRepo` subscribes to `state.onDidChange` inside the `onDidOpenRepository`
handler, which fires when `openRepoInGitExtension` calls `api.openRepository`.
If the git API stub is installed *after* that call, `watchRepo` is already
subscribed to the **real** repo's emitter. Firing the controlled emitter then
unblocks the editor's `fromFirstStatusComplete` but does **not** trigger
`watchRepo`'s `scheduleRefresh` → `refreshRepo` → `notifyRepositoryStateChanged`
chain — the second snapshot path is never exercised and the race is not
reproduced.

**Correct setup order**:
1. Create the conflict fixture on disk (do not open in git extension yet).
2. Build the fake repository object with controlled `state.onDidChange`.
3. Install the git API stub so that `repositories`, `getRepository`,
   `getRepositoryRoot`, `openRepository`, and `onDidOpenRepository` all
   surface the fake repository for the fixture path.
4. Call `openRepoInGitExtension` — `onDidOpenRepository` fires, `watchRepo`
   subscribes to the fake emitter.
5. Resolve the custom editor, fire `ready`.
6. Assert ≥ 1 listener on the fake emitter (proves both `watchRepo` and
   `fromFirstStatusComplete` are waiting). If zero, fail with "race window not
   reached — stub is misconfigured or fast-path fired unexpectedly".
7. Fire the emitter. Both `watchRepo` and `fromFirstStatusComplete` receive it.

**Settling**: After firing and receiving the first snapshot, run
`waitForQuiet(() => snapshotCount + refreshSpy.callCount, 1000ms)` — the
debounced `refreshRepo → notifyRepositoryStateChanged` path fires within 50 ms
of `watchRepo`'s callback, and the wider quiet window gives the async snapshot
path room to post if it is going to.

**Assertions**:

```typescript
assert.equal(snapshots1, SNAPSHOTS_PER_TAB);   // 1
assert.equal(snapshots2, SNAPSHOTS_PER_TAB);   // 1
assert.equal(terminal1, 0);
assert.equal(terminal2, 0);
```

---

## What These Tests Do Not Check

- Snapshot content correctness — covered by existing snapshot tests.
- Text-conflict (Meld) tab message counts — the text editor has a different
  startup path. Add a fifth test mirroring Test 3 using
  `MeldCustomEditorProvider` if text-editor churn is later suspected.
- `onDidSaveTextDocument` triggering a refresh — no documents are saved during
  these tests. If auto-save is suspected, add a targeted test that saves a
  file and asserts exactly one additional `refresh()` fires.

---

## Completion Criteria

`npm run pre-checkin` passes, including `npm run test:vscode:restored-tabs`.
The tests together catch:

- Extension-test launch: operation counts multiplying during real extension
  launch with two workspace repositories
- Restored-tab launch script: operation counts multiplying when VS Code restores
  two real Weld editor tabs from a fixed profile on the second launch
- Test 1: any runtime repository-open operation count multiplying beyond its
  constant
- Test 1: ongoing activity after settle (`waitForQuiet` timeout or counter mismatch)
- Test 2: any polling or leaking listener in steady state
- Test 3: tab startup leaking into tree work
- Test 4: double-snapshot from the `notifyRepositoryStateChanged` race
