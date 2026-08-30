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
contextual, multi-conflict, both-added, and truncated responses. They also
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
  conflictCount: number;
  kind: ConflictKind;
  commits: {
    local: { hash: string; title: string };
    remote: { hash: string; title: string } | null;
  };
};
```

Use a listed `repositoryRoot`, `path`, and `conflictIndex` with
`weld_get_conflict`.

## `weld_get_conflict`

Every response contains this identity information:

```ts
type ConflictIdentity = {
  type: ConflictKind;
  repositoryRoot: string;
  path: string;
  conflictIndex: number | null;
  conflictCount: number;
};
```

`conflictIndex` is `null` only for a whole-file summary: a text or
both-added file with no initial Weld conflict region. A requested numeric
index fails clearly when it is stale or out of range.

For a whole-file summary, `current` and any exact
`autoMergeSuggestions` have the same meanings as below, but no stage diff or
stage text is returned because there is no single conflict region to show:

```ts
type WholeFileSummary = ConflictIdentity & {
  type: "text" | "bothAdded";
  conflictIndex: null;
  conflictCount: 0;
  current: CurrentConflict;
  autoMergeSuggestions?: Suggestion[];
  autoMergeSuggestionsTruncated?: true;
};
```

### Text and both-added conflicts

```ts
type TextConflict = ConflictIdentity & {
  type: "text" | "bothAdded";

  // Present for type: "text". Each is a Base → named-side unified diff.
  localDiff?: string;
  remoteDiff?: string;

  // Present for type: "bothAdded", which has no Base stage.
  local?: string;
  remote?: string;

  // Present only when the corresponding diff/text exceeds maxStageLines.
  localOmitted?: OmittedStageContent;
  remoteOmitted?: OmittedStageContent;

  current: CurrentConflict;
  autoMergeSuggestions?: Suggestion[];
  autoMergeSuggestionsTruncated?: true;
};

type OmittedStageContent = {
  reason: "exceedsMaxStageLines";
  rawGitAccess: { stage: 2 | 3; command: string };
};

type CurrentConflict = {
  target: DiskTarget;
  // Omitted when empty. These are areas worth reviewing, not a claim that
  // they remain unresolved.
  possibleConflictHunks?: DiskHunk[];
  possibleConflictHunksTruncated?: true;
  // Omitted when empty; active-target markers are excluded.
  residualMarkers?: ResidualMarker[];
  residualMarkersTruncated?: true;
};

type DiskTarget =
  | {
      state: "mapped";
      range: DiskRange;
      contextBefore?: DiskTextRegion;
      contextAfter?: DiskTextRegion;
      omitted?: { reason: "exceedsMaxStageLines" };
    }
  | {
      state: "unavailable";
      reason: "notFound" | "ambiguous";
      message: string;
    };

type DiskRange = [startLine: number, endLineExclusive: number];
type DiskTextRegion = { range: DiskRange; text: string };
type DiskHunk = {
  range: DiskRange;
  local: "conflict" | "replace" | "insert" | "delete" | null;
  remote: "conflict" | "replace" | "insert" | "delete" | null;
};
type ResidualMarker = { range: DiskRange; kind: "gitMarker" | "weldSentinel" };
type Suggestion = { range: DiskRange; text: string };
```

`localDiff` and `remoteDiff` always use Base → side direction. In both, `-`
means text removed from Base and `+` means text introduced by the named side.
The GUI internally connects the Remote and right Base panes in the opposite
order; that display detail does not change the textual convention.

Unified-diff `@@` line numbers are stage coordinates. All `DiskRange` values
are one-based, end-exclusive coordinates in the current file on disk.

If a stage region is too large, its diff/text is omitted and `rawGitAccess`
contains the exact `git show` command to retrieve it. This is explicit rather
than silently truncating the response.

`DiskTarget` does not repeat the active marker body. The diffs already show
the alternatives; `contextBefore` and `contextAfter` provide the live nearby
text needed to fit an edit. A target becomes unavailable rather than guessing
when the stages no longer map uniquely to the live file.

`residualMarkers` reports only marker syntax or Weld sentinels outside the
active target. It intentionally omits their body text; a range and kind are
enough to signal that the agent should inspect that location.

`autoMergeSuggestions` is resolved text that Weld can produce exactly and
without guessing. For a numbered conflict it is limited to that conflict.

### Non-text conflicts

```ts
type NonTextConflict = ConflictIdentity & {
  type: "binary" | "deletedByUs" | "deletedByThem" | "bothDeleted" | "submodule";
  conflictCount: 1;
  message: string;
};
```

Non-text conflicts have one whole-file conflict and require
`conflictIndex: 0`.

## Examples

These examples illustrate the response shape. Exact lengths vary by
repository URI, current disk content, and requested context; the integration
tests, not these examples, enforce response-size limits.

`weld_get_conflict` for a normal text conflict:

```json
{
  "type": "text",
  "repositoryRoot": "file:///repository",
  "path": "src/example.ts",
  "conflictIndex": 0,
  "conflictCount": 1,
  "localDiff": "@@ -4,3 +4,3 @@\n export function value() {\n-  return base;\n+  return local;\n }",
  "remoteDiff": "@@ -4,3 +4,3 @@\n export function value() {\n-  return base;\n+  return remote;\n }",
  "current": {
    "target": {
      "state": "mapped",
      "range": [4, 10],
      "contextBefore": { "range": [3, 4], "text": "export function value() {" },
      "contextAfter": { "range": [10, 11], "text": "}" }
    },
    "possibleConflictHunks": [
      { "range": [4, 10], "local": "conflict", "remote": "conflict" }
    ]
  }
}
```

`weld_get_conflict` for a both-added conflict:

```json
{
  "type": "bothAdded",
  "repositoryRoot": "file:///repository",
  "path": "new-file.txt",
  "conflictIndex": 0,
  "conflictCount": 1,
  "local": "local version\n",
  "remote": "remote version\n",
  "current": {
    "target": { "state": "mapped", "range": [1, 5] },
    "possibleConflictHunks": [
      { "range": [1, 5], "local": "conflict", "remote": "conflict" }
    ]
  }
}
```

## Implementation and test references

- `src/conflictSnapshot.ts`: shared two-way and three-way comparison models.
- `src/webview/diffPayload.ts`: GUI payloads built from those models.
- `src/agentConflicts.ts`: compact agent response and live disk target.
- `test/vscode/suite/agent-tools.test.ts`: GUI parity, scoped diffs,
  response-size, omission, and disk-coordinate integration tests.
