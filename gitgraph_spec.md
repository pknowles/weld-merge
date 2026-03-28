# GitGraph Replacement — Design Spec

Replaces `@gitgraph/react` with a custom SVG+HTML renderer.
All visual information is derived from git data; the backend never infers
what git already reports.

**Ownership boundary:**
- **Git owns**: commit order, parent topology, ref names, author metadata.
- **Renderer owns**: lane coordinates, SVG paths, row layout, selection/hover visuals.

The frontend assigns visual lanes only because SVG requires x-coordinates.
It does not re-derive or validate git's ordering — `git log --topo-order --reverse`
already gives a correct topological stream.

---

## 1. Data layer changes

### 1.1 CommitInfo — add `refs`

```ts
interface CommitInfo {
    // existing fields unchanged ...
    refs: string[];   // parsed from %D — git's own decorated names
}
```

`%D` (short form, same as `--decorate=short`) produces comma-separated
entries such as:

| Raw entry | Meaning |
|---|---|
| `HEAD -> main` | HEAD at this commit, pointing to branch `main` |
| `HEAD` | HEAD detached at this commit |
| `main` | local branch |
| `origin/main` | remote-tracking branch |
| `tag: v1.0.0` | annotated or lightweight tag |

These are stored verbatim in `refs[]` and rendered by the graph.
No backend logic classifies them — that is git's job.

### 1.2 `commitLogFormat()` — add `%D` field

Add `%D` between `%P` and `%B` in the format string.
Parse it as the field at index 9; shift `%B` to index 10.

Both `CommitInfo` definitions must be updated — the one in
`src/submoduleConflict.ts` (backend) and the one in
`src/webview/submoduleUi/types.ts` (frontend). The snapshot payload
changes because it contains commits.

Parsing: split on `", "` (comma-space). Git ref names cannot contain
spaces (`git check-ref-format` prohibits them), so this delimiter is
unambiguous. An empty `%D` field produces an empty array.

`parseCommitBlob` should validate that the split produces the expected
field count (11 fields after the addition) and throw with a descriptive
message on mismatch, rather than silently returning defaults.

`SubmoduleConflictSnapshot` itself (the wrapper struct) is unchanged.

---

## 2. Graph component

