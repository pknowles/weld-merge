# Refactor Plan: Git API Readiness For Restored Custom Editors

## Problem

VS Code can restore Weld custom editor tabs before the built-in Git extension has
finished initializing its API and before it has opened the repository needed by
that tab. Weld currently tries to infer readiness inside individual editor
providers, which has led to editor-local booleans, stale global maps, blank tabs,
and premature terminal errors.

The target design is:

- Register custom editor providers immediately during extension activation.
- Let webviews ask for state when they are ready.
- Fulfill that request only after the Git API and the specific repository are
  available.
- Report terminal errors only when they are known, not guessed from transient
  absence.
- Preserve strict initialization: do not construct editor/session objects in a
  half-ready state and later patch them into validity.
- Fail as soon as there is enough information to fail. Do not wait indefinitely
  for "maybe later" states, and do not model infinite waits as a timeout-free
  strategy. Every wait must be for a concrete dependent operation or event that
  can produce a success or a specific error.

## Design Principle

Do not model readiness as optional state. Model it by construction.

Bad shape:

```ts
const session = new EditorSession();
session.repository = unprovenRepository;
session.ready = false;
```

Good shape:

```ts
const repository = await gitRepositoryForDocument(document.uri);
const session = new EditorSession(document, panel, repository);
```

If an object requires a repository to be valid, do not create that object until
the repository exists. Before then, the provider owns only a small pending
request object whose entire purpose is to wait for a concrete lifecycle event and
then construct the real object.

For repositories, the startup-valid object should not be the raw
`GitApiRepository`. Introduce a small wrapper such as `ReadyRepository` whose
existence means:

- the Git API is initialized,
- the Git API has opened/exposed the repository object,
- the repository's first status run has completed and Git API state such as
  `mergeChanges` is populated.

The wrapper is the RAII boundary for initial editor state. Code that needs
populated Git state during custom-editor startup should acquire a
`ReadyRepository` before reading state.

## New Shared Git API Helper

Add a small helper module, likely `src/gitApiReady.ts` or adjacent to
`repoContext.ts`.

Responsibilities:

- Activate `vscode.git`.
- If the Git extension reports that it is disabled, throw
  `GitApiUnavailableError` immediately. The user can retry after enabling Git.
- Wait for `api.state === "initialized"` using `api.onDidChangeState`.
- Return a fully initialized Git API object.
- Share only the in-flight promise for API initialization. Do not pin the
  resolved Git API forever; tests, reloads, and extension-host replacement need
  later calls to observe the current VS Code Git export.

Sketch:

```ts
async function getGitApiWhenInitialized(): Promise<GitApi> {
  const gitExtension = extensions.getExtension<GitExtension>("vscode.git");
  if (!gitExtension) {
    throw new Error("Git extension is not available.");
  }

  const exports = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();

  if (!exports.enabled) {
    throw new GitApiUnavailableError("The built-in Git extension is disabled.");
  }

  const api = exports.getAPI(1);
  if (api.state === "initialized") {
    return api;
  }

  await waitForGitApiState(api, "initialized");
  return api;
}
```

Important:

- No timeout.
- No editor code should use `extensions.getExtension("vscode.git").exports`
  directly after this refactor.
- `getGitApi()` can remain for low-level code that is only called after
  readiness is guaranteed, but custom editor startup should use the initialized
  helper.
- The cached initialization promise must be testable. Prefer the current shape:
  keep only the in-flight promise and clear it in `finally`, so a previous
  success or failure cannot poison later tests.

### Explicit Helper Contract

Implement these helpers as named functions with comments documenting their
intent and lifecycle assumptions:

```ts
function getGitApiWhenInitialized(): Promise<GitApi>;
function waitForGitApiState(api: GitApi, state: "initialized"): Promise<void>;
```

Failure behavior:

- If the built-in Git extension is missing, throw `GitApiUnavailableError`.
- If activating `vscode.git` fails, propagate the activation error as the cause
  of `GitApiUnavailableError`.
- If `getAPI(1)` throws, propagate that error with context. Do not convert it
  into "not in repository."
- If Git is disabled, throw `GitApiUnavailableError` immediately. Do not wait
  for `onDidChangeEnablement`; disabled Git is already enough information to
  fail the current editor request.
- Waiting for `api.state === "initialized"` is valid only because Git activation
  returned an API object whose documented lifecycle includes an initialization
  result. If that wait is implemented with an event listener, the listener must
  be cleaned up when the promise settles.

