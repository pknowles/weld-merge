# Weld agent (LM) tools — wire schema

Formal spec for the `weld_list_conflicts`/`weld_get_conflict` VS Code
Language Model Tool response shapes. This is a design document: it may
describe a shape not yet implemented (marked `(planned)`) alongside the
shape currently shipping (marked `(current)`). Update it whenever the shape
changes; `src/agentConflicts.ts` must match whichever section is marked
`(current)`.

## Top-level design directive

Everything below follows from this. If a field or requirement can't be
justified against it, it doesn't belong in the schema.

Weld's GUI is genuinely useful for resolving merge conflicts. The goal of
these tools is to give an agent the same thing that makes the GUI useful,
not a full dump of everything Weld knows.

What makes the GUI useful:

1. **Jump straight to the merge conflicts** — the red regions left after
   auto-merge runs. Everything else in the file is noise for this purpose;
   the tool must scope to the conflict region, never the whole file.
2. **The GUI's 3-way view, scoped to that region, is what's useful — all
   of it, in one response, not a tiered or fallback subset.** The view is
   local | merged | remote. Exactly *at* a conflict, the merged column has
   no defined content (that's what makes it a conflict), so what's actually
   shown there is local's and remote's content directly — not a diff of one
   against the other, not routed through a synthetic merged value. In
   practice, seeing local and remote plus a little surrounding context is
   good enough 90% of the time to decide what the resolved region should
   contain — that's the observation motivating why this content must be
   cheap and present without a follow-up call, not a reason to withhold
   anything else from the response.
   Alongside that, the same UI also shows base↔local and base↔remote for
   that region (the "compare with base" panels) — this is additional data
   available in the same view, not a separate mode reached by escalating
   after getting stuck. Both are part of the one response.
3. **All four of these — base, local, merged, remote — are scoped to the
   same conflicted region, plus a little context**: `base -> local ->
   merged <- remote <- base`. Nothing here diffs or ranges over the whole
   file.
   [Inference, not stated directly: `base↔local` and `base↔remote` are
   presumably each bounded to the same conflicted region — the lines
   relevant to *this* conflict — rather than the side's full set of changes
   since the merge base. This follows from `base -> local -> merged <-
   remote <- base` being written as one region mapping, but should be
   confirmed rather than assumed.]

4. **The tool is a compact projection of Weld's existing GUI model, not an
   independently implemented merge or diff view.** Its source of truth is
   the same `ConflictSnapshot`/`Merger` conflict state that seeds the
   auto-merged editor, the same three-way diff data used by
   `buildDiffPayload()` when the editor opens immediately after replacement,
   and the same base-comparison diff data used by `buildBaseDiffPayload()`.
   The tool may select and serialize those existing regions compactly, but it
   must not rerun a different diff algorithm, hunk discovery, or conflict
   membership rule, or otherwise create a second interpretation of the file.
   The agent may select a bounded presentation from those chunks: contiguous
   equal lines immediately above and below the change make syntax,
   whitespace, and surrounding structure verifiable. Parity
   with what the GUI would show is the requirement.

   This does **not** authorize sending the GUI's whole-file payload. The
   tool selects the requested conflict and bounded relevant context from that
   authoritative model, then serializes only that summary. GUI parity is
   parity of content, ranges, and conflict meaning—not payload size.

The hard problem this creates: the diffs and region mappings behind this
view can fail to be tidy. Sometimes a diff itself fails to land cleanly.
Sometimes the conflicting region legitimately maps to a giant span in one
or both files. There is no clean boolean for failed-vs-not — degradation is
a spectrum, not a flag. The schema has to make this visible to the agent
immediately: from the response alone, the agent must be able to tell
whether what it got back is trustworthy and useful as-is, or whether it
should give up on the tool's summary and go read the files directly.
Silently handing back something huge or misleading, with no signal that it
happened, is the failure mode to design against.

Every other requirement in this document is in service of these two
things: (a) the conflict-region view — local, remote, base↔local, and
base↔remote, all scoped to the conflict, all in one response — is small
and immediately actionable, and (b) when it can't be, the response says so
plainly rather than either drowning the agent in a giant payload or
quietly truncating without a way to tell.

## Response efficiency is a correctness requirement

This tool exists to make conflict resolution cheaper than an agent
reconstructing Weld's view from files and raw Git. Compactness is therefore
not a cosmetic optimization: if schema scaffolding or unrelated output makes
the response costlier than that reconstruction, the tool has failed its
purpose.

Every field must earn its serialized bytes by either deciding the requested
conflict, placing the direct edit in the live file, or exposing a real
degradation. Results are compact JSON. Tests must measure serialized response
length for representative small, contextual, multi-conflict, both-added, and
bounded-large fixtures, after normalizing the variable repository URI, and
enforce reviewed upper bounds. The bounds are part of the wire contract, not
console-only telemetry; changing one requires an intentional review of the
new bytes and the information they buy.

Integration tests must also construct the corresponding real GUI payload for
each tool fixture and verify that every returned stage/disk content fragment
and its line coordinates maps to the same GUI view. Separate response-size
tests must classify compact-JSON characters as useful content or schema
overhead, enforce a reviewed minimum useful-content percentage for each
fixture class, and ratchet that percentage upward when avoidable overhead is
removed.

## Requirements

Derived directly from user direction during design review. Quotes are
verbatim; anything not a direct quote is a paraphrase of a specific
instruction, marked as such.

- **The model has cheap, free access to the current file's own text; it
  does not have cheap access to git's raw stage blobs.** These are treated
  differently:
  > "They have full access to the text of the current file, but not
  > trivial access to files in git."

  Refinement: this does not mean the tool should omit current-file content
  outright — it should still save the model a duplicate tool call when the
  content is small:
  > "our tool can help the model avoid a duplicate tool call for that by
  > providing all the context if it's small"

- **Base/local/remote stage content must be provided, but bounded, with an
  explicit size-limit escape hatch to fetch the rest.**
  > "provide diffs with limits on some context window shown. This way if
  > the diff is tiny there is no overhead of follow-up tool calls. If the
  > diff is big, there is some context and the agent should then make
  > their own call to fetch the content with raw git commands. We should
  > provide everything they'd need to know to make those calls though!"

  Refinement: raw-git access is not a second, tiered mode of this response.
  It is present only when the requested stage region cannot fit within
  `maxStageLines`. Every such omission must say why and give the exact
  retrieval command; a missing diff alone is never an adequate signal.

- **Diffs must be summaries, not full unbounded diffs — they can be
  giant.**
  > "Be careful with diffs - they can be giant. We want to provide
  > summaries only."

  Context must be a locally stable part of that summary. A requested
  base→side diff may include only contiguous equal lines immediately around
  its requested change, up to `contextLines`; it stops before any neighboring
  difference, whether another unresolved conflict or an already-resolved
  change. An unrelated `+`/`-` line must never appear as this conflict's
  context.

- **Diffs should look like a real `git diff`, not an invented format.**
  > "A git diff for the conflicting range is just way nicer. Just do
  > that. It'll include the line numbers even!"

- **Auto-merge suggestions are offered only when the match is exact —
  conservative by design.** If the tool isn't sure, it reports raw data
  instead of a suggestion, never a guess:
  > "we only provide the merge suggestion if the hunk matches exactly...
  > this keeps it conservative. if we aren't sure, we just give the LLM
  > the data we know about."

- **Two distinct groupings of conflict information, not one:**
  1. What Weld's own three-way diff (local vs. base vs. remote — base
     being the merge-base commit, i.e. the one common ancestor, not a
     single diff target) determines to be a genuine conflict.
  2. What the live file on disk currently shows around the requested
     conflict, plus residual damage outside it (stray checked-in marker
     syntax or Weld's `(??)` sentinel). This is not a second rendering of
     the conflict's own marker block: local/remote/base data already convey
     that. It is disk-state information needed to place an edit safely and
     catch unrelated leftovers:
     > "The current conflicts describe hunks that the UI would still mark
     > as red/conflicts... yes, just this."

     This is explicitly **not** a claim that these hunks are still
     unresolved — it's an area worth review, nothing more:
     > "we would document in the schema that these are not necessarily
     > unresolved conflicts; just areas that are possible conflicts and
     > should be reviewed."

- **Residual conflict-marker syntax and Weld sentinels must be reported
  separately** from diff-based hunk detection — but only when outside the
  requested conflict's mapped disk region. These are checked-in markers,
  broken/half-deleted markers, or Weld's own `(??)` sentinel accidentally
  saved, not a re-encoding of the active conflict. Report kind and range,
  not redundant marker body text:
  > "we should list any conflict markers and marker ranges that still
  > remain in the file. These could be checked in markers, broken/
  > half-deleted ones or even the weld merge '??' that the user may have
  > accidentally saved."

- **Disk-backed context and its coordinates are load-bearing.** The agent
  edits the file directly and needs bounded surrounding text from the live
  on-disk file, with exact disk line ranges, to make that edit fit. This is
  deliberately **not** sourced from the GUI comparison opcode model: it is a
  direct `workspace.fs.readFile` snapshot because it answers a different
  question—where an edit can safely be made *now*. Diff `@@` headers
  necessarily use base/local/remote *stage* coordinates and can be stale
  relative to the working tree. The response must label these coordinate
  systems unambiguously and explicitly describe an unavailable or ambiguous
  disk mapping rather than inventing a target range.

- **Both-added conflicts must be distinguishable from an edit conflict.**
  Two unrelated new files colliding at the same path is not the same
  situation as two sides editing a shared file:
  > "does this need to be different than a regular conflict as both sides
  > added a new file from scratch. it's not an edit conflict"

- **No wasted bytes on information the model can derive itself.**
  Standing constraint on every field in this schema:
  > "provided no useful information is lost, yes, implement" (in response
  > to a proposed redundancy cut)

- **Prefer a format the model has already seen in training over inventing
  Weld-specific syntax**, when one already exists for this exact shape
  of problem (paraphrase, generalized from the git-diff instruction above
  and the explicit question below).

## Open design questions — pre-implementation check (2026-08-10)

- Does a standard unified diff, on its own, make it unambiguous which
  lines are "the conflict" vs. surrounding context, or does something
  extra need inventing?
  > "From the diff alone, is it clear which the conflict is or do we need
  > to invent syntax?"

  **Checked against real output.** Built actual scoped `diff -u` hunks for
  an asymmetric conflict in the real `tmp-conflict/file.txt` fixture
  (conflict index 3: local replaced a 2-line base passage with 3 lines,
  remote deleted it entirely — base[27,30) vs local[19,23) vs
  remote[23,23)). Standard `-`/`+`/` ` prefixes made the changed lines
  unambiguous with no extra marker needed. **Settled: no invented syntax
  required**, standard unified diff is sufficient.

  Found a real, separate bug while building the test case: fixed-line-count
  context windows computed independently per side (base/local/remote) can
  land at different offsets when the sides have different lengths near the
  conflict, producing a stray leading `+`/`-` line at the top of a hunk that
  looks like it's still part of the conflict when it's actually a context
  -window artifact. This is an implementation detail to get right in
  whichever shape ships (it would also affect the current `NumberedLine[]`
  shape's context computation) — not a diff-format ambiguity. Fix: compute
  each side's context window independently from where that side's content
  actually stabilizes against its neighbor, not a shared fixed offset.

- How does a two-file unified diff concept extend to the 3-way case (base
  vs. local, base vs. remote — two diffs, not one)?
  > "What about for our conflict suggestion? How would this work with the
  > 3-way merge?"

  **Checked against the same real conflict.** Two independent diffs
  (base→local, base→remote), each self-contained and readable without
  cross-referencing the other — matches the natural mental model of a 3-way
  conflict (same relationship as the `|||||||` base + two alternatives in a
  real git conflict marker block). **Settled: not contorted, this is a
  faithful extension.** One real, small cost: shared context lines are
  necessarily duplicated once across the two diffs (not scaffolding, actual
  content) — accepted, since it's required for each diff to stand alone,
  and it's far smaller than the redundancy already cut from the current
  shape.

Re-verify both against real *tool* output (not just hand-built `diff -u`
runs) once implemented — this was raised as both a pre- and
post-implementation check.

## `weld_list_conflicts` (current)

```
ConflictList = { files: ListedConflict[] }
ListedConflict = {
  repositoryRoot: string, path: string, conflictCount: number,
  kind: "text" | "bothAdded" | "binary" | "deletedByUs" | "deletedByThem"
        | "bothDeleted" | "submodule",
  commits: { local: CommitMetadata, remote: CommitMetadata | null }
}
CommitMetadata = { hash, title }
```

## `weld_get_conflict`, non-text kinds (current)

```
{ type: NonTextConflictKind, repositoryRoot, path, conflictIndex,
  conflictCount: 1, message: string }
```

## `weld_get_conflict`, text kinds (current)

`type` is `"text"` or `"bothAdded"`.

One specific `conflictIndex`:

```
{
  type: "text" | "bothAdded"
  repositoryRoot: string
  path: string
  conflictIndex: number
  conflictCount: number

  base: StageRegionContent      // absent stage: present=false (bothAdded)
  local: StageRegionContent
  remote: StageRegionContent
  changes: { local: StageChange, remote: StageChange }

  current: {
    unresolvedHunks: CurrentHunk[]
    unresolvedHunksTruncated: boolean
    conflictMarkers: ConflictMarker[]
    conflictMarkersTruncated: boolean
  }

  autoMergeSuggestions: CurrentHunk[]
  autoMergeSuggestionsTruncated: boolean
}

StageRegionContent = {
  present: boolean
  range: { startLine, endLineExclusive }
  lines: NumberedLine[]
  contextBefore: NumberedLine[]
  contextAfter: NumberedLine[]
  truncated: boolean
  rawGitAccess: { stage: 1|2|3, command: string } | null
}
NumberedLine = { lineNumber: number, text: string }
StageChange = { tag: DiffChunkTag, baseRange, stageRange }
CurrentHunk = { range: { startLine, endLineExclusive },
                changes: { local: DiffChunkTag|null, remote: DiffChunkTag|null } }
ConflictMarker = { range: { startLine, endLineExclusive }, text: string }
```

`conflictIndex` omitted (whole-file summary, only valid when the file has
zero initial Weld conflicts):

```
{ type: "text" | "bothAdded", repositoryRoot, path, conflictIndex: null,
  conflictCount: 0, current: {...same as above...},
  autoMergeSuggestions, autoMergeSuggestionsTruncated }
```

**Naming gap in the current shape, not yet fixed:** `current.unresolvedHunks`
is misnamed against the requirement above — it must not assert these hunks
are unresolved, only that they are areas the UI would still mark red and
worth review. Rename and re-document when the `(planned)` shape below
replaces this one.

**Directive gap in the current shape, not yet fixed:** it sends marker text
for the requested conflict and does not distinguish stage line coordinates
from the disk coordinates required for a direct edit. The `(planned)` shape
below supersedes it; no source-code change is implied by this document.

## `weld_get_conflict`, text kinds (planned)

Replaces the shape above. Motivation: the current shape pays a JSON object
per line (`NumberedLine`) and repeats the same ranges three times
(`StageRegionContent.range`, `StageChange.baseRange`, `StageChange.stageRange`
are frequently identical numbers). A real measured response for one
conflict in a 63-line file with five conflicts ran to 564 lines of pretty
JSON; even compact, per-line objects and duplicated ranges are pure
scaffolding cost with no information the model doesn't already have from
the range plus a line count.

One specific `conflictIndex`:

```
{
  type: "text" | "bothAdded"
  repositoryRoot: string
  path: string
  conflictIndex: number
  conflictCount: number

  // Unified diff of base->local and base->remote (standard @@ -a,b +c,d @@
  // header, " "/"-"/"+" prefixed body), scoped to this conflict's region plus
  // up to `contextLines` lines of surrounding *stage* context. The @@
  // coordinates are base/local/remote stage coordinates, never disk lines.
  //
  // bothAdded has no base stage, so there is nothing to diff against: local
  // and remote are each sent as plain full text instead (bounded by
  // maxStageLines same as a diff would be). Exactly one pair is present per
  // response, discriminated by `type`.
  localDiff?: string     // type: "text"
  remoteDiff?: string    // type: "text"
  local?: string         // type: "bothAdded"
  remote?: string        // type: "bothAdded"

  // Present exactly when a diff/text was omitted because it exceeded
  // maxStageLines; gives the exact command to fetch that omitted stage.
  localOmitted?: { reason: "exceedsMaxStageLines",
                    rawGitAccess: { stage: 2, command: string } }
  remoteOmitted?: { reason: "exceedsMaxStageLines",
                     rawGitAccess: { stage: 3, command: string } }

  // This conflict's location and surrounding context on disk right now
  // (workspace.fs.readFile, never the VS Code in-memory buffer). Every
  // range in current is a disk-accurate [startLine, endLineExclusive] tuple.
  // These are NOT necessarily still-unresolved conflicts — they are areas
  // worth review, nothing stronger. `target` never invents a range: an
  // unavailable result tells the agent to inspect the file directly.
  current: {
    target: DiskTarget
    possibleConflictHunks?: DiskHunk[] // omitted when empty
    possibleConflictHunksTruncated?: true
    residualMarkers?: ResidualMarker[] // outside target only; omitted when empty
    residualMarkersTruncated?: true
  }

  // Hunks git itself left conflicted (real markers in git's own merge-file
  // output) that Weld's differ can resolve unassisted, offered only when
  // Weld's resolution is an exact, unambiguous match — never a guess.
  // Rendered as the resolved text directly, not a diff — there is no
  // "before" text to diff against, since git could not produce one either.
  autoMergeSuggestions?: Suggestion[] // omitted when empty
  autoMergeSuggestionsTruncated?: true
}

DiskTarget = {
  state: "mapped"
  range: [startLine, endLineExclusive]
  contextBefore?: DiskTextRegion
  contextAfter?: DiskTextRegion
  omitted?: { reason: "exceedsMaxStageLines" }
} | {
  state: "unavailable"
  reason: "notFound" | "ambiguous"
  message: string
}
DiskTextRegion = { range: [startLine, endLineExclusive], text: string }
DiskHunk = { range: [startLine, endLineExclusive],
             local: DiffTag | null, remote: DiffTag | null }
DiffTag = "conflict" | "replace" | "insert" | "delete"
ResidualMarker = { range: [startLine, endLineExclusive],
                   kind: "gitMarker" | "weldSentinel" }
Suggestion = { range: [startLine, endLineExclusive], text: string }
```

`remoteDiff` deliberately uses the same base→side convention as `localDiff`.
The five-pane GUI's right-hand curtain stores Remote→Base chunks because its
left and right endpoints are the Remote and right Base panes. That is a pane
connection detail, not the textual tool convention: the tool normalizes both
diffs so `-` always means text removed from Base and `+` always means text
introduced by the named side.

`DiskTarget.range` deliberately has no target-body text: for the active
conflict, that body would merely re-encode the local/base/remote content in
marker syntax. Its disk-backed context is supplied on either side instead.

Residual scanning groups contiguous Git marker syntax into one range and
reports each Weld sentinel as its own one-line range. A residual range that
overlaps `DiskTarget.range` at all is excluded in full, including a partial
marker block that crosses the target boundary. This simple exclusion rule
avoids reporting any part of the active conflict without requiring a
marker-body comparator.

For a specific `conflictIndex`, `autoMergeSuggestions` is likewise scoped
to that requested conflict. Whole-file summaries can contain all suggestions
because no initial Weld conflict region was requested.

`conflictIndex` omitted (whole-file summary): same as the current shape's
whole-file summary above, minus `localDiff`/`remoteDiff`/`*Omitted`
(there is no single initial-conflict stage region to diff).

### Rationale, planned vs. current

| Current | Planned | Why |
|---|---|---|
| `base`/`local`/`remote`, each `present`+`range`+`lines`/`contextBefore`/`contextAfter` (`NumberedLine[]`)+`truncated`+`rawGitAccess` | `localDiff`/`remoteDiff` strings + explicit `*Omitted` records | A unified diff already encodes its stage ranges (`@@` header), changed vs. context lines (`-`/`+`/` ` prefix), and text in one string. `base` is dropped as a standalone field — it only ever mattered as the diff's "before" side; `bothAdded` is signaled by the diffs being absent, not a boolean. |
| `changes: { local: {tag, baseRange, stageRange}, remote: {...} }` | dropped | `baseRange`/`stageRange` duplicated `base.range`/`local.range`/`remote.range` verbatim; `tag` is implicit in the diff itself (all `+` = insert, all `-` = delete, both = replace), same as reading real `git diff` output. |
| `NumberedLine[]` (`{lineNumber, text}` per line) | plain multi-line strings + a `[start, end]` range | One number pair per block instead of one object per line. |
| `truncated: boolean` + `rawGitAccess: RawGitAccess \| null` | explicit `*Omitted: { reason, rawGitAccess }` | Omission is visible and actionable rather than inferred from a missing diff. |
| `{startLine, endLineExclusive}` | `[startLine, endLineExclusive]` tuple | Half the JSON for the same two numbers while representing insertions without an inverted range. |
| `current.unresolvedHunks` | `current.possibleConflictHunks` | The old name asserted these hunks are unresolved. They are only areas the UI's diff view would mark red — worth review, not confirmed unresolved. |
| `current.conflictMarkers` with literal active-conflict marker text | `current.residualMarkers` with kind and disk range, outside `current.target` | Local/base/remote already describe the requested conflict; only unrelated leftovers add information. |
| stage `contextBefore`/`contextAfter` only | `current.target` plus bounded disk context; unified-diff headers remain stage coordinates | Stage content explains the merge, while disk context and disk ranges make a direct edit safe. |

### Illustrative result shapes

These examples show the field shape only. They are not byte-size fixtures:
repository paths, current disk state, context limits, and the live diff model
all affect serialized length. The executable VS Code integration tests are
the source of truth for normalized wire-byte budgets and useful-content
percentages; those tests must be updated deliberately when this shape changes.

**`weld_list_conflicts`** (illustrative single entry):

```json
{"files":[{"repositoryRoot":"file:///home/pknowles/programming/tmp-conflict","path":"added.txt","conflictCount":1,"kind":"bothAdded","commits":{"local":{"hash":"b6bb4ad","title":"local"},"remote":{"hash":"4248ee6","title":"remote"}}}, ...4 more entries]}
```

**`weld_get_conflict`, `added.txt` (bothAdded):**

```json
{"type":"bothAdded","repositoryRoot":"file:///home/pknowles/programming/tmp-conflict","path":"added.txt","conflictIndex":0,"conflictCount":1,"local":"hello there","remote":"Hello World!","current":{"target":{"state":"mapped","range":[1,5]},"possibleConflictHunks":[{"range":[1,5],"local":"conflict","remote":"conflict"}]}}
```

Actionable as-is: the agent sees the two full alternatives directly (no
base to diff against, so full text is cheap here) and can pick one or
merge both without a follow-up call.

**`weld_get_conflict`, `file.txt` conflictIndex=0 (text):**

```json
{"type":"text","repositoryRoot":"file:///home/pknowles/programming/tmp-conflict","path":"file.txt","conflictIndex":0,"conflictCount":5,"localDiff":"@@ -1,7 +1,7 @@\n # Weld-Merge\n \n Example file for testing.\n-This is the base content.\n+This is the local content.\n \n # 1\n","remoteDiff":"@@ -1,7 +1,7 @@\n # Weld-Merge\n \n Example file for testing.\n-This is the base content.\n+This is the remote content.\n \n # 1\n","current":{"target":{"state":"mapped","range":[4,10],"contextBefore":{"range":[1,3],"text":"# Weld-Merge\n\nExample file for testing."},"contextAfter":{"range":[11,11],"text":"# 1"},"possibleConflictHunks":[{"range":[4,10],"local":"conflict","remote":"conflict"}]}}
```

Actionable as-is: `localDiff`/`remoteDiff` show exactly what each side
changed relative to base in stage coordinates; `current.target.range` and
its disk-backed context identify where a direct edit belongs without
re-sending the active marker body. Optional fields are omitted when empty or
false: absence of `autoMergeSuggestions` means Weld found nothing it can
safely resolve, not that information was lost.

**`weld_get_conflict`, `local_deletes.txt` (deletedByUs):**

```json
{"type":"deletedByUs","repositoryRoot":"file:///home/pknowles/programming/tmp-conflict","path":"local_deletes.txt","conflictIndex":0,"conflictCount":1,"message":"The local side deleted this file while the remote side modified it."}
```

Actionable as-is: unchanged from the current shape, already minimal — no
line content to compress.

**Gap this exercise found and fixed in the schema above:** the earlier
draft said `localDiff`/`remoteDiff` are simply "absent" for `bothAdded`
with no replacement specified. Building a real mock forced the missing
case: added `local`/`remote` as plain full-text fields (bounded the same
way a diff would be) for exactly the `bothAdded` case, where there is no
base to diff against.

**Resolved marker-design gap:** the earlier mock sent a full active marker
block and then tried to avoid the duplication with a "matches cleanly"
comparator. The user's clarification made that comparator unnecessary: the
active block is never useful to send, because local/base/remote and the
disk target range already identify the edit. `residualMarkers` instead
reports only unrelated checked-in/partial Git marker syntax or Weld `(??)`
sentinels outside the mapped target, as a kind plus range. It deliberately
does not send their bodies either; presence and location are the useful
disk-health signal, and the agent can read the file if it needs details.

### Verification before calling this shape final

- Build the actual 3-way unified-diff output (base-vs-local, base-vs-remote)
  against a real captured conflict and confirm, by inspection, that it is
  unambiguous which lines are the conflict without inventing marker syntax
  beyond standard `-`/`+`/` ` prefixes.
- Confirm the two-diff (`localDiff`/`remoteDiff`) framing is a faithful
  extension of the 2-file unified-diff concept to Weld's 3-way merge, not a
  contorted fit.
- Which diff engine produces the `@@` hunks: this codebase's own Myers
  differ (`src/matchers/myers.ts`) rendered as unified-diff text, or shelling
  out to `git diff --no-index`/`diff -u` the way `createGitMergeFileContent`
  already shells out to `git merge-file`? Confirm hunk headers stay accurate
  after `contextLines` trimming either way.
- `autoMergeSuggestions[].text` is resolved content, not a diff (no clean
  "before" exists). Confirm this asymmetry with `localDiff`/`remoteDiff`
  reads clearly rather than confusingly once real responses are seen.
- Confirm the `maxStageLines` truncation/context budget logic still makes
  sense once region+context are one diff string rather than three arrays.
- Repeat the unambiguity check above *after* implementing, against real
  tool output, not just the hand-built example — this was raised as both a
  pre- and post-implementation check.
- Confirm that active-conflict marker syntax is excluded from
  `residualMarkers`, while unrelated complete and partial marker blocks and
  Weld `(??)` sentinels remain reported by kind and disk range.
- Test stage-versus-disk coordinate labelling and disk-backed context after
  edits that diverge from the stage blobs; no mapped target range may be
  fabricated when the mapping is absent or ambiguous.
- Test marker blocks that overlap the target boundary and confirm the
  documented exclusion rule handles them deterministically.
- For a specific `conflictIndex`, confirm auto-merge suggestions are scoped
  to that conflict; only whole-file summaries may contain every suggestion.
