# Weld agent tools

This document describes the responses returned by Weld's VS Code language
model tools. It reflects `src/agentConflicts.ts`.

## Purpose and Intent

> [!NOTE]
> User written. Agents may not edit this section. This is a top level feature
> description. Each item in the implementation must be traceable back to items
> here to avoid unnecessary agent-invented features.

Weld's 3-way merge editor identifies conflict regions (ideally small, but not
always) that still need a decision. The 3-way view shows the two diverged local
and remote branches and how they map to the merged region. The merged region can
be considered the result/output. A conflict is when the changes cannot be
resolved automatically. Meld's algorithm that Weld-Merge uses can resolve a few
cases that git cannot.

Simply seeing the local and remote sections in context in the output file is
often enough to confidently resolve the conflict, which is why the 3-way view is
so convenient. The resolution is to apply both the intent of the modifications
on the local branch and the remote branch, compared to the base state (the
common ancestor). For difficult to resolve conflicts, seeing the diff from base
to local and base to remote makes the solution much clearer, which is why we
have compare-with-base buttons in the UI to expand the 3 columns to 5: base ->
local -> merged <- remote <- base.

The goal of the agentic tools is to expose this convenience to agents.
Particularly providing minimal calls to get all the required context to resolve
most merge conflicts quickly, including the underlying Meld auto-merge result.
We succeed when the tool call is simpler and faster for agents to use to arrive
at successful resolutions than if they try reading the file manually, sometimes
needing to git command to see the necessary context. It is critical this is
measured, otherwise the feature would actually be harmful to agents who would be
mislead.

To achieve this we cannot afford to increase fluff of json encoding,e.g. by
having an array of lines. Instead:

- For 2-way diffs, there is already standard diff output formatting. This
  already includes line numbers, so we have everything needed.
- For 3-way output, git already uses standard conflict markers, but we need line
  numbers. We could augment them with something like diff3 output or even just
  use diff3 formatting instead.

A diff/merge is a relation between several files and each carries its own
numbering; the format should expose the line number mapping, e.g. the way
diff/diff3 headers already do. However, need to provide the agent with the line
number range in the file on disk to replace with their merge result. This should
probably be included in the 3-way output block(s) themselves so there is no
ambiguity about mapping. Since the file on disk likely contains a block with
conflict markers already, we will not show the content.

It is impossible to confidently resolve a conflict without seeing some lines of
context for where the final result will be. In both cases we must have a
configurable lines of context above and below the diff. These must trivially be
included in the text response (i.e. not separate json variables).

When the file on disk matches the auto-merged result, we just return the
requested 3-way merge results for the conflict blocks with context. One
complexity is when the file on disk is different than the auto-merged result. In
this case the Weld-Merge UI offers the user a choice to replace the file with
the auto-merge result OR just open the existing file in the output/merged panel.
For agent tools, we will simply return the result of both: the 3-view comparison
with the file on disk AND the 3-view comparison with the regenerated auto-merged
result (well, the conflicting sections at least). While the auto-merged result
has no file location, it would be considered the suggested conflict resolution
to be place in the output/merged file.

Considerations:
- Is providing just {local, base, remote} enough or do we need individual 2-way
  diffs too? I.e. what the file would typically have after running automerge
  anyway. Agents should be able to spot the difference, probably better than
  humans, which reduces the usefulness that this extension actually provides.
- Put another way, does base--local and base--remote diffs give any additional
  information or make it easier for the agent or are agents just as comfortable
  with the {local, base, remote}? Highlighting differences for long output might
  be useful, but it definitely adds duplicated data to the response. One thought
  is to make the base comparisons optional (just as they are in the UI) and
  leave it to the agent to decide.
- Should we separate git merge results from auto-merge and provide the
  auto-merge as a suggested resolution? I'm thinking not because the cases where
  auto-merge fails are around the same frequency that regular merge fails to
  conceptually merge (i.e. no source code conflicts but it fails to compile).

We must not overload agents' context with giant conflicts. This can happen when
the files are so radically different or confuse the algorithm such that most of
the file becomes a single conflict. In this case we need to shorten the interior
of the conflict regions as one would use a "..." ellipsis, but still make the
line numbers clear. This will effectively provide the agent with a summary for
the conflict that it would need to investigate further.

