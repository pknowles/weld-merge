# Test plan: custom editor startup race with Git initialization

## Bug description

Both the Weld 3-way merge editor (`weld.mergeEditor`) and the submodule conflict
editor (`weld.submoduleConflict`) can resolve a restored/open tab too early,
while VS Code's Git extension is activated but has not yet exposed the repository
or populated merge conflict metadata.

The correctness contract for these tests:

> A restored custom editor may wait while Git, repository, or conflict metadata is
> unavailable, but it must not turn that transient absence into a terminal
> user-facing error. Once Git reports the repository and live conflict state, the
> already-open editor must render the real conflict without requiring the user to
> close and reopen the tab.

## Concrete transient states to test

These are separate states and should not be collapsed into one "Git not initialized"
mock:

1. **Repository unavailable**
   - `getGitApi()` succeeds.
   - `gitApi.getRepository(uri)` returns `null` for the target repo.
   - `gitApi.repositories` does not include the target repo.

2. **Repository available, merge metadata unavailable**
   - `gitApi.getRepository(uri)` returns a repository object.
   - `repository.state.mergeChanges` is temporarily empty even though the conflict
     is live on disk.

Current expected failures:

- Merge editor: repository unavailable causes `resolveCustomTextEditor()` to set
  permanent HTML: `"Cannot open: file is not in a git repository."`
- Submodule editor, repository unavailable: `repositoryForIdentity()` throws and
  the webview receives an `error` command.
- Submodule editor, merge metadata unavailable: `SubmoduleConflict.load()` throws
  `SubmoduleConflictUnavailableError`, and the webview receives `conflictLost`.

The tests should fail on those terminal states until the production retry path is
implemented.

---

## Test cases

File: `test/vscode/suite/git_initialization_race.test.ts`

All tests use **real Git repos and real conflict state on disk**. The only mocked
piece is the Git API initialization boundary, using the existing
`sinon.stub(gitExt.exports, "getAPI")` pattern from the VS Code integration
suite.

This plan is for **tests only**. Do not change production code while
implementing this test file. Some delayed-initialization tests are expected to fail
against the current production code; that is the regression signal these tests
are meant to establish before the fix pass.

The original request asked for four scenarios: delayed and immediate startup for
a conflicted submodule, and delayed and immediate startup for a conflicted text
file. This plan intentionally adds one extra submodule delayed test because
"Git not initialized" has two distinct observable states for submodules and those
states currently fail through different code paths. The extra test is not a
replacement for any of the requested four scenarios.

Mapping to the requested scenarios:

- Requested submodule delayed startup: Cases 1 and 2 together.
- Requested submodule immediate startup: Case 3.
- Requested text-file delayed startup: Case 4.
- Requested text-file immediate startup: Case 5.

### Monkeypatching policy

Use test-local monkeypatching and fakes to reach the startup states precisely.
Do not add production infrastructure or public extension API solely to make
these tests possible.

Allowed test seams:

- Stub `gitExt.exports.getAPI`.
- Wrap `getRepository`, `repositories`, and `repository.state.mergeChanges`.
- Patch private provider methods in the test, as existing tests do for
  `_initializeWebview`.
- Use fake `WebviewPanel` objects to capture `postMessage` and inject `"ready"`.
- Fire existing provider events such as
  `SubmoduleConflictEditorProvider.onRepositoryStateChanged`.

Forbidden shortcuts:

- Do not add production-only test hooks.
- Do not expose new `WeldExtensionApi` fields only for these tests.
- Do not call `rm()` on a path derived from `repoPath` with `dirname()`,
  `basename()`, or similar inference. Fixture creation must carry the explicit
  cleanup root.
- Do not fake Git stage contents, submodule history, commit graphs, or conflict
  payloads. Those must come from real Git repos on disk.
- Do not re-call `resolveCustomTextEditor()` or `resolveCustomEditor()` after
  release to simulate close/reopen behavior.

### Loading proof