## Repository Acquisition

Repository availability is separate from Git API readiness.

Add helpers that return a repository object only when one is actually available.
VS Code Git API methods such as `getRepository`, `getRepositoryRoot`, and
`openRepository` expose nullable returns. Treat those as an external API
boundary: unwrap them immediately inside the acquisition module and convert the
documented absence cases into typed errors. No helper used by editor providers
should return `null`, `undefined`, optional fields, or tagged absence objects to
mean "try later" or "not in a repository."

They should either:

- Resolve with a fully available `ReadyRepository` or a higher-level object
  built from one, such as `ConflictedItem`.
- Wait only on a concrete dependent operation/event that is known to produce the
  required object or a specific failure.
- Throw a specific terminal/domain error, such as `NotInRepositoryError`.
- Throw operational errors with their original details preserved.

Use private boundary helpers to keep nullable Git API calls out of editor code:

```ts
async function repositoryRootForDocument(api: GitApi, uri: Uri): Promise<Uri>;
async function openRepositoryAtRoot(api: GitApi, rootUri: Uri, panel: WebviewPanel): Promise<GitApiRepository>;
```

`repositoryRootForDocument()` may first ask `api.getRepository(documentUri)` and
use that repository's root if it is already open; otherwise it calls
`api.getRepositoryRoot(documentUri)`. `openRepositoryAtRoot()` wraps
`api.openRepository(rootUri)`. These helpers call the nullable Git API methods
internally and immediately throw typed errors when the API reports absence.
Their signatures must not expose the nullable shape.

The caller may catch known domain errors at the UI boundary to render terminal
HTML, but it must not catch unknown errors and convert them into loading,
not-in-repository, conflict-lost, empty state, or any other benign-looking
outcome.

Bad shape:

```ts
const repository = await acquireRepositoryOrMaybe(uri);
const session = new EditorSession(document, panel, repository);
```

Good shape:

```ts
try {
  const repository = await acquireRepository(uri);
  initializeEditor(repository);
} catch (error) {
  if (error instanceof NotInRepositoryError) {
    showNotInRepository(error);
    return;
  }
  throw error;
}
```

### Explicit Repository Helper Contract

Implement the repository acquisition layer as functions with precise outcomes:

```ts
async function readyRepositoryForRoot(rootUri: Uri, panel: WebviewPanel): Promise<ReadyRepository>;

async function conflictedItemForDocument(
  documentUri: Uri,
  panel: WebviewPanel,
): Promise<ConflictedItem>;
```

These functions must either resolve with the fully initialized object named in
their return type or throw. They must not return maybe-values.

Expected errors:

- `NotInRepositoryError`: the document/root is known not to belong to a Git
  repository. The text editor catches this at the UI boundary and renders the
  existing not-in-repository message.
- `RepositoryUnavailableError`: a restored tab identity names a repository root,
  but the Git API cannot open that repository. The editor catches this at the UI
  boundary and renders an operational error, not loading and not
  not-in-repository.
- `GitApiUnavailableError`: the built-in Git extension/API is unavailable or
  failed to initialize. The editor renders an operational error.
- Unknown errors: rethrow/preserve. Do not reinterpret them.

Waiting behavior:

- Waiting on `api.onDidOpenRepository`, `api.onDidChangeState`, or
  `repository.state.onDidChange` must be tied to an operation/lifecycle that was
  already started, such as Git API activation, `api.openRepository(rootUri)`, or
  the Git extension's first repository status run.
- For waits around an event-triggering operation, use the one-shot
  register-trigger-check pattern:
  1. Register the listener and panel-disposal rejection first.
  2. Trigger the operation, such as `api.openRepository(rootUri)`.
  3. Check the condition again in case the operation completed before the event
     callback ran.
  4. Resolve or reject exactly once, disposing all listeners in that single
     finish path.
- If `api.openRepository(rootUri)` returns no repository and the Git API gives
  no later concrete event to wait on for that root, throw
  `RepositoryUnavailableError` inside the acquisition helper. Do not pass the
  nullable result upward.
- If no dependent operation or documented event can make progress, fail with a
  specific error. Do not wait indefinitely.
- If the panel is disposed while waiting, reject with `EditorDisposedError` and
  dispose listeners. Do not resolve with a sentinel.
