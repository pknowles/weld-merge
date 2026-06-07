# Testing Makeover Plan

This checklist turns `mutant_testing_audit.md` into an execution plan. Work from
top to bottom unless a later mutation run proves the order is wrong. Each step
must leave the test suite more behavior-focused than it found it.

## Rules For Every Step

- [x] Read `.agents/workflows/testing-guidelines.md` before changing tests.
- [ ] Identify the intended behavior before writing or changing assertions.
- [ ] Prefer real project code and real domain data over copied logic in tests.
- [ ] Assert observable outcomes: final content, exact ranges, exact messages,
      exact commands, exact errors, or stable semantic invariants.
- [ ] Do not add tests that only prove the current implementation shape.
- [ ] For each new test group, include at least one negative case that would
      fail if the important behavior were wrong.
- [ ] Run the narrowest relevant test command before moving to the next area.
- [ ] Run targeted Stryker for the touched file or subsystem before marking the
      area complete.
- [ ] Update `implementation_reference.md` when tests document a new workflow,
      boundary, fixture, or architecture-relevant behavior.

## Phase 0: Baseline And Tooling Hygiene

- [x] Keep `src/` production-only so Stryker mutation targets do not include
      test files.
      Verified on 2026-05-31 with `rg --files src -g '*.test.ts' -g
      '*.test.tsx'`: no matches.
- [x] Decide whether tests currently under `src/` should stay there or move
      under `test/`. If they move, update imports and Jest discovery as needed.
      Decision: move them under `test/webview/` so `src/` contains production
      code only.
- [x] Run `npx jest --runInBand` and record whether the baseline passes.
      Baseline on 2026-05-31 after moving tests: passed, 32 suites and 274
      tests.
- [x] Run `npx stryker run` after the test-file exclusion and save the new
      mutation summary as the real starting point.
      Baseline on 2026-05-31: 41.89% mutation score, 1894 killed, 158 timed
      out, 1598 survived, 1248 no coverage, 2267 errors. The command exited
      with code 1 because the configured break threshold is 65%.
- [x] Create a lightweight mutation triage table from the new report with:
      file, killed, survived, no coverage, suspected cause, owner step.
- [x] Mark each surviving mutant class as one of:
      `bad data`, `weak assertion`, `missing behavior`, `equivalent mutant`,
      or `production smell`.
- [x] Audit every generated test/tool output path before consolidating output
      directories. Include at least Jest coverage, Stryker temp sandboxes,
      Stryker reports, Playwright `test-results`, benchmarking results,
      VS Code test downloads/workspaces, fuzz corpora/crashes, trace files, and
      root-level perf logs.
- [x] Consolidate configurable generated outputs under one visible repo-root
      directory named `test-output/`. Do not use a hidden dot directory for this
      output root; it should be obvious when test tooling creates files.
- [x] Update `.gitignore`, Jest ignore paths, Stryker config, Playwright config,
      benchmark config/scripts, and any test runner wrappers so generated test
      output lands under `test-output/` where the tool supports it.
- [ ] Remove legacy ignore entries for old output roots after the existing local
      generated artifacts are cleared: `coverage/`, `.stryker-tmp/`,
      `reports/`, `test-results/`, and `test/benchmarking/results/`.
- [x] Document any output that cannot safely move under `test-output/`, with
      the owning tool and reason.
- [x] Add a thin guarded Stryker runner, preferably
      `scripts/run_stryker_guarded.ts`, that runs mutation testing in the
      active checkout while keeping Stryker's generated files under
      `test-output/`.
- [x] Add Git safety guards to the Stryker runner:
      - fail before mutation when `git ls-files -u` reports unmerged paths
      - fail before mutation when the active checkout has unresolved submodule
        conflicts
      - record `git status --porcelain=v1` before mutation starts
      - run Stryker in place without creating a copied checkout or worktree
      - check `git ls-files -u` after mutation and fail loudly if new conflicts
        appeared
      - compare post-run tracked-file status against the pre-run snapshot and
        fail loudly if mutation testing dirtied tracked files outside expected
        report/config paths
- [x] Harden Git-mutating tests and helpers so they can only run mutating Git
      commands inside temp fixtures. Helpers that create conflicts, submodules,
      or index stages should validate that their target path is under `tmpdir()`
      or another explicitly approved test fixture root before running `git
      merge`, `git checkout`, `git rm`, or `git update-index`.