The VS Code provider tests use fake `WebviewPanel` objects, so they do not run
React and cannot directly inspect rendered DOM text. To verify the requested
"tab first shows loading" behavior robustly, use a two-part proof:

1. Add or extend React UI tests that render each app before any host payload is
   delivered:
   - merge editor `App` initially renders `Loading Diff...`;
   - submodule `SubmoduleApp` initially renders `Loading...`.
2. In the delayed VS Code provider tests, assert the provider installs the
   normal webview HTML shell and does not send/render a terminal error before
   Git initialization is released. Because the UI initial state is known to be
   loading, a real restored tab with that shell remains on the loading view until
   the provider eventually sends `loadDiff` or `snapshot`.

Do not let a blank/no-op panel satisfy "loading." The delayed tests must prove
the normal webview shell exists before release and that the same panel later
receives real conflict content after release.

### Shared helpers

Reuse from `helpers.ts`:

- `makeRepoFixture` + `makeConflict` for text conflict.
- `makeSubmoduleConflictFixture` for submodule conflict.
- `cleanupTempFixture` for removal. Always clean up the fixture's explicit
  `cleanupPath`; never derive a deletion target from `repoPath`.
- `openRepoInGitExtension` to expose a real repo to the Git extension.

Add helpers in this test file unless they become broadly useful:

- `nextMergeChanges(repo, expectedCount)`: if
  `repo.state.mergeChanges.length === expectedCount`, return immediately;
  otherwise subscribe to `repo.state.onDidChange` and resolve when the count
  matches. Do not add an internal timer; Mocha's test timeout is the failure
  boundary if the event never arrives.

- `nextRepoClose(repoPath)`: if the repo is already closed, return immediately;
  otherwise subscribe to `gitApi.onDidCloseRepository` and resolve when that repo
  closes. Use this in `finally` cleanup with `cleanupTempFixture`. Do not add an
  internal timer.

- `nextWebviewMessage(panel, command)`: returns a promise that resolves on the
  next captured `webview.postMessage()` with that command. The promise must be
  registered before triggering the action expected to post the message.

- `nextInitializeCall(captured)`: returns a promise that resolves from the
  `_initializeWebview` test double when it is called. The promise must be
  registered before releasing Git initialization.

- `withRepositoryUnavailable(repoPath, runTest)`: stubs
  `gitExt.exports.getAPI()` so calls pass through to the real API except:
  `getRepository(uri)` returns `null` for `repoPath` and children, and
  `repositories` excludes the repo. The helper provides `release()` which
  restores real behavior, calls `openRepoInGitExtension(repoPath)`, gets the
  real repo, and resolves only after `nextMergeChanges(repo, expectedCount)`
  has observed the real Git API state-change event.

- `withEmptyMergeChanges(repoPath, runTest)`: opens the real repo first and
  waits for merge changes, then stubs `getAPI()` to return a wrapper repository
  for the target repo whose `state.mergeChanges` starts as `[]`. The helper
  provides `release()` which switches the wrapper to expose the real
  `mergeChanges`. Implement this with `Object.defineProperty` on the wrapper
  `state` object so the test does not rely on `mergeChanges` being a writable
  plain property.

- `makeFakePanel()`: fake `WebviewPanel` with:
  - `webview.html` storage.
  - `webview.options` storage.
  - `webview.postMessage(message)` capture.
  - `webview.onDidReceiveMessage(listener)` backed by a `vscode.EventEmitter`.
  - `fireWebviewMessage(message)` for injecting `"ready"`.
  - `onDidDispose(listener)` support sufficient for provider registration.

- `assertNoTerminalSubmoduleMessage(messages)`: asserts no `error` and no
  `conflictLost`.

- `assertSnapshotMessage(messages)`: asserts a `snapshot` message exists and its
  snapshot includes valid base/local/remote SHAs for the submodule conflict.

- `makeSubmoduleDocument(repoPath)`: constructs the restored-tab document for
  `sub` without requiring the Git API to be ready. Build the URI from stable
  identity with `submoduleConflictUri({ repositoryRoot: Uri.file(repoPath),
  submodulePath: "sub" })`, then call
  `provider.openCustomDocument(uri, ...fakeOpenContext, ...fakeToken)`.