### 2.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│ [SVG strip, fixed width]  [commit text + badges ─────]   │  ← <button>
│ [SVG strip, fixed width]  [commit text + badges ─────]   │  ← <button>
│ [SVG strip, fixed width]  [Earlier history…          ]   │  ← <div>
└──────────────────────────────────────────────────────────┘
```

- Each commit row is an HTML `<button>` — full-width click target, no gaps.
- The SVG strip is a fixed-width child floated left; text fills the rest.
- All rows share the same SVG strip width (based on max lane count across
  all rows), so the text column starts at the same x-position on every row.
- Row height: `ROW_H = 28px` (constant — no variable-height rows).

### 2.2 Lane assignment algorithm

Process commits **newest-first** (the `commits[]` array is oldest-first
from `--reverse`, so iterate from `commits.length-1` down to `0`).

State: `activeLanes: (LaneState | null)[]`
where `LaneState = { sha: string; colorIdx: number }`.

Each slot `i` holds the SHA the graph is "looking for" next in column `i`
as we scan downward (toward older history).

For each commit:

1. **Find lane**: `lane = activeLanes.findIndex(l => l?.sha === commit.hash)`.
   If `-1`, claim the first `null` slot or extend the array.
   `colorIdx` = existing slot's color, or `nextColorIdx++`.

2. **Find converging lanes**: other slots also containing `commit.hash`.
   These represent other descendant paths that all arrive at this commit.

3. **Snapshot `topLanes`** = copy of `activeLanes` at this point (used for
   SVG line rendering above the dot).

4. **Update activeLanes**:
   - `activeLanes[lane]` = primary parent (if visible) or `null`.
   - Clear all converging lanes → `null`.
   - For each merge parent (parents[1..]) not already tracked:
     claim a free slot or extend array; assign a new `colorIdx`.

5. **Compact** trailing `null` entries.

6. **Snapshot `botLanes`** = copy after updates (used for SVG lines below).

7. **Emit row**: `{ commit, lane, colorIdx, topLanes, botLanes, convergingLanes }`.

### 2.3 SVG per row

SVG is `width = maxLanes * LANE_W + LANE_W/2`, `height = ROW_H`.
Dot is at `cx = lane * LANE_W + LANE_W/2`, `cy = ROW_H/2`.

For each lane index `l` from `0` to `max(topLanes.length, botLanes.length, lane+1)`:

| Condition | Draw |
|---|---|
| `l === lane` and `topLanes[l]` exists | straight line from `(x, 0)` to `(cx, cy)` |
| `l === lane` and `botLanes[l]` exists | straight line from `(cx, cy)` to `(x, ROW_H)` |
| `l` in `convergingLanes` and `topLanes[l]` | Bezier curve from `(x, 0)` to `(cx, cy)` |
| `!topLanes[l]` and `botLanes[l]` | Bezier curve from `(cx, cy)` to `(x, ROW_H)` (new merge parent lane) |
| `topLanes[l]` and `!botLanes[l]` | straight line from `(x, 0)` to `(x, cy)` (lane ends) |
| `topLanes[l]` and `botLanes[l]` | straight vertical through-line `(x, 0)` to `(x, ROW_H)` |

Bezier control points: cubic `C x1 midY x2 midY` where `midY = (y1+y2)/2`.
Dot is drawn last so it sits on top of lines.

### 2.4 "Earlier history" sentinel

After all commit rows, if the oldest visible commit has at least one parent
not in the visible set (`commit.parents.some(p => !visibleShas.has(p))`),
append a non-interactive row:

- SVG: short dashed vertical stubs downward from each active lane's x,
  fading toward the bottom edge.
- Text: "Earlier history…" in muted foreground color.

### 2.5 Colors

Five colors, cycling by `colorIdx % 5`:

```
var(--vscode-charts-blue)
var(--vscode-charts-purple)
var(--vscode-charts-green)
var(--vscode-charts-yellow)
var(--vscode-charts-orange)
```

No red (transparent/invisible in many dark themes). No hard-coded hex values.

---

## 3. Visual features

### 3.1 Commit dots

| State | Appearance |
|---|---|
| Default | Filled circle, `r = DOT_R` (6px), lane color |
| Hovered | Filled circle, `r = DOT_R`, lane color + CSS `filter: brightness(1.15)` via row `:hover` |
| Selected | Filled circle, `r = DOT_R_SEL` (9px), lane color + stroke `var(--vscode-focusBorder)` `2px` |
| Selected + hovered | Selected appearance, brightness filter |

Dot size is controlled by React props (selected = larger `r`) — no DOM
post-processing. The SVG re-renders only when `selectedSha` changes.

### 3.2 Row hover

CSS `:hover` on the `<button>` gives `background: var(--vscode-list-hoverBackground)`.
The brightness filter on the dot is via `button:hover svg circle`.

### 3.3 Row selection

CSS class `.commit-row--selected` gives:
- `background: var(--vscode-list-activeSelectionBackground)`
- `color: var(--vscode-list-activeSelectionForeground)`

The selected row's SVG dot is larger and stroked (React prop-driven, not CSS).

### 3.4 Scroll-to-selected

`useLayoutEffect` on `selectedSha`: query `[data-sha="${selectedSha}"]`,
call `scrollIntoView({ block: "nearest" })`.

---

## 4. Ref decorations

Each commit row renders small inline badges after the commit subject text.

### 4.1 Badge types

| Source | Render | Example |
|---|---|---|
| `refs[]` entry `"HEAD -> branch"` | HEAD chip + branch chip | `⬤ HEAD` + `main` |
| `refs[]` entry `"HEAD"` (detached) | HEAD chip only | `⬤ HEAD` |
| `refs[]` entry `"origin/branch"` | remote branch chip (muted) | `origin/main` |
| `refs[]` entry `"tag: name"` | tag chip (distinct color) | `🏷 v1.0.0` |
| `refs[]` entry (other) | local branch chip | `feature/x` |
| Our Base/Local/Remote labels | distinct pill, higher visual weight | `Base` `Local` `Remote` |

Base/Local/Remote always rendered if the commit matches those SHAs.
They can coexist with git ref badges on the same commit.

### 4.2 Badge rendering

All badges are `<span>` elements inline in the button's HTML text area.
No SVG for badges — they are in the HTML flow and truncate with the text.
Order: git refs first (as git reports them), then our labels.

### 4.3 Parse helpers (frontend)

```ts
type ParsedRef =
    | { kind: 'headBranch'; name: string }  // HEAD -> branchname
    | { kind: 'head' }                      // detached HEAD
    | { kind: 'tag'; name: string }
    | { kind: 'remote'; name: string }
    | { kind: 'branch'; name: string };

function parseRef(raw: string): ParsedRef {
    if (raw.startsWith('HEAD -> '))  return { kind: 'headBranch', name: raw.slice(8) };
    if (raw === 'HEAD')              return { kind: 'head' };
    if (raw.startsWith('tag: '))     return { kind: 'tag', name: raw.slice(5) };
    if (raw.includes('/'))           return { kind: 'remote', name: raw };
    return { kind: 'branch', name: raw };
}
```

---

## 5. Component interface

`GitGraph` keeps the same props interface — no changes to the parent:

```ts
interface GitGraphProps {
    commits: CommitInfo[];   // CommitInfo now has refs[]
    baseSha: string;
    localSha: string;
    remoteSha: string;
    selectedSha: string;
    onSelect: (sha: string) => void;
}
```

---

## 6. Constants (tunable)

```
ROW_H      = 28   px — row height
LANE_W     = 18   px — lane column width
DOT_R      = 6    px — default dot radius
DOT_R_SEL  = 9    px — selected dot radius
LINE_W     = 2    px — branch line stroke width
MAX_ROWS   = 500       — matches git log -n500 cap in backend
```

---

## 7. Out of scope

- Keyboard arrow navigation within the graph (handled by browser focus
  tab order on `<button>` elements).
- Horizontal graph orientation.
- Compact mode (overlapping commits).
- Tooltips (details are in the Details panel to the right).
- Octopus merges with >2 parents (git submodule histories don't produce them
  in practice; the algorithm handles `parents[1..n]` generically anyway).