- [x] Update `package.json` so `npm run test:mutate` uses the guarded Stryker
      runner instead of invoking Stryker directly.
- [x] Do not rerun full Stryker only to move existing reports into
      `test-output/`. The 2026-05-31 baseline is sufficient for choosing the
      next test work; rerun full mutation only after behavior tests or mutation
      configuration have materially changed.

### Output Directory Audit

| Tool/output | New location | Status |
| --- | --- | --- |
| Jest coverage | `test-output/jest/coverage/` | configured |
| Stryker temp checkout | `test-output/stryker/tmp/` | configured |
| Stryker reports | `test-output/stryker/reports/` | configured |
| Stryker incremental data | `test-output/stryker/stryker-incremental.json` | configured |
| Playwright e2e artifacts | `test-output/playwright/e2e-results/` | configured |
| Benchmark Playwright artifacts | `test-output/playwright/benchmark-results/` | configured |
| Benchmark metrics/profiles/database | `test-output/benchmarking/results/` | configured |
| Root-level benchmark perf logs | no future root writes expected | fixed by benchmark config |
| VS Code test workspaces/user data | OS temp dir | already self-cleaning |
| VS Code download cache | `.vscode-test/` | exception: owned by `@vscode/test-electron` cache behavior |
| Fuzz seed corpora | `test/fuzz/**/corpus/` | exception: generated seed inputs live beside fuzz targets |
| Fuzz crash/slow/oom artifacts | `test/fuzz/**/{crash,timeout,slow-unit,oom}-*` | exception: produced by Jazzer next to fuzz targets |
| Legacy local outputs | old ignored roots | cleanup pending; do not create new output there |

### Corrected Mutation Baseline

| File | Score | Killed | Survived | No coverage | Errors | Suspected cause | Owner step |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `src/matchers/diffutil.ts` | 36.16% | 192 | 203 | 136 | 308 | weak assertion, bad data | Phase 2 |
| `src/webview/meldWebviewPanel.ts` | 0.00% | 0 | 0 | 293 | 133 | missing behavior | Phase 1 |
| `src/webview/ui/CodePane.tsx` | 31.28% | 127 | 207 | 72 | 160 | weak assertion, missing behavior | Phase 3 |
| `src/webview/ui/appHooks.ts` | 27.80% | 72 | 133 | 54 | 141 | weak assertion, missing behavior | Phase 3 |
| `src/matchers/myers.ts` | 59.91% | 266 | 139 | 39 | 164 | weak assertion, bad data | Phase 2 |
| `src/submoduleConflict.ts` | 59.36% | 241 | 100 | 65 | 106 | weak assertion, missing failure paths | Phase 5 |
| `src/webview/submoduleUi/GitGraph.tsx` | 42.92% | 103 | 94 | 43 | 125 | weak assertion | Phase 5 |
| `src/webview/ui/useSynchronizedScrolling.ts` | 6.47% | 9 | 114 | 16 | 43 | weak assertion, bad data | Phase 3 |
| `src/repoContext.ts` | 28.82% | 49 | 41 | 80 | 124 | missing behavior | Phase 1 |
| `src/treeView.ts` | 0.82% | 1 | 10 | 111 | 48 | missing behavior | Phase 1 |
| `src/gitUtils.ts` | 14.89% | 21 | 31 | 89 | 52 | missing behavior | Phase 1 |
| `src/webview/submoduleUi/SubmoduleApp.tsx` | 48.57% | 85 | 54 | 36 | 87 | weak assertion, missing states | Phase 5 |
| `src/matchers/merge.ts` | 69.34% | 190 | 74 | 10 | 151 | weak assertion, bad data | Phase 2 |
| `src/webview/diffPayload.ts` | 0.00% | 0 | 0 | 73 | 57 | missing behavior | Phase 1 |
| `src/webview/ui/DiffCurtain.tsx` | 67.27% | 148 | 42 | 30 | 81 | weak assertion | Phase 3 |
| `src/webview/ui/meldPane.tsx` | 60.25% | 97 | 62 | 2 | 66 | weak assertion | Phase 4 |
| `src/webview/ui/App.tsx` | 42.86% | 42 | 50 | 6 | 36 | weak assertion, missing states | Phase 4 |
| `src/webview/submoduleConflictEditor.ts` | 53.91% | 62 | 33 | 20 | 26 | missing failure paths | Phase 5 |