To summarise,

- agents can get an early list of conflicts with base, local, remote commit
  identifiers (both hash and any branch/tag etc); handles one side added,
  deleted, submodules etc.
- agents can select one or a range of conflicts
- an opportunistic optional combine-both-calls if the conflicts are actually
  small - if the result would be below some threshold, inline conflicts with the
  list
- we must use the same comparison data as the merge editor and its Base views;
  strictly no code duplication or alternative implementations
- possibly show Base → Local and Base → Remote as standard diffs;
- include a context of immediately adjacent equal lines
- make sure the locations in files for base, local, remote and
  output/merged/file on disk versions are explicit or clearly implied in a
  standard and intuitive way.

There are strictly no editing tools provided. Resolutions the agent wishes to
make must be made by editing the file directly. We must be careful to match what
is actually on disk as the agent will treat this as authoritative and could make
edits based on our line numbers.

The `(??)` markers Meld creates for the UI is the encoding of absence. It means
"auto-merge has no answer here". Their only purpose is to leave content in the
UI. They are not useful to agents and will not be included in the response. Note
that these are added to the UI version after auto-merge and are not part of it.
Either auto-merge succeeded and there is no conflict, or it failed and the agent
is required to produce a resolution from scratch.

Once agents have completed a merge, they need a way to verify there are no
longer any stray conflict markers, e.g. `<<<<<<<` or `(??)`, which would
indicate either an unfinished merge or markers left in from a previous commit.
These should be reported along with the list-conflicts command.

What even is the point of this interface if agents can just look through
conflict markers already embedded in the file (provided the user has set up git
to embed 3-way blocks properly, like zdiff3, and not the default "ours" and
"theirs" *facepalm*). The following is my justification and I'm not entirely
convinced until I actually test it:

- Good results even if the user is not using zdiff3
- Listing conflicts, shows ranges of any size and their details in one tool call
- Skipping `git show :1: :2: :3:` and possible line number correlation
- Auto-merge; but this could be the one and only tool call too and avoid the
  complexity of returning conflicts

### Auto-Merge

We expose two auto-merge functions. One all-files and one targeted file:

- weld_apply_automerge_all
- weld_apply_automerge

For weld_apply_automerge_all, attempt all appropriate both-modified files.

- Report and skip files that would be clobbered by auto-merge. To do this we
  check if the file is in its pre-auto-merge state OR its post-auto-merge state. If neither match, the file has been edited since git created the merge conflict.
- If the above states are the same, auto-merge wouldn't do anything anyway. If
  it's in the post-auto-merge state, it's already been run and the result is a
  no-op.
- We report the result and reason of each - which files were skipped, wouldn't
  have changed, had any successful auto-merged conflicts via the number of
  conflicts that were able to be auto-merged and the number of remaining
  conflicts.

An optional force option (off by default) can be given to either call to
pre-agree to clobber files with the auto-merged result.

weld_apply_automerge is just like weld_apply_automerge_all but targets a
specific file and may outright fail if it would clobber the result and force was
not set.

In addition to applying auto-merge, we check if there are still remaining
conflicts. If there are no more conflicts we should automatically stage the
changes for that file. if there are still conflicts, the result is a success but
we also report explicitly how many conflicts remain (even if none were fixed).
If this doesn't already happen in the vscode/UI auto-merge, then we should
update that path too. Both paths should share the same implementation.

Code to do all this is already implemented in weld-merge. Adapt it to be used by
both paths and do not duplicate any code.

It is important to be explicit that auto-merge does not guarantee automatic
merging (admittedly a misnomer, carried over from Meld). We must also not claim
that a file has been auto-merged or is "already merged" as this implies there
are no conflicts left. Instead, something like: all automatic resolutions have
already been applied but not all conflicts are resolved.

### Authoritative File Risks

A risk in operations which make changes:

1. Auto-merge may replace the contents of a file with the auto-merged result
2. Automatically staging a file necessarily stages a state on disk, but does this match the authoritative state of the file

Both of these operations can be highly dangerous as the user and agent may assume one thing but the result is something else.

When agents read or edit a file, it appears they do operate on the on-disk
version and do not go via vscode's TextDocument. When the user's open editor is
dirty/unsaved I expect it stops seeing edits made by agents (auto-update from
disk).

