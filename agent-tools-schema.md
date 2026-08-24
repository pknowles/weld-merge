# Weld agent tools

This document describes the responses returned by Weld's VS Code language
model tools. It reflects `src/agentConflicts.ts`.

## Purpose

Weld's merge editor identifies the small regions that still need a decision
and shows how Local and Remote each differ from Base. The agent tools provide
the same information as a compact text response:

- they select one conflict rather than sending a whole file;
- they use the same comparison data as the merge editor and its Base views;
- they show Base → Local and Base → Remote as standard unified diffs;
- they include immediately adjacent equal lines to check syntax and whitespace;
- they give a live on-disk location and nearby text for a safe direct edit.

They do not implement a second diff algorithm or a separate definition of a
conflict. The source lines, change chunks, and conflict membership come from
the same `ConflictSnapshot` comparison models used by the GUI.

The live disk target is deliberately different: it is read with
`workspace.fs.readFile` because it answers where an edit can safely be made
now. It can differ from the Git stages shown in the diffs.

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