Done when Stryker no longer mutates test files and the plan uses the corrected
mutation baseline.

## Phase 1: Extension Host And Git Boundaries

Target files:
- `src/webview/meldWebviewPanel.ts`
- `src/webview/diffPayload.ts`
- `src/treeView.ts`
- `src/gitUtils.ts`
- `src/repoContext.ts`

### Intended Behaviors

- [ ] Webviews receive one authoritative initial payload after `ready`.
- [ ] Host errors are shown as structured error payloads, not silent empty
      states.
- [ ] Git conflict stages are read accurately for both-modified, both-added,
      delete/modify, and lost-conflict states.
- [ ] Resolved files from `MERGE_MSG` are parsed without treating malformed
      text as valid conflicts.
- [ ] Operational Git or filesystem failures remain failures with useful
      messages.

### Work Checklist

- [x] Add or strengthen `diffPayload` tests for normal both-modified conflicts.
- [x] Add `diffPayload` tests for both-added conflicts where base is absent.
- [ ] Add `diffPayload` tests for diff3 labels and normal conflict labels.
- [ ] Assert auto-merge replacement only happens when `git merge-file -p`
      output exactly matches the working file.
- [x] Assert payload file order, labels, line arrays, diff arrays, and commit
      metadata exactly.
- [ ] Add `meldWebviewPanel` message protocol tests for `ready`.
- [ ] Add message protocol tests for webview edits, save, base diff,
      clipboard read/write, and conflict-lost refresh.
- [ ] Assert exact outbound `postMessage` command names and payload shapes.
- [ ] Add tests where the ready callback throws and verify the webview receives
      the structured error title and message.
- [x] Add `treeView` parser tests for valid `MERGE_MSG` conflict blocks.
- [x] Add `treeView` parser tests for malformed indentation, missing headers,
      duplicate paths, and non-comment termination lines.
- [ ] Add tree item tests for Git API mismatch: repository is mid-conflict but
      merge changes are empty.
- [ ] Add tree item tests where reading `MERGE_MSG` throws and verify an
      `ErrorTreeItem`, not an empty list.
- [x] Add `gitUtils` tests for normal `.git` directories and gitdir pointer
      files with relative paths.
- [x] Add `gitUtils` tests for conflict state detection across merge, rebase,
      cherry-pick, and no-operation states.
- [ ] Add `repoContext` tests for unsupported schemes, unavailable Git API,
      repository close during acquisition, and panel disposal during
      acquisition.

### Verification

- [ ] Run `npx jest test/meld_webview_ready.test.ts --runInBand`.
- [ ] Run the relevant VS Code host suite if host behavior changed:
      `npm run test:vscode`.
- [ ] Run targeted Stryker for each touched host/Git file.
- [ ] Confirm no new test mocks duplicate non-trivial Git parsing logic.

Done when no high-risk host/Git boundary remains at zero practical coverage and
surviving mutants mostly represent equivalent mutants or accepted TODOs.

## Phase 2: Core Diff, Merge, And Highlight Behavior

Target files:
- `src/matchers/diffutil.ts`
- `src/matchers/myers.ts`
- `src/matchers/merge.ts`
- `src/matchers/gitTextMerger.ts`
- `src/webview/ui/highlightUtil.ts`

### Intended Behaviors

- [ ] Diff opcodes transform source content into target content.
- [ ] Equal inputs produce equal-only changes.
- [ ] Local and remote making the same change does not create a conflict.
- [ ] Blank-line trimming preserves meaningful content and removes only the
      intended leading/trailing blank runs.
- [ ] Inline highlights point to the exact changed character ranges in Monaco
      one-based coordinates.

### Fixture Matrix

For each applicable algorithm, add curated examples covering:

- [x] Identical files.
- [x] Insert at start, middle, and end.
- [x] Delete at start, middle, and end.
- [x] Replace with the same line count.
- [x] Replace with fewer lines.
- [x] Replace with more lines.
- [x] Delete every line.
- [x] Empty base with non-empty sides.
- [x] Repeated equal lines around changes.
- [ ] Leading blank lines.
- [ ] Trailing blank lines.
- [ ] Contiguous blank blocks inside a change.
- [ ] Conflict marker text as ordinary file content.
- [x] Local-only change.
- [x] Remote-only change.
- [x] Same local and remote change.
- [x] Overlapping incompatible local and remote changes.