Codex: "I have a filesystem patch tool for edits, and I’m required to use it for repository changes. It writes saved files on disk; it does not integrate with your currently open VS Code buffer."

We need testing to probe all cases and permutations. In general we should match
existing vscode behaviour so users are not surprised. E.g. if an agent changes
the on-disk file a user is editing in-memory and commits it, the same would
happen for auto-merge completing and staging a file.

## Compactness

Compactness is a correctness requirement. The response must be cheaper than
reconstructing the same view from Git stage blobs and the file on disk.
Every field must help decide the conflict, place an edit, or explain a real
limitation.

The VS Code integration tests enforce normalized byte budgets for small,
contextual, multi-conflict, both-added, and elided responses. They also
measure useful response content against JSON overhead. Change those tests
deliberately when changing this response shape.

## `weld_list_conflicts`

```ts
type ConflictKind =
  | "text" | "bothAdded" | "binary" | "deletedByUs" | "deletedByThem"
  | "bothDeleted" | "submodule";

type ConflictList = { files: ListedConflict[] };
type ListedConflict = {
  repositoryRoot: string;
  path: string;
  kind: ConflictKind;
  // Weld's count. Auto-merge resolves some conflicts git cannot, so this
  // can be lower than the number of marker blocks in the file — including
  // zero while git still reports the file conflicted.
  conflictCount: number;
  commits: { base?: CommitId; local: CommitId; remote?: CommitId };
  strayMarkers?: StrayMarker[];
  strayMarkersTruncated?: true;
  // Present when every conflict in the workspace fits the inline budget:
  // the same blocks weld_get_conflict would return, saving the second call.
  conflicts?: ConflictBlock[];
};
CommitId = { hash: string; ref?: string; title: string };
StrayMarker = { range: DiskRange; kind: "gitMarker" | "weldSentinel" };
```

- `ref` is a branch/tag name and only present when one names the commit
  exactly; approximations like `main~3` are omitted.
- `strayMarkers` reports git conflict-marker syntax and Weld `(??)` sentinel
  lines found in the file on disk, as ranges only — never their body text.
  During an active merge these are usually the merge's own markers; once all
  conflicts are resolved, any remaining entry is stray (checked in earlier,
  half-deleted, or accidentally saved) and needs attention. This is the
  post-merge verification step: list again and expect no `strayMarkers`.

## `weld_get_conflict`

Input: `repositoryRoot` and `path` from the listing, optional
`conflicts: [first, last]` (zero-based inclusive; omitted = all conflicts in
the file), `contextLines` (default 5), `maxSectionLines` (default 40), and
`includeBaseDiffs` (default false; see below).

```ts
type TextConflictResult = {
  type: "text" | "bothAdded";
  repositoryRoot: string;
  path: string;
  conflictCount: number;
  conflicts: ConflictBlock[];
};

type ConflictBlock = {
  index: number;
  // One-based [startLine, endLineExclusive) in the file on disk: the lines
  // the agent's resolution replaces. Absent when the conflict no longer
  // maps to the disk file; `note` explains and the agent should read the
  // file itself.
  range?: DiskRange;
  note?: string;
  text: string;
  // Present only when the file on disk differs from the auto-merge result
  // near this conflict: the same alternatives wrapped in the auto-merged
  // surroundings instead. It has no file location; it is the suggested
  // shape of the output around this conflict.
  autoMergeView?: string;
  // Present only when the request set includeBaseDiffs. Standard unified
  // diffs of Base against Local and against Remote, scoped to this
  // conflict's region — the same data behind the UI's compare-with-base
  // buttons, rendered from the file on disk. Optional because the block's
  // alternatives already convey what changed for most conflicts; the diff
  // form can make the change clearer for a harder one, at the cost of
  // repeating text already present in the block.
  localDiff?: string;
  remoteDiff?: string;
};
type DiskRange = [startLine: number, endLineExclusive: number];
```

`text` is a generated diff3-style block — the standard format agents already
know — wrapped in real context lines from the file on disk:

```
context line from disk
<<<<<<< LOCAL replaces lines 12-18
local stage section
||||||| BASE
base stage section
=======
remote stage section
>>>>>>> REMOTE
context line from disk
```