- Promise-returning acquisition helpers must either deliver the object named in
  their return type or reject. Disposal, not-in-repository, and unavailable
  repository states are rejection paths.

Repository acquisition has two phases:

1. **Repository object acquisition:** wait for the Git API to expose/open the
   `GitApiRepository` object.
2. **Repository status readiness:** await the Git API repository's concrete
   `repository.status()` operation before constructing `ReadyRepository`. VS
   Code fires `onDidOpenRepository` before the initial status data is populated;
   awaiting `status()` is the Git API-supported operation that produces the
   populated `mergeChanges`/state snapshot Weld needs.

Do not replace this status-readiness gate with raw Git checks. The Git API is the
source of truth for which merge-change candidates exist once its status run has
completed.

### ReadyRepository

Add a `ReadyRepository` wrapper near the Git acquisition helpers. It should be
the only repository type returned by startup acquisition code.

Sketch:

```ts
class ReadyRepository {
  private constructor(readonly repository: GitApiRepository) {}

  static fromFirstStatusComplete(repository: GitApiRepository): ReadyRepository {
    return new ReadyRepository(repository);
  }
}
```

The constructor should not be publicly callable. If TypeScript needs a different
shape, use an equivalent opaque wrapper; the important property is that callers
cannot manufacture one from any raw `GitApiRepository`.

`ReadyRepository.fromRepository()` should await `repository.status()` and then
construct the wrapper. That avoids a separate readiness map entirely: the
variable exists only after the dependent Git operation completed successfully.
There is no public or private `isRepositoryReady()` boolean equivalent in the
startup path.

### Submodule Repository

The submodule editor has a synthetic document URI containing
`SubmoduleConflictIdentity`, including the parent repository root.

Flow:

1. Await `getGitApiWhenInitialized()`.
2. Acquire the raw repository object for `identity.repositoryRoot` through
   `openRepositoryAtRoot()`, which wraps `api.getRepository()` and
   `api.openRepository()` without exposing nullable results.
3. If the Git API cannot open or later report the repository for that exact
   root, throw `RepositoryUnavailableError`.
4. Await `repository.status()` before returning `ReadyRepository`. This is the
   concrete Git API operation that populates `mergeChanges`.
5. Return `ReadyRepository`.

The returned `ReadyRepository` is fully initialized from the editor provider's
perspective: the Git API exists, the parent repository object exists, and its
first status state has run. Conflict availability is checked separately by
`SubmoduleConflict.load()`.

### Text Conflict Repository

The text editor starts from a real document URI.

Flow:

1. Await `getGitApiWhenInitialized()`.
2. Call `repositoryRootForDocument(api, documentUri)`. It uses the Git API's
   supported root-resolution path and throws `NotInRepositoryError` if no root
   can be determined.
3. Do not add a local shell fallback; local `git rev-parse` is wrong for
   `vscode-remote` and would introduce a second source of repository ownership.
4. Acquire the raw repository object for that root through
   `openRepositoryAtRoot()`, which wraps `api.getRepository()` and
   `api.openRepository()` without exposing nullable results.
5. If the Git API cannot open or later report the repository for that exact
   root, throw `RepositoryUnavailableError`.
6. Await `repository.status()` before returning. This is the concrete Git API
   operation that populates merge and index state.
7. Return `createConflictedItemFromUri(readyRepository.repository,
   document.uri)`.

This avoids using `workspace.getWorkspaceFolder()` as proof. A document can be in
a Git repo outside the current workspace, and a workspace folder can also contain
no Git repo.

For stale restored tabs, rely on the Git API result rather than speculative file
checks. If the Git API cannot resolve/open the repository root, report
`RepositoryUnavailableError`. If it resolves a repository but the document is no
longer a conflict, existing conflict-stage loading should report the appropriate
operational/domain error.

## Waiting Ownership

Do not add a general pending-request class unless implementation proves real
duplication. Use local closures that own all of their inputs up front:

- the target URI/root,
- the `WebviewPanel`,
- the `Disposable[]` for listeners,
- a one-shot `finish` function that resolves or rejects and disposes listeners.

This keeps the lifecycle local and obvious. The real editor/session object is
still created only after repository acquisition succeeds.

## Submodule Editor Refactor

Current smell:

- `repoReady` is an editor-local boolean.
- `_readyRepos` is a global map of whether Weld happened to observe a refresh,
  not whether the Git API has a repository object.

Target flow:

