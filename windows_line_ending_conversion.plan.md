# Plan: Windows Line-Ending Conversion for Conflict Stages

## Intent

On Windows (with git's default `core.autocrlf=true`), opening a conflicted
file shows the entire file as a single conflict, and auto-merge never
applies. The editor must produce the same diffs on Windows as on Linux,
preserve the file's line endings on save, and keep the auto-merge
reproducibility check working byte-for-byte.

## Diagnosis

Stage content from `repository.show(":<stage>", fsPath)` is the raw index
blob — git applies no worktree conversion, so it is (normally) LF. The
conflicted file on disk was written by git's checkout machinery **with**
conversion (`core.autocrlf`, `.gitattributes` `text`/`eol`, smudge
filters), so on Windows it is CRLF. Three breakages:

1. **Whole-file conflict.** `_buildSnapshotFromCurrentDocument`
   (`src/webview/meldWebviewPanel.ts:605`) passes the live document text
   (CRLF) as `workingContent` to `buildDiffPayload`
   (`src/webview/diffPayload.ts:230`). Lines are split on `"\n"`, so every
   working line keeps a trailing `\r` while stage lines do not; no line is
   ever equal and the Differ reports one conflict spanning the file.
2. **Auto-merge never applies.** `buildInitialConflictedState`
   (`src/webview/diffPayload.ts:166`) reproduces the conflicted text with
   `git merge-file` over LF stage content and compares byte-for-byte
   against the CRLF file (`_maybeApplyAutoMerge`,
   `src/webview/meldWebviewPanel.ts:669`). LF output never matches a CRLF
   file, so the editor always concludes the user hand-edited the file.
3. **EOL flip on write.** Merged-pane content derived from LF stage text
   and written into the document would silently rewrite a CRLF file as LF
   on save.

## Chosen Approach: Fetch Stages With Git's Own Conversion

Fetch stage contents with

```
git cat-file --filters :<stage>:<repo-relative-path>
```

run from the repository root via the existing `execGit` helper
(`src/gitUtils.ts:150`). `--filters` applies exactly the checkout-direction
conversion that produced the worktree file. After this, all four texts
(three stages + the working document) share the worktree convention
byte-for-byte, and everything downstream — the Differ, `runMerge`,
`git merge-file` (whose conflict markers match the EOL style of its inputs,
git ≥ 2.8), the reproducibility byte-compare, document writes, and the
per-keystroke edit sync — is consistent with **no conversion layer and no
new invariants**. Only cold per-file-open code changes; the hot
`editorSync` path is untouched.

**Rejected alternative (owner decision, 2026-08-29):** an LF-canonical
internal model with EOL conversion at the `TextDocument` boundary. It keeps
core reads on the VS Code Git API, but instruments the per-keystroke edit
sync and creates a permanent unenforced invariant ("model is LF, document
is native EOL") across every `getText()`/`applyEdit` site — a distributed
version of the very bug class being fixed. Roughly 2–3× the effort with
higher maintenance risk.

**Rejected alternative:** reimplementing git's conversion decision logic
(autocrlf/gitattributes resolution) in TypeScript. Reinvents the wheel and
drifts from git's behavior.

## Raw-Git Policy Note (read before implementing)

Core features normally use the VS Code Git API; raw git is an isolated
exception list (`implementation_reference.md`, README "Known Limitations",
`TODO.md` ~line 130). This plan **deliberately adds stage-content reads to
that list** — an owner decision trading policy purity for a much smaller,
lower-risk change. Two obligations follow:

1. **The fallback discriminates error classes — never catch-all.**
   `execGit` rejects with the original `execFile` error as `cause`. Spawn
   failure (git binary unlaunchable) carries a **string** syscall code
   (`cause.code === "ENOENT"`/`"EACCES"`); a git-level failure (bad path,
   missing stage, dead repo, filter error) exits non-zero with a
   **numeric** code and stderr. Fall back to `repository.show` **only** on
   the syscall class; rethrow everything else unmodified so callers keep
   git's stderr (Preserve Error Semantics / never discard exception
   values). A git-level failure must never reach the fallback — that would
   silently reintroduce the CRLF bug under a real error.
2. **Why the syscall-class fallback is correct, not degraded.** An
   environment that cannot spawn git never ran a checkout smudge, so raw
   blobs from `repository.show` ARE the worktree form there. (A machine
   where git breaks mid-session also kills `vscode.git` and the existing
   `merge-file` spawn, so the extension is inoperable regardless.) Record
   this equivalence where step 5 says, so future browser work knows this
   primitive is the single seam.

## Implementation Steps

### 1. One fetch primitive (One Way To Do Things)

Add a single function to `src/gitUtils.ts`, e.g.:

```ts
async function readIndexStageContent(
	repository: GitApiRepository, // carries rootUri; also the fallback target
	file: Uri,
	stage: number,
): Promise<string>
```

- Compute the repo-relative path with `path.relative(repoRoot.fsPath,
  file.fsPath)` and convert `\` to `/` (git object-name syntax requires
  forward slashes).
- Call `execGit(["cat-file", "--filters", `:${stage}:${rel}`],
  repoRoot.fsPath)`. `execGit` already resolves stdout untrimmed and has
  `MAX_BUFFER_SIZE`; do not trim.
- Catch the rejection and inspect `error.cause.code`: if it is a string
  syscall code (`"ENOENT"`, `"EACCES"` — git unlaunchable), fall back to
  `await repository.show(...)` (correct in that environment, see the
  policy note); otherwise rethrow the original error unmodified. A missing
  stage is a numeric-exit git failure and rejects with git's stderr;
  callers keep their existing handling (see step 2). This narrow branch is
  the entire fallback — no retries, no other conditions.

### 2. Replace the stage-content call sites

Keep each site's existing error semantics; only the fetch changes:

- `src/webview/diffPayload.ts:61` (`getGitState`) — delete the local
  helper, call the new primitive. `ConflictedItem` carries `rootUri`.
- `src/extension.ts:354` (`getGitFileContent`) — keep the wrapping "Is it
  in conflict?" error, swap the fetch. The remote smoke-test bridge at
  `src/extension.ts:1098` flows through automatically.
- `src/gitUtils.ts:206` (`getStageDebugLine`) — swap the fetch so debug
  output reports the same bytes the editor uses.
- `src/repoContext.ts:467` (`readConflictStage`) — **leave on
  `repository.show`**: it only tests stage presence for conflict-status
  classification and never surfaces content; converting it buys nothing
  and its catch → `null` (expected absence) semantics stay untouched.

Gitlink stages in `src/submoduleConflict.ts` use `rev-parse` and are
unaffected (gitlinks have no blob content to filter).

### 3. Fix the two synthesized-line sites (audit already done)

Real lines split from converted content carry their own `\r` and rejoin
correctly; the audit found exactly two places that *synthesize* lines from
string literals, which would become LF lines amid CRLF content:

- `src/matchers/merge.ts:491` — `mergedtext.push("(??)")`, the
  empty-base-region conflict placeholder. (The common case at line 485
  prefixes `(??)` onto a real line that keeps its `\r` — already correct.)
- `src/matchers/gitTextMerger.ts:119–128` — the four bare conflict-marker
  literals (`"<<<<<<< HEAD"` etc.). This is production code: the
  "auto-merge all" flow (`performAutoMerge`, `src/extension.ts:575`)
  writes its output into documents.

Add **one** shared helper (e.g. in `src/matchers/diffutil.ts` beside the
other shared matcher utilities): derive the line terminator once from the
input line arrays (a line ending in `\r` ⇒ synthesized lines get `\r`
too), and have both sites append it. Comment the helper with why it
exists: split-on-`"\n"` lines own their `\r`, so only literal lines need
one. Do **not** add `\r`-stripping anywhere; the invariant is "all text
is in worktree form", not "some layers normalize".

### 3b. In-code intent documentation (required, matches house style)

- `readIndexStageContent` gets a docstring stating: why `--filters` (the
  API's `show` returns raw index blobs, but diffs/compares run against the
  smudged worktree file — this is the Windows CRLF fix); the exact
  fallback trigger (string syscall `cause.code` only) and why the fallback
  is *correct* there (no spawnable git ⇒ no checkout smudge ever ran ⇒ raw
  blobs are the worktree form); and why numeric git failures rethrow
  unmodified.
- `readConflictStage` in `src/repoContext.ts` gets a one-paragraph comment
  distinguishing it from the primitive: it is a stage **presence probe**
  (content discarded, null = expected absence, runs per tree refresh), so
  it stays on `repository.show` deliberately — do not "unify" it into the
  spawn path.

### 4. Update tests that stub `repository.show`

Grep `test/` (including `test/mockVscode.ts`) for mocks feeding stage
content through `repository.show`. Those paths now go through `execGit`;
prefer pointing them at a real temp-repo fixture over mocking `execGit`
(mocking the primitive would reimplement git's conversion in test code —
see testing guidelines on mocking).

### 5. Update the policy docs (part of this change, not optional)

- README "Known Limitations": add stage-content reads to the list of
  operations that run `git` directly.
- `TODO.md` (~line 130): add stage reads to the spawn list and record the
  degradation equivalence from the policy note above (no git binary ⇒ no
  smudge ⇒ `repository.show` raw blobs are the worktree form; the single
  seam is `readIndexStageContent`).
- `implementation_reference.md`: update the "Raw Git is isolated to
  submoduleConflict.ts" sentence to name the new read-only exception and
  its justification (the Git API has no filtered-read call).

## Testing (runs on Linux — no Windows machine required)

Force git's conversion path in a temp repo instead of relying on the OS:
setting `core.autocrlf=true` (or `.gitattributes` `* text eol=crlf`) in the
fixture makes git check out CRLF on Linux, exercising the identical smudge
path Windows hits. Reuse `test/runGit.ts` and the fixture patterns in
`test/vscode/suite/helpers.ts` (`makeRepo` + `makeConflict`); add a variant
that sets the CRLF config before creating the conflict.

Intent-level assertions (not implementation echoes):

1. **Stage fetch matches worktree convention.** For the CRLF fixture, the
   primitive's output for `:2:` equals the bytes git itself puts in the
   worktree for that side (check out the branch in a scratch clone and
   compare), not merely "contains `\r\n`".
2. **Parity invariant.** Build the payload for the CRLF fixture with
   `workingContent` set to the actual on-disk conflicted text, and for an
   otherwise-identical LF fixture. Diff chunk lists must be identical and
   pane contents equal modulo `\r`. (This is the bug: today the CRLF repo
   yields one whole-file conflict.)
3. **Auto-merge reproducibility.** `buildInitialConflictedState` output
   byte-equals the conflicted file git wrote to disk in the CRLF fixture —
   the exact comparison `_maybeApplyAutoMerge` performs.
4. **EOLs survive the round trip.** After auto-merge replacement, the
   document (and the saved file) contains uniformly CRLF endings in the
   CRLF fixture and uniformly LF in the LF fixture. Use a fixture whose
   conflict is NOT fully auto-resolvable, so the output contains
   synthesized lines (`(??)` placeholders / `merge3FilesGit` markers) —
   that is the only way this test catches a missed terminator at the
   step-3 sites, alongside the wholesale EOL-flip failure mode.

Write tests 2–4 first and confirm they fail on current `main` before
changing the fetch; that proves they detect the defect rather than the
implementation.

Finish with `npm run build` and `npm run pre-checkin` (both must pass).

## Known Scope Limits (note, don't handle)

- Files with a `working-tree-encoding` attribute (e.g. UTF-16) are smudged
  to that encoding and then decoded as UTF-8 by `execGit` — mangled. The
  old raw-blob path mishandled these differently (readable text that
  mismatched disk bytes). Rare; out of scope — do not add a decode
  fallback.
- Smudge filters (e.g. LFS) now run on stage fetch. That is *correct* — it
  matches what checkout produces — but is slower for filter-tracked files.
- `git cat-file --filters` requires git ≥ 2.11 (Nov 2016); no guard
  needed.
- Perf: three parallel spawns per file open (tens of ms), the same class
  of cost as the existing per-open `git merge-file` spawn. Nothing
  per-edit.