- The alternatives are generated from the Git stages via the same shared
  comparison models the merge editor renders (`src/conflictSnapshot.ts`);
  the disk file's own conflicting content (its marker block or sentinel) is
  never echoed — the disk range is the only thing taken from that region.
- The opening label carries the disk location so the mapping is unambiguous
  inside the text itself: `replaces lines A-B` (one-based inclusive), or
  `inserts before line A` when the mapped disk region is empty.
- `bothAdded` blocks have no `||||||| BASE` section: there is no common
  ancestor to show.
- A section longer than `maxSectionLines` keeps its head and tail and elides
  the interior with explicit one-based line numbers in that side's file:
  `... 47 lines elided (local 210-256) ...`. This is the giant-conflict
  summary; the agent investigates further only when it matters.
- Context lines stop at any conflict-marker-like or `(??)` line: a
  neighboring conflict's markers are not the final text an edit must fit,
  and the sentinel encodes absence. `(??)` never appears in any response.
- No suggestion payloads exist. Either auto-merge resolved a region (it is
  not a conflict, and `weld_apply_automerge` writes it) or it failed and the
  agent produces the resolution from scratch.

Whole-file kinds are unchanged:

```ts
type NonTextConflictResult = {
  type: "binary" | "deletedByUs" | "deletedByThem" | "bothDeleted" | "submodule";
  repositoryRoot: string;
  path: string;
  conflictCount: 1;
  message: string;
};
```

## `weld_stage_resolved`

Input: `repositoryRoot` and a non-empty `paths` array of repository-relative
conflicted paths, e.g. files the agent just edited.

```ts
type StageResolvedResult = { files: StagedFile[] };
type StagedFile =
  | { path: string; staged: true }
  | {
      path: string;
      staged: false;
      reason: "strayMarkers" | "notStageableKind" | "stagingFailed";
      kind: ConflictKind;
      conflictCount: number;
      strayMarkers?: StrayMarker[];
      strayMarkersTruncated?: true;
    };
```

This is the narrow verify-then-act counterpart to `weld_list_conflicts`'s
post-merge verification step: instead of re-listing every conflicted file in
the workspace (conflict content, commit identifiers, kind) just to check
whether the files an agent just edited are clean, it checks exactly the given
paths and, for each one that is clean, runs `git add` — collapsing the
"did that work, and if so lock it in" round trip into one call with a much
smaller response.

"Clean" is gated on the **absence of stray markers**, not on `conflictCount`.
`conflictCount` (Weld's own count, from diffing the git index stages the same
way `weld_list_conflicts` does) reflects whether Weld's auto-merge algorithm
could reconcile base/local/remote — it says nothing about arbitrary text an
agent writes by hand. A correctly hand-resolved file routinely still reports
`conflictCount > 0`, because the underlying base/local/remote stages never
agreed automatically; that is expected, not a sign of a bad resolution. The
only signal that generalizes to hand-written text is the same one
`weld_list_conflicts` already documents as the verification step: no leftover
`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>` marker syntax or Weld `(??)` sentinel
on disk. `conflictCount` is still returned on a skip for context.

- `reason: "strayMarkers"` — marker or sentinel text remains; `strayMarkers`
  carries the same ranges `weld_list_conflicts` would report. Fix and call
  again.
- `reason: "notStageableKind"` — binary, delete/modify, both-deleted, and
  submodule conflicts are never staged by this tool (there is no hand-edited
  text to verify); resolve via `git add`/`git rm` or the submodule UI as
  `weld_list_conflicts`'s `kind` indicates.
- `reason: "stagingFailed"` — the file was clean but `git add` itself failed
  (rare); see the extension's log output.

## Examples

Illustrative only; the integration tests enforce exact shapes and sizes.

`weld_get_conflict` for a text conflict:

```json
{
  "type": "text",
  "repositoryRoot": "file:///repository",
  "path": "src/example.ts",
  "conflictCount": 1,
  "conflicts": [
    {
      "index": 0,
      "range": [4, 10],
      "text": "export function value() {\n<<<<<<< LOCAL replaces lines 4-9\n  return local;\n||||||| BASE\n  return base;\n=======\n  return remote;\n>>>>>>> REMOTE\n}"
    }
  ]
}
```