### Work Checklist

- [ ] Add helper assertions that apply opcodes to source content and compare
      the reconstructed target.
- [x] Add exact opcode assertions for small stable examples.
- [x] Add merge result assertions for all same-change and conflict examples.
- [x] Add `consumeBlankLines` or public-behavior tests that kill blank-line
      boundary mutants without copying production trimming logic.
- [x] Strengthen Myers tests for prefix/suffix boundaries and overlapping
      repeated sequences.
- [ ] Strengthen sync-point matcher tests where sync points are at start, end,
      adjacent positions, and inside repeated blocks.
- [ ] Upgrade fuzz tests so they assert reconstruction, monotonicity, bounds,
      identity, and convergence invariants, not only "does not throw".
- [x] Add highlight tests for single-character insert, delete, and replace.
- [x] Add highlight tests for multi-line replacements and trailing newlines.
- [x] Assert exact `startLine`, `startColumn`, `endLine`, `endColumn`,
      `isWholeLine`, and `tag` for highlight fixtures.

### Verification

- [ ] Run `npx jest test/test_matchers.test.ts test/test_merge.test.ts --runInBand`.
- [ ] Run `npx jest test/highlightUtil.test.ts test/highlight_roundtrip.test.ts --runInBand`.
- [ ] Run fuzz tests if the touched behavior is fuzz-covered.
- [ ] Run targeted Stryker for each touched algorithm file.

Done when curated examples fail for plausible off-by-one, missing-blank-line,
and weak-conflict mutants.

## Phase 3: Scroll Mapping And Monaco Coordination

Target files:
- `src/webview/ui/scrollMapping.ts`
- `src/webview/ui/useSynchronizedScrolling.ts`
- `src/webview/ui/CodePane.tsx`
- `src/webview/ui/appHooks.ts`

### Intended Behaviors

- [ ] Scroll mapping is continuous, monotonic, bounded, and honors reversed
      diffs.
- [ ] Fractional source line positions map to stable fractional target line
      positions.
- [ ] Scroll synchronization preserves top, middle, and bottom viewport
      semantics across panes with different line counts and heights.
- [ ] Monaco clipboard and edit actions operate on exact selections or full
      lines as intended.

### Work Checklist

- [ ] Add `scrollMapping` fixtures for source shorter than target.
- [ ] Add `scrollMapping` fixtures for source longer than target.
- [ ] Add fixtures where the first chunk starts at line `0`.
- [ ] Add fixtures where the last chunk reaches `sourceMaxLines` or
      `targetMaxLines`.
- [ ] Add fixtures for gaps before, between, and after chunks.
- [ ] Add fixtures for zero-width insert and delete chunks.
- [ ] Add fixtures for reversed diffs and multi-hop five-pane mappings.
- [x] Assert exact mapped values at chunk starts, midpoints, ends, and just
      outside boundaries.
- [ ] Add fake Monaco editor tests with constant line heights.
- [ ] Add fake Monaco editor tests with variable line heights.
- [ ] Assert exact target scroll positions for top, middle, and bottom source
      scroll positions.
- [ ] Assert horizontal scroll sync copies only the intended scroll value.
- [ ] Assert the scroll lock prevents feedback loops.
- [ ] Test registered CodePane copy, cut, paste, and save actions through the
      action registration boundary.
- [ ] Assert exact clipboard text for empty selection and non-empty selection.
- [ ] Assert exact `executeEdits` ranges and final model content after cut and
      paste.
- [x] Add app hook navigation tests for previous/next conflict boundaries,
      missing conflicts, and wrap/no-wrap behavior if supported.

### Verification

- [ ] Run `npx jest test/webview/ui/scrollMapping.test.ts test/webview/ui/panesMapping.test.ts --runInBand`.
- [ ] Run `npx jest test/editorActions.test.ts test/mockEditor.test.ts --runInBand`.
- [ ] Run targeted Stryker for scroll and Monaco coordination files.

Done when arithmetic and boundary mutants in scroll synchronization are killed
by exact coordinate assertions.

## Phase 4: Main Webview App Behavior

Target files:
- `src/webview/ui/App.tsx`
- `src/webview/ui/meldPane.tsx`
- `src/webview/ui/mergedPaneEdits.ts`
- `src/webview/ui/editorActions.ts`
- `src/webview/ui/ErrorBoundary.tsx`
- `src/webview/ui/useClipboardOverrides.ts`