1. `resolveCustomEditor()` sets the normal submodule webview shell immediately.
   This preserves the React loading state.
2. The provider listens for the webview `ready` message.
3. On `ready`, start `postSnapshotWhenRepositoryAvailable(document, panel)`.
4. That function awaits the initialized Git API and `ReadyRepository`
   acquisition.
5. Once it has a `ReadyRepository`, call
   `SubmoduleConflict.load(readyRepository.repository, submoduleUri)`.
6. If it succeeds, post `snapshot`.
7. If it throws `SubmoduleConflictUnavailableError`, post `conflictLost`.
8. If it throws another error, post `error`.

There is no `repoReady` boolean. The repository is ready because the acquisition
helper returned a `ReadyRepository`.

Submodule conflict availability should start from `repository.state.mergeChanges`
after the repository status-readiness gate. Empty `mergeChanges` before that
gate is transient startup state; empty `mergeChanges` after that gate is a real
Git API result.

Raw Git must not be used as a defensive fallback for missing merge metadata. It
is allowed only for submodule gitlink capabilities the VS Code Git API does not
provide after it has already identified the merge-change candidate:

- validating that the candidate conflict is mode `160000` rather than a text
  conflict with the same Git status,
- reading gitlink stage commit SHAs,
- staging or restoring gitlink index entries.

Repository/state-change events remain useful after initial load:

- Keep listening for repository state changes for live refreshes.
- A state event should trigger a new snapshot read if the webview has completed
  its initial ready handshake.
- This is a refresh trigger, not a readiness truth source.

## Text Meld Editor Refactor

The text editor has the hardest ready-message ordering.

Target flow:

1. `resolveCustomTextEditor()` validates unsupported schemes immediately.
2. Set either:
   - the real webview shell only after `_initializeWebview()` has registered its
     message listener, or
   - a scriptless loading placeholder while waiting for the repository.
3. Do not leave the tab blank while waiting.
4. Acquire the initialized Git API and repository for the document.
5. If the document is known not to be in a repository, set terminal
   not-in-repository HTML.
6. Once a `ConflictedItem` exists, call a helper that performs the existing
   conflict-shape handling and then `_initializeWebview()`.

Recommended minimum-change path:

- Use a scriptless loading placeholder while waiting:

```html
<!doctype html>
<html>
  <body>Loading...</body>
</html>
```

- Because there is no script, no webview `ready` message can fire before
  `_initializeWebview()` installs its real listener.
- Once the repository and `ConflictedItem` are available, call
  `_resolveWithItem()`.
- `_initializeWebview()` remains the only method that sets the script-bearing
  HTML and owns the `ready` message listener.

Avoid changing tests to accept blank HTML. Blank HTML is not the requested
loading behavior.

## Remove `_readyRepos`

The current `_readyRepos` map is not a reliable readiness source and should be
removed from startup decisions:

- It is populated by Weld's debounced refresh path, not by Git API registration.
- It can lag behind a repository that is already usable.
- It can become stale on repository close unless explicitly cleared.

Replace it with construction-time readiness:

- Acquire/open the repository through the Git API.
- Await `repository.status()` inside `ReadyRepository.fromRepository()`.
- Do not export a registry or a boolean readiness check.
- Keep a shared repository state event if useful, but treat it only as a refresh
  signal.

## URI Containment

Avoid raw `fsPath` prefix checks for cross-platform and remote correctness.

Preferred:

- Compare repository identity by exact `repo.rootUri.toString()` when the
  expected root is already known.
- For document-to-repo containment, use Git API root resolution where possible.
- If a fallback containment helper is necessary, compare normalized URI strings
  including scheme and authority, and account for trailing slashes.

Do not use:

```ts
file.fsPath.startsWith(`${root.fsPath}/`)
```

That is fragile on Windows and remote URIs.

## Test Plan

Keep the integration tests from `test/vscode/suite/git_initialization_race.test.ts`
strict:

- Git API initialization helper:
  - Already initialized Git API returns immediately.
  - Uninitialized Git API waits for `api.onDidChangeState("initialized")` and
    then returns.
  - Disabled Git extension throws `GitApiUnavailableError` immediately. It must
    not wait for enablement.
  - Failed Git activation or `getAPI(1)` errors are preserved with context and
    are not converted into repository/domain absence.