`weld_list_conflicts` with the same conflict inlined:

```json
{
  "files": [
    {
      "repositoryRoot": "file:///repository",
      "path": "src/example.ts",
      "kind": "text",
      "conflictCount": 1,
      "commits": {
        "base": { "hash": "3f9d2ab…", "title": "init" },
        "local": { "hash": "b6bb4ad…", "ref": "main", "title": "local change" },
        "remote": { "hash": "4248ee6…", "ref": "feature", "title": "remote change" }
      },
      "strayMarkers": [{ "range": [4, 10], "kind": "gitMarker" }],
      "conflicts": [ { "index": 0, "range": [4, 10], "text": "…" } ]
    }
  ]
}
```

## Implementation and test references

- `src/conflictSnapshot.ts`: shared two-way and three-way comparison models.
- `src/webview/diffPayload.ts`: GUI payloads built from those models.
- `src/agentConflicts.ts`: conflict block rendering, disk mapping, stray
  marker scan, commit identifiers, `weld_stage_resolved`'s verify-then-`git
  add` logic (reusing `webview/autoMerge.ts`'s `stageIfClean`).
- `test/vscode/suite/agent-tools.test.ts`: block format, GUI parity, disk
  mapping, elision, stray markers, inline listing, response-size budgets,
  stage-resolved verification and staging.

## Auto-merge state semantics and test contract

This section is a test plan and desired contract. It deliberately does not
amend the user-written purpose statement at the start of this document.

The phrase “Weld fully resolves” is not, by itself, enough to specify an
expected result. It means only that Weld can derive a marker-free candidate
from Git's base, local, and remote index stages. Whether that candidate may be
applied, saved, or staged depends on the live VS Code document and the working
tree file.

### The three relevant inputs

- **Git stages (`G`)** are the source for the candidate `M`: Weld reads the
  base/local/remote conflict stages and calculates an auto-merge result. It
  never derives `M` from an editor buffer or from arbitrary working-tree text.
- **The VS Code `TextDocument` (`D`)** is a potentially dirty user buffer. It
  can differ from disk after user edits, and it must be left to VS Code's
  normal external-change/save-conflict handling when a disk-oriented operation
  changes `F`.
- **The working-tree file (`F`)** is what Git stages and what VS Code saves.
  It can differ from `D` after a tool, agent, or other process writes the file
  on disk. VS Code owns the conflict/overwrite interaction when a dirty
  `TextDocument.save()` encounters that condition; Weld must not reimplement
  it with a separate filesystem guard or dialog.

For the cases below, `I` is the exact pre-merge conflict reconstruction from
the Git stages, and `M` is Weld's candidate. “Clean” means no Git conflict
markers or Weld sentinels remain; it is separate from whether Weld could solve
every conflict. For agent-facing operations, `F` is authoritative: this is the
same model as an agent editing, staging, and committing a path directly on
disk. A dirty `D` does not silently become the target file merely because it is
open in VS Code.

### Auto-merge decisions

The following table applies to the tree command, targeted LM tool, and
batch/“all” variants. They operate on the working-tree file, just as an agent
editing a file directly would. The active-editor command is intentionally
different: it operates on the open `TextDocument`, saves it through VS Code,
and stages only after that save succeeds. A dirty active document that is not
the original conflict is therefore refused rather than overwritten. The custom
editor's on-open action has its own decision because it is implicit rather
than expressly requested by the user or agent.

| Live document / disk state | Expected auto-merge result | User-visible result |
| --- | --- | --- |
| `F = I`, with no editor or with an open clean editor | Replace `F` with `M`; if clean, stage exactly `M`. A clean open editor may update through VS Code's ordinary file watching. | Normal success or partial-merge result. |
| `F = I`, with an open dirty default or Weld editor (`D != F`) | Still replace `F` with `M` and, if clean, stage exactly `M`. Do not replace `D`. A subsequent user save follows VS Code's external-change behavior. | The operation has the same disk semantics as an agent direct edit; no custom Weld overwrite dialog. |
| `F = M` | Do not rewrite it. Stage only if the stage-0 blob is exactly `M`. | “Already applied”/success, not a second rewrite. |
| `F` is neither `I` nor `M`, regardless of `D` | Do not replace or stage that disk edit without explicit `force`. A command or targeted LM tool reports a would-clobber error; batch/all reports this file as skipped and continues. | Clear error for a single target, or a skipped entry for batch/all. |
| `F` is neither `I` nor `M`, and targeted LM auto-merge uses `force` | Replace `F` with `M`, stage exactly `M` if clean, and leave a dirty `D` alone. | Explicit forced disk operation; later user save receives VS Code's normal external-change handling. |

Every mutating case must assert all of `D`, `F`, and the stage-0 Git blob. A
test that checks only whether Git's unmerged stages disappear can falsely pass
after staging unrelated disk content. `force` authorizes overwriting the
authoritative disk file; it does not authorize silently overwriting a dirty
VS Code buffer.

### Completing a three-way merge

“Save & Complete Merge” has a different boundary from auto-merge. Its handler
first rejects a document with unresolved markers/sentinels; in that case it
must not call save and VS Code has no overwrite decision to make. For a clean
document, the expected sequence is:

1. Call `TextDocument.save()`.
2. Only if it succeeds, run the existing `smartAdd` path.
3. Dispose the three-way panel only after staging succeeds.

If an external process modified `F` after the three-way panel was opened while
the user has unsaved clean edits in `D`, `save()` is the point at which VS Code
detects the conflict. Expected behavior is the native VS Code save-conflict
experience (or a `false` save result), followed by **no staging and no panel
close**. The user may choose VS Code's overwrite/reconcile action; a later
successful save may then be staged normally. Weld must neither preempt that UI
with its own disk watcher nor treat a failed save as permission to `git add`.

### Required coverage by entry point

Tests should use the existing VS Code extension-host infrastructure and real
`TextDocument`/custom-editor tabs. The matrix is state coverage, not a demand
to create a Cartesian product of duplicate tests.

| Entry point | Required state partitions | Expected assertion |
| --- | --- | --- |
| Active-editor command | clean active document; dirty active document; disk changed after conflict | Edit and save `D` through VS Code, then assert `F` and stage 0. A dirty non-conflict document is refused and remains unchanged. |
| Tree command | unopened; default editor open/clean; default editor dirty; disk changed after conflict | Assert `D`, `F`, stage-0 blob, Git stages, and the visible command error where applicable. |
| Auto-merge all | mixture of `F = I`, dirty open documents, and externally edited files | Safe files continue and stage their candidate blob; unsafe files are returned as skips, not overwritten or staged. |
| Targeted and batch LM tools | the same states, plus direct-agent disk edit + dirty document, and explicit `force` | Tool response distinguishes applied, already-applied, skipped, and forced operations. On every reported stage, `git show :0:path` equals the reported candidate. |
| Opening the real three-way custom editor | default editor already open; dirty document; clean conflict | Both tabs share one document; opening does not clobber dirty text; clean auto-merge is reflected in every open tab. Implicit open must not have broader overwrite authority than an explicit operation. |
| “Save & Complete Merge” | clean manually resolved document; unresolved markers; external disk edit after panel open | Respectively save/stage/close; reject before save; or invoke VS Code's native save-conflict behavior and leave the file un-staged and panel open on failed save. |

For command handlers that surface exceptions through VS Code notifications,
tests should assert the domain outcome and the retained text rather than assume
`executeCommand` itself rejects. LM tools, by contrast, must return their
structured failure/skip information to the caller. After each disk mutation
with dirty `D`, tests must call `document.save()` and assert VS Code's native
external-change result. This is both the behavioral baseline and a guard
against replacing VS Code's handling with a Weld-specific dialog.

### Executable authority coverage checklist

The following case IDs are the finite coverage set. A test may cover more than
one ID only when its setup and assertions explicitly establish both states.
Every `apply` case asserts `D`, `F`, and `:0:path`; every `reject`/`skip` case
asserts that the pre-operation disk bytes and unmerged index stages remain.

| ID | Entry point | State and required outcome |
| --- | --- | --- |
| A1–A3 | Targeted LM | `F = I` with document absent, clean, and dirty: apply/stage `M`; preserve dirty `D`. |
| A4–A6 | Targeted LM | `F = M` with document absent, clean, and dirty: no rewrite; stage exactly `M`; preserve dirty `D`. |
| A7–A9 | Targeted LM | `F = E` (external/agent edit) with document absent, clean, and dirty: reject and preserve `E`; `force` applies/stages `M` and preserves dirty `D`. |
| B1–B4 | LM all | One safe `F = I`, one `F = E`, plus dirty-open variants: safe paths apply/stage `M`; unsafe paths report `skippedWouldClobber`; the batch continues. |
| C1–C2 | Command Palette active file | Clean active document containing `I`: replace and save `D` through VS Code, then stage `M`. A dirty active document that differs from `I` is refused; it, `F`, and the unmerged index entries remain unchanged. (There is no active-file command without a document.) |
| C4–C5 | Command Palette active file | `F = E` with clean and dirty documents: VS Code save failure or a visible refusal; no stage-0 mutation. |
| D1–D3 | Tree action | `F = I`, `F = M`, and `F = E`: same behavior as targeted LM without `force`. |
| E1–E3 | Custom editor opening | Default editor already open; dirty document; externally diverged disk: tabs share `D`, implicit opening preserves dirty data, and it never gains broader overwrite authority. |
| F1–F3 | Complete merge | clean resolved save/stage/close; unresolved markers reject before save; external disk edit after panel open produces native save conflict and prevents stage/close. |
| G1–G2 | Partial merge | targeted and batch paths leave remaining markers on disk and preserve unmerged Git stages; no stage-0 blob is created. |
| H1 | Direct agent disk baseline | Dirty `D`, agent writes and stages `F`: `D` survives and its subsequent save is handled by VS Code. |

The tests do not try to manufacture a disk write at the exact instant between
checking a file and running `git add`. Every normal mutating case instead reads
the staged blob afterward and compares it with the expected result.

### Failing examples for review

These are the failures currently observed by the VS Code-host tests. They are
examples for deciding the intended product behavior, not proposed fixes.

#### 1. A normal fully resolvable auto-merge stages the old file

Starting point: the working-tree file contains Git conflict markers (`F = I`)
and no editor is open. An agent explicitly calls the targeted
`weld_apply_automerge` LM tool for this path. That tool reads Git's conflict
stages and computes the fully resolved candidate `M`.

Current behavior: Weld changes an in-memory VS Code document to `M`, then runs
`git add`. The file on disk is still `I`, so Git stages `I` and clears its
unmerged entries. Weld reports `staged: true`, even though the staged blob is
not `M`.

Expected behavior to review: write `M` to disk first, then stage it. On success
the file on disk and Git's stage-0 blob must both equal `M`.

User: yes, the LM tool result should be written to the on-disk version

Related case: If the user has an open document and runs auto-merge current file
from the command palette, it should actually change the in-memory TextDocument.

#### 2. Batch auto-merge stages the wrong bytes for its safe file

Starting point: two repositories are open. In one, `tracked.txt` is `I` and
Weld can resolve it to `M`. In the other, an agent has already replaced
`tracked.txt` on disk with unrelated text `E`. The agent explicitly calls the
`weld_apply_automerge_all` LM tool.

Current behavior: the batch correctly treats `E` as a file to skip, but its
supposedly merged safe file has the same document-versus-disk problem as
example 1. The batch result can say that it merged and staged the safe file
without Git's staged blob being `M`.

Expected behavior to review: continue past `E`, leave its disk content and
unmerged stages unchanged, and write/stage exactly `M` for the safe file.

User: are you saying that we stage a file even though it's been skipped? Can you
stop with the terrible "safe file" invented jargon!?

#### 3. A dirty editor prevents auto-merge of an unchanged disk conflict

Starting point: the file on disk is still the original conflict `F = I`. The
user has a dirty VS Code buffer with unrelated unsaved text `D = U`. The
covered calls are: an agent calls targeted `weld_apply_automerge`; an agent
calls `weld_apply_automerge_all`; or the user explicitly runs Weld Auto-Merge
from the Command Palette for the active file.

Current behavior: targeted LM auto-merge and LM auto-merge-all inspect `D`,
conclude it is neither `I` nor `M`, and refuse or skip. Nothing is merged on
disk. The active-editor command is deliberately excluded: it is supposed to
operate on that document.

Expected behavior to review: because the two agent operations are
disk-oriented, write and stage `M` on disk while leaving `D = U` alone. If the
user later saves their buffer, VS Code should perform its usual
external-file-change handling. Weld should not display its own overwrite
dialog.

User: correct; LM tools operate on disk files. User dirty file is an orthogonal
issue. Note that the user calling Auto Merge Current File is the edge case that
happens to the in-memory version whereas "Auto-Merge All Conflicting Files"
operates on the on-disk versions.

#### 4. An already-resolved disk file is rejected because an editor is dirty

Starting point: an agent has already written Weld's exact candidate to disk
(`F = M`). A user still has a dirty, different buffer (`D = U`). The agent
then explicitly calls targeted `weld_apply_automerge` to stage the already
applied automatic resolutions.

Current behavior: Weld reads `D`, treats it as a clobber risk, and rejects the
operation. It does not stage the already-resolved disk file.

Expected behavior to review: leave both files alone: keep `D = U`, leave
`F = M` unchanged, and stage exactly `M`. A later user save is VS Code's
responsibility.

User: sounds right.

#### 5. Forced auto-merge changes the buffer but stages unrelated disk text

Starting point: the user has dirty text `D = U`; an agent has separately
written unrelated disk text `F = E`; the agent explicitly calls targeted
`weld_apply_automerge` with `force: true`.

Current behavior: Weld replaces the open buffer with `M`, but does not write
`M` to disk before `git add`. Git therefore stages `E`, while the buffer says
`M`. The tool reports success and staging even though no one location contains
the result it claims to have staged.

Expected behavior to review: `force` should mean “replace the disk file with
`M` and stage `M`.” It should not replace the user's dirty buffer. Afterward,
`F` and stage 0 equal `M`, while `D` remains `U`; a later save uses VS Code's
normal external-change handling.

User: sounds right.

#### 6. Save & Complete Merge continues after VS Code rejects the save

Starting point: a three-way merge panel has a clean, manually resolved dirty
buffer `D = R`. An agent or other process then writes different disk text
`F = E`. The user clicks **Save & Complete Merge** in that panel.

Current behavior: `document.save()` returns false because VS Code detects the
external change. The completion handler currently continues to `smartAdd`
instead of stopping. That can stage `E` and close the panel although `R` was
never saved.

Expected behavior to review: stop immediately when save returns false. Leave
the panel open, leave Git unmerged, and let VS Code present its ordinary
external-change/save-resolution behavior. Only a later successful save may be
followed by staging and panel disposal.

User: sounds right. We need to audit the code for all ignored return values such
as this. Ideally warnings/errors/linting could help us here.

Status: all six examples above are fixed (`performAutoMergeOnDisk` /
`performAutoMergeOnDocument` in `src/webview/autoMerge.ts`;
`_handleCompleteMerge` in `src/webview/meldWebviewPanel.ts`). The requested
audit of ignored return values found two more instances of the same bug class,
also fixed:

- `readSavedDocument` and `handleActiveEditorSmartAdd` in `src/extension.ts`
  (the tree/URI/active-editor "Git Add" command) ignored `document.save()`'s
  return value and would stage whatever was actually on disk while believing
  it had verified the in-memory text. Both now throw when `save()` returns
  `false`.
- `MeldCustomEditorProvider._handleMessage`'s `"contentChanged"` and `"save"`
  cases (`src/webview/meldWebviewPanel.ts`) ignored `workspace.applyEdit()`'s
  and `document.save()`'s return values. Worse, because `_handleMessage`
  deliberately does not await these steps (the webview applies edits
  optimistically and isn't waiting on a reply), a thrown error inside a
  queued step would never reach `_handleMessage`'s own `try`/`catch`, and
  would silently poison `editState.editQueue` forever — every later edit or
  save chained onto that same queue would no-op, since `.then()` on a
  rejected promise skips its callback. `_runQueuedEditStep` now reports a
  failed step directly to the webview's own `"error"` message channel and
  always resolves (never rejects) the queue, so one failed edit/save can
  never wedge every later one.

No general lint rule enforces this (`no-floating-promises`-style checks catch
an unawaited promise, not a checked-but-discarded boolean); this was a manual
audit of every `.save()`/`applyEdit()` call site in the affected files.