### Intended Behaviors

- [ ] App state changes match host messages.
- [ ] UI actions send the expected host protocol messages.
- [ ] Merged-pane edits preserve content and version semantics.
- [ ] Error boundaries render useful diagnostics instead of blank webviews.
- [ ] Clipboard behavior works both with the VS Code message bus and browser
      clipboard fallback.

### Work Checklist

- [ ] Add App protocol tests for `loadDiff`, `fullSync`, config updates, base
      compare updates, and conflict-lost updates.
- [ ] Assert the final visible/editor state after each host message.
- [ ] Assert exact outbound host messages for toolbar/config actions.
- [x] Add tests that compare final merged content after applying
      `mergedPaneEdits` changes.
- [x] Add tests for full replacement range generation on empty, one-line, and
      multi-line documents.
- [ ] Strengthen `editorActions` tests to assert both `executeEdits` ranges and
      final editor content.
- [ ] Add `ErrorBoundary` tests with a deliberately throwing child component.
- [ ] Assert fallback text includes the error message and useful diagnostic
      detail.
- [ ] Add `useClipboardOverrides` tests for VS Code clipboard requests and
      resolving request IDs.
- [ ] Add browser fallback clipboard tests with no VS Code API.
- [ ] Add a test for unknown clipboard request IDs so they do not resolve the
      wrong pending promise.

### Verification

- [ ] Run `npx jest test/webview_react.test.tsx test/editor_sync_webview.test.tsx --runInBand`.
- [ ] Run `npx jest test/editorActions.test.ts test/highlight_roundtrip.test.ts --runInBand`.
- [ ] Run targeted Stryker for touched webview app files.

Done when UI tests verify state transitions and protocol messages together,
instead of only checking that components mount.

## Phase 5: Submodule Resolver

Target files:
- `src/submoduleConflict.ts`
- `src/webview/submoduleConflictEditor.ts`
- `src/webview/submoduleUi/GitGraph.tsx`
- `src/webview/submoduleUi/SubmoduleApp.tsx`

### Intended Behaviors

- [ ] Submodule conflicts are identified from gitlink state, not text-conflict
      guesses.
- [ ] Expected conflict-loss states are distinct from operational failures.
- [ ] Staging and restoring submodule resolutions write the exact intended
      index entries.
- [ ] The graph preserves Git-provided order and renders visible topology
      faithfully.
- [ ] The UI distinguishes not-loaded file lists from loaded-empty file lists.

### Work Checklist

- [ ] Add `SubmoduleConflict.load` tests for malformed gitlink diff output.
- [ ] Add tests for missing submodule checkout errors.
- [ ] Add tests for malformed Git log output.
- [ ] Add tests where `git update-index` fails and the error propagates.
- [ ] Assert restore writes stage 1, 2, and 3 entries exactly.
- [ ] Add editor provider tests where `ready` posts one snapshot.
- [ ] Add rapid-refresh tests proving stale snapshots cannot overwrite newer
      snapshots.
- [ ] Add tests where `SubmoduleConflictUnavailableError` posts
      `conflictLost`.
- [ ] Add tests where operational errors post error payloads instead of
      `conflictLost`.
- [ ] Add `showFileDiff` tests for root commits using Git's empty tree.
- [ ] Add graph tests with exact path `d` assertions for a small known commit
      graph.
- [ ] Add graph tests for selected commit marker, role badges, ref badges,
      hidden merge parents, and earlier-history dashed paths.
- [ ] Add SubmoduleApp tests for search, file loading, loaded-empty file
      lists, stage command shape, and diff command shape.

### Verification

- [ ] Run `npx jest test/submoduleConflict.test.ts --runInBand`.
- [ ] Run `npx jest test/webview/submoduleUi/gitGraph.test.tsx test/webview/submoduleUi/submoduleApp.test.tsx --runInBand`.
- [ ] Run `npm run test:vscode` if VS Code host integration changed.
- [ ] Run targeted Stryker for touched submodule files.

Done when submodule tests kill failure-path, graph-coordinate, and
message-routing mutants.

## The Two-Environment Problem (Important Context)

The project has two completely separate test environments with no shared coverage
metrics today:

**Jest** (webview, matchers, pure functions):
- Mutation score from Stryker measures quality here.
- Covers: diffutil, myers, merge, highlightUtil, scrollMapping, appHooks,
  mergedPaneEdits, editorActions, diffPayload, useClipboardOverrides, etc.
