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
  marker scan, commit identifiers.
- `test/vscode/suite/agent-tools.test.ts`: block format, GUI parity, disk
  mapping, elision, stray markers, inline listing, response-size budgets.