- `assertNormalWebviewShell(panel)`: asserts `panel.webview.html` contains the
  normal app root and script tag for that provider, and does not contain terminal
  error text such as `"Cannot open:"`, `"No submodule snapshot."`, or a
  provider-authored repository error.

### Initialization release

Delayed tests should simulate Git initializing by changing only the test's Git
API mock state, then using existing extension/provider signals that already
exist in the project.

For submodule provider-level tests, the current provider already listens to
`SubmoduleConflictEditorProvider.onRepositoryStateChanged`. After `release()`
has exposed the real repo and real merge changes, fire:

```ts
SubmoduleConflictEditorProvider.onRepositoryStateChanged.fire(Uri.file(repoPath));
```

This is not new production behavior; it is the existing provider refresh signal
that the real extension's repo watcher fires.

For merge editor tests, do not invent or call a retry hook. After `release()`,
the test should open/expose the real repo through the Git extension and await a
promise resolved by the `_initializeWebview` test double on the already-open
editor. The test is expected to fail until production code naturally reacts to
Git initialization. Do not re-call
`resolveCustomTextEditor()` manually; that would test close/reopen behavior, not
restored-tab recovery.

---

## Case 1 — Submodule editor: repository unavailable, then initialized

```
given: real submodule conflict repo exists on disk
and:   Git API is active but getRepository(repoRoot) returns null
when:  SubmoduleConflictEditorProvider.resolveCustomEditor() is called
and:   the webview fires "ready"
then:  no "error" command is sent
and:   no "conflictLost" command is sent
and:   the normal submodule webview shell is installed so the UI can show Loading...

when:  release() exposes the real repo and merge changes
and:   the provider's retry signal is fired
then:  the same webview receives a "snapshot" command
and:   the snapshot has valid base/local/remote SHAs
```

Currently expected to fail because repository lookup throws and posts `error`.

## Case 2 — Submodule editor: merge metadata unavailable, then initialized

```
given: real submodule conflict repo is registered
and:   the wrapper repository temporarily reports mergeChanges = []
when:  SubmoduleConflictEditorProvider.resolveCustomEditor() is called
and:   the webview fires "ready"
then:  no "conflictLost" command is sent
and:   no "error" command is sent
and:   the normal submodule webview shell is installed so the UI can show Loading...

when:  release() exposes the real mergeChanges
and:   the provider's retry signal is fired
then:  the same webview receives a "snapshot" command
and:   the snapshot has valid base/local/remote SHAs
```

Currently expected to fail because empty `mergeChanges` becomes
`SubmoduleConflictUnavailableError` and posts `conflictLost`.

## Case 3 — Submodule editor: Git already initialized

```
given: real submodule conflict repo is registered
and:   nextMergeChanges(repo, 1) has completed
when:  SubmoduleConflictEditorProvider.resolveCustomEditor() is called
and:   the webview fires "ready"
then:  the webview receives a "snapshot" command
and:   the snapshot has valid base/local/remote SHAs
and:   no "error" or "conflictLost" command is sent
```

This is the happy-path regression guard.

## Case 4 — Merge editor: repository unavailable, then initialized

```
given: real text conflict repo exists on disk
and:   Git API is active but getRepository(fileUri) returns null
when:  MeldCustomEditorProvider.resolveCustomTextEditor() is called
then:  panel.webview.html does not contain "Cannot open: file is not in a git repository."
and:   the normal merge webview shell is installed so the UI can show Loading Diff...
and:   _initializeWebview has not been called yet

when:  release() exposes the real repo and merge changes
then:  the already-open editor eventually initializes without re-calling
       resolveCustomTextEditor()
and:   _initializeWebview is called exactly once
and:   the captured ConflictedItem has the target file URI and repository root
```

Currently expected to fail because `resolveCustomTextEditor()` writes permanent
not-in-repository HTML and has no retry path.