- Does NOT run VS Code-coupled code at all.

**VS Code integration** (`npm run test:vscode`, Mocha inside extension host):
- ~4000 lines of tests in `test/vscode/suite/` exercising real Git repos,
  real document edits, real extension activation.
- Covers: resolveCustomTextEditor, conflict detection, delete/modify handling,
  pane contents, submodule conflicts, tree view, git utilities.
- Coverage is completely invisible — we do not know what `meldWebviewPanel.ts`,
  `repoContext.ts`, etc. actually exercise.

**Consequence:** Stryker mutation scores only measure half the codebase. The
93-NoCoverage mutants in `repoContext.ts` and 293 in `meldWebviewPanel.ts` are
not NoCoverage because nobody tests them — the VS Code tests do — but because
Stryker never sees the extension host process.

### Combined Coverage Tooling (status 2026-06-07)

`npm run coverage` (`scripts/collect_coverage.ts`) is the single entry point.
It runs in order:
1. Delete stale `test-output/jest/coverage/lcov.info`, run Jest with coverage,
   verify the file was produced.
2. Delete stale `test-output/coverage/vscode/lcov.info`, create a fresh temp dir
   under `test-output/coverage/vscode-raw-<random>/` via `mkdtempSync` for raw
   V8 JSON, run VS Code tests with `NODE_V8_COVERAGE` pointing there, run c8
   to emit LCOV to `test-output/coverage/vscode/lcov.info`, delete the raw dir.
3. Merge the two exact file paths via `mergeCoverageReportFiles` API into
   `test-output/coverage/combined/lcov.info`.
4. `ratchetJestCoverage()` — reads `test-output/jest/coverage/coverage-summary.json`, ratchets `jest.config.js`.
5. `ratchetCombinedCoverage()` — reads combined LCOV, checks it against
   `coverage.config.json` thresholds (hard fail if below), then ratchets upward.

`npm run test:mutate` runs Stryker then immediately calls `ratchet_mutation.ts`
which calls `ratchetStrykerScore()`. Mutation ratcheting is never triggered by
a coverage run.

**Threshold files:**
- `jest.config.js` — Jest-only line/branch/function/statement thresholds,
  enforced by `npx jest --coverage`. Ratcheted from `coverage-summary.json`.
- `coverage.config.json` — combined line/branch/function thresholds, enforced
  by `ratchetCombinedCoverage()` inside `npm run coverage`. Ratcheted upward
  after passing.
- `stryker.config.json` — mutation score threshold, enforced by Stryker itself.
  Ratcheted by `npm run test:mutate`.

**Known gaps in VS Code coverage:**
- Files loaded directly by the Mocha test process via `tsx/cjs` are covered:
  `treeView.ts`, `gitUtils.ts`, `repoContext.ts`, `submoduleConflict.ts`
- `meldWebviewPanel.ts` and all of `src/webview/` are **not** covered — the
  extension runs from `out/extension.js` in a sandboxed Electron sub-process
  that does not inherit `NODE_V8_COVERAGE`.

**The coverage target: `meldWebviewPanel.ts`:**
Option A: instrument `out/extension.js` with Istanbul before running tests
  (fragile with esbuild bundles, source map issues likely).
Option B: accept that `test:vscode` coverage is partial and rely on code review
  + targeted integration tests to know what's exercised.
Option C: migrate to `@vscode/test-cli` which has built-in `--coverage` support
  — it instruments the extension before launch and handles the process boundary.
  Worth spiking as the primary path to covering `meldWebviewPanel.ts`.

Until Option C is evaluated, cover `meldWebviewPanel.ts` behavior through
targeted VS Code integration tests (see Phase 6 checklist) and treat the
absence of line coverage for that file as a known, documented gap — not a pass.

### Right Next Targets (by real bug risk, not mutation score)

The VS Code integration tests already cover the high-risk paths in
`resolveCustomTextEditor` and conflict detection well. The genuine gaps — paths
that would cause silent data loss or confusing user-facing failures — are:

1. **`completeMerge` in `meldWebviewPanel.ts`** — the path that calls
   `getUnresolvedReasons`, blocks on markers, then `document.save()` and
   `smartAdd`. A regression here means the user thinks they completed the merge
   but the conflict file was not staged. Add to `merge_editor.test.ts`:
   - Blocked case: file contains `<<<<<<<`, expect error message shown
   - Happy path: clean file, save called, panel disposed