- Ready repository acquisition helper:
  - Already initialized/open repositories are acquired through the same helper;
    there is no separate editor-side fast path.
  - `ReadyRepository.fromRepository()` awaits `repository.status()` before the
    wrapper is constructed.
  - Closed repositories cannot satisfy a later restored editor because no
    readiness registry is retained; each acquisition asks the current Git API
    for the current repository object.
  - Panel disposal while waiting rejects `EditorDisposedError` and disposes all
    listeners.

- Submodule delayed repository registration:
  - Normal webview shell is installed.
  - No terminal `error` or `conflictLost`.
  - Snapshot arrives after Git exposes the repository.

- Submodule delayed merge metadata:
  - Normal webview shell is installed.
  - No terminal `error` or `conflictLost` before metadata appears.
  - Snapshot arrives after state is available.

- Submodule already initialized:
  - Snapshot arrives after webview `ready` without needing an extra Weld refresh
    event.

- Text delayed repository registration:
  - Loading UI is visible immediately.
  - No terminal not-in-repository HTML during the startup window.
  - Real webview shell and `loadDiff` arrive after repository acquisition.

- Text already initialized:
  - `loadDiff` arrives after webview `ready` without needing an extra repository
    event.

- Stale restored submodule tab after repository deletion:
  - Construct a submodule conflict document URI for a real fixture.
  - Delete the fixture repository before the webview asks for state.
  - Resolve the custom editor and send `ready`.
  - Assert the normal shell or loading UI is shown first.
  - Assert the webview receives an operational `error` message explaining that
    the repository is unavailable/deleted.
  - Assert no `conflictLost` message is sent, because this is not a resolved
    conflict; it is missing repository state.

- Stale restored text-conflict tab after repository deletion:
  - Open/construct the document for a conflicted file fixture.
  - Delete the repository before the custom editor requests Git state.
  - Resolve the text custom editor.
  - Assert loading UI is visible while acquisition starts.
  - Assert the final state is a terminal operational error, not
    not-in-repository HTML caused by a transient Git API miss and not a blank
    tab.

Also keep existing terminal cases:

- Unsupported URI scheme still returns terminal unsupported-scheme HTML.
- A document known not to be in Git still returns terminal not-in-repository
  HTML.
- Operational errors remain operational errors, not `conflictLost`.

## Implementation Order

1. Add `getGitApiWhenInitialized()` and its small wait helpers.
2. Add submodule repository acquisition by root URI.
3. Refactor `SubmoduleConflictEditorProvider` initial snapshot path to use
   repository acquisition instead of `repoReady`.
4. Add text document repository acquisition and terminal not-in-repository
   classification.
5. Refactor `MeldCustomEditorProvider` to show a scriptless loading placeholder
   while repository acquisition is pending.
6. Remove `_readyRepos` from initial editor readiness decisions.
7. Fix or remove stale readiness map behavior.
8. Add or update the Git API initialization cache reset/testability seam.
9. Run `npx tsc --noEmit`.
10. Run `npm run test:vscode`.
11. Run broader pre-checkin after the targeted suite passes.

## Completion Gates

This refactor is not complete until all of these are true:

- The new readiness/acquisition functions and their important local state have
  comments explaining intent, not merely mechanics. The comments should make the
  lifecycle contract clear to a future reader: what condition the code is
  protecting, why a wait is legitimate, what event makes progress possible, and
  what is considered terminal.
- Comments must be placed where the intent would otherwise be easy to lose:
  function definitions, state variables, and any branch that distinguishes
  "not ready yet" from "known terminal error."
- The comments must not restate obvious code operations. Prefer "why this state
  exists" over "sets the flag to true."
- There must be no silent catch-all error handling. Every `catch` introduced or
  touched by this refactor must either handle a specific known error type or
  rethrow/preserve the original error. Unknown errors must never be converted
  into `null`, `undefined`, loading, not-in-repository, conflict-lost, empty
  state, or any other non-error result.
- `npm run pre-checkin` must pass. Running only `tsc` or the focused VS Code
  suite is not enough for completion.

## Non-Goals

- Do not add timeouts.
- Do not make the editor providers poll.
- Do not wait indefinitely for unspecified future state. Wait only for the
  result of a concrete dependent operation.
- Do not create partially initialized editor sessions.
- Do not convert operational Git errors into valid-looking empty state.
- Do not catch unknown errors and silently reinterpret them as domain absence.
- Do not change tests to accept blank tabs as loading.