Do not make this test pass by accepting an empty HTML string after the provider
has returned if the editor has also abandoned all future work. The test must
prove the same panel eventually initializes after Git initialization. Do not re-call
`resolveCustomTextEditor()` manually.

## Case 5 — Merge editor: Git already initialized

```
given: real text conflict repo is registered
and:   nextMergeChanges(repo, 1) has completed
when:  MeldCustomEditorProvider.resolveCustomTextEditor() is called
then:  _initializeWebview is called exactly once
and:   the captured ConflictedItem has the target file URI and repository root
and:   panel.webview.html does not contain a terminal error string
```

This is the happy-path regression guard.

---

## Assertion guidance

Prefer user-visible or payload-visible correctness over implementation details:

- Good: no terminal `error` / `conflictLost` while initialization is transient.
- Good: positive loading proof through React initial-state tests plus normal
  provider HTML shell before release.
- Good: eventual `snapshot` / merge editor initialization for the same open
  panel after initialization.
- Good: valid real Git data in the payload or captured `ConflictedItem`.
- Avoid: treating blank HTML, no registered message listener, or no-op provider
  behavior as a loading state.

Delayed-initialization tests must fail on today's terminal bug states:

- Submodule repository unavailable: any webview `error` command before release
  is a failure.
- Submodule merge metadata unavailable: any webview `conflictLost` command
  before release is a failure.
- Merge editor repository unavailable: permanent `"Cannot open: file is not in a
  git repository."` HTML is a failure.
- Any delayed case: blank/no-op panel state before release is a failure because
  it does not verify the requested loading tab behavior.

Delayed-initialization tests should not pass only because the test fake failed to
drive the provider. Each delayed test must prove it reached the relevant code
path:

- For submodule tests, fire `"ready"` and assert that the fake webview received
  a post-release `snapshot` by awaiting a `nextWebviewMessage(panel, "snapshot")`
  promise registered before firing the provider refresh signal.
- For merge editor delayed initialization, assert that `resolveCustomTextEditor()`
  was called once, `_initializeWebview` was not called while the repo was
  unavailable, and the same panel initializes after `release()` by awaiting a
  `nextInitializeCall(captured)` promise registered before release.

`_initializeWebview` interception is acceptable for the merge editor because the
existing tests already use that seam and it avoids duplicating full webview
bootstrapping. If a lightweight fake webview can drive the real ready handshake
cleanly for text conflicts, prefer asserting the eventual `loadDiff` payload
instead.

## Implementation notes

### Mocking pattern

Follow the existing VS Code suite pattern:

- Stub `gitExt.exports.getAPI`.
- Call the original `getAPI()` inside the stub.
- Override only `getRepository()` and the getter-only `repositories` value for
  the target repo.
- Pass all unrelated repos and API methods through unchanged.
- Restore the stub in `finally`.

Do not hand-author fake conflict stages, fake commit graphs, or fake submodule
history. The conflict data must come from real Git repositories on disk.

### Submodule editor access

Do not change `extension.ts` just to expose submodule internals for this
tests-only pass. Import the already-exported `SubmoduleConflictEditorProvider`
and URI helpers directly from source for these provider-level tests. Use the
static `onRepositoryStateChanged` from that same imported class instance; these
tests instantiate their own provider and do not depend on the running
extension's registered provider instance.

### Event-driven async gating

Do not poll for editor behavior and do not use arbitrary sleeps. Every expected
transition has an event or callback in the test harness:

- `nextMergeChanges(repo, expectedCount)` resolves from `repo.state.onDidChange`.
- `nextWebviewMessage(panel, "snapshot")` resolves directly inside the fake
  `webview.postMessage()` implementation.
- `nextInitializeCall(captured)` resolves directly inside the `_initializeWebview`
  test double.
- `nextRepoClose(repoPath)` resolves from `gitApi.onDidCloseRepository`.

The only timeout should be Mocha's outer test timeout, which reports a failed
test if an expected event never arrives. Do not hide missing events behind
polling loops or fixed sleeps.