2. **`contentChanged` queue ordering** — the serialized edit queue with echo
   suppression (`classifyDocumentChange`) is already unit tested. The integration
   of it with a real document is not: rapid sequential edits should produce
   exactly the final content, with no dropped or duplicated edit. The comment
   in `_setupPerEditorListeners` explicitly warns about the race condition.
   Add to `merge_editor.test.ts`: send multiple `contentChanged` messages before
   the previous `applyEdit` resolves, verify the final document text.

3. **`App.tsx` `updateConfig` message** — sets `syntaxHighlighting` and
   `baseCompareHighlighting`. The JS handler exists but no test sends this
   message. Low risk but easy to add to `webview_react.test.tsx`.

**Do not** chase mutation scores in `meldWebviewPanel.ts` with Jest unit tests —
the VS Code coupling is fundamental, not accidental. The right metric for that
file is VS Code integration test coverage, not Stryker.

## Phase 6: Quality Ratchets And Completion

- [x] Add `c8` and `lcov-result-merger` to `devDependencies`.
- [x] Add `scripts/collect_coverage.ts` — single entry point that deletes stale
      outputs before each generation step, uses a fresh `mkdtempSync` raw dir
      under `test-output/coverage/` for V8 JSON (cleaned in `finally`), merges
      via `mergeCoverageReportFiles` API with exact file paths, then calls
      ratchet functions directly (no shell-out).
- [x] Split `ratchet_coverage.ts` into three exported functions:
      `ratchetJestCoverage` (`coverage-summary.json` → `jest.config.js`),
      `ratchetCombinedCoverage` (combined LCOV → `coverage.config.json`,
      enforces thresholds before ratcheting upward),
      `ratchetStrykerScore` (Stryker JSON → `stryker.config.json`).
- [x] Add `coverage.config.json` — checked-in combined thresholds, seeded from
      baseline with SLACK=1. Enforced as a hard gate by `ratchetCombinedCoverage`.
- [x] Add `scripts/ratchet_mutation.ts` — thin entry point called only by
      `npm run test:mutate`, so Stryker thresholds are never touched by a
      coverage-only run.
- [x] `npm run coverage` is the single user-facing coverage command; `pre-checkin`
      calls it. No separate `ratchet` script exposed to users.
- [ ] Spike `@vscode/test-cli --coverage` to determine if it covers
      `meldWebviewPanel.ts` (the main unresolved coverage gap).
- [ ] Record baseline combined coverage per file after the raw-dir fix.
- [ ] Add `completeMerge` integration tests to `merge_editor.test.ts`.
- [ ] Add `contentChanged` queue-ordering integration test.
- [ ] Re-run full Jest: `npx jest --runInBand`.
- [ ] Re-run full mutation: `npx stryker run`.
- [ ] Compare mutation score against the Phase 0 baseline.
- [ ] For each remaining Stryker survivor, document whether it is an equivalent
      mutant, accepted low-value mutant, missing test, or production design smell.
      Do NOT write tests that only verify a lookup table or trivial getter.
- [ ] Raise Stryker thresholds only after the suite is stable.
- [ ] Run `npm run pre-checkin`.
- [ ] Update `implementation_reference.md` with any new test files or important
      workflow changes.

Done when Stryker score is above threshold for Jest-reachable code, combined
coverage is measured from clean per-run inputs and ratcheted correctly,
`completeMerge` and edit-queue paths are covered, and `npm run pre-checkin`
passes cleanly without depending on network-fetched tools.

## Definition Of Done For A Test Change

Before writing a test, answer: **what user-visible or protocol-visible thing
breaks if the code is wrong?** If the answer is "the log message has the wrong
string" or "the enum lookup returns a different number," the test is not worth
writing.

- [ ] The test fails against at least one plausible wrong behavior.
- [ ] The assertion checks a user-visible, protocol-visible, or domain-visible
      outcome.
- [ ] The test data includes a meaningful edge case, not only the simplest happy
      path.
- [ ] The test does not copy non-trivial production logic.
- [ ] The relevant targeted Jest command passes.
- [ ] For Stryker: the run kills the intended mutants or survivors are explicitly
      triaged as equivalent/accepted.
- [ ] Documentation is updated if the test locks in architecture or workflow
      expectations.
