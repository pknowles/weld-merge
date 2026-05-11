# Performance Optimization Plan

This document outlines three key performance optimizations to the incremental diffing and synchronization pipeline, focusing on eliminating hidden $O(N)$ operations and unnecessary memory allocations.

## Proposed Changes

---

### 1. Eliminating $O(N)$ Line Cache Allocations via Binary Search

**Problem:** 
The 3-way differ currently contains a hidden $O(N)$ full-file operation that runs on every keystroke, causing significant garbage collection pressure and latency on very large files.

**How it happens:**
When `differ.changeSequence` is called during an edit, it triggers `_updateMergeCacheOnSequenceChange`, which ultimately calls `_updateLineCache()`. This method pre-allocates five arrays (one for each pane/sequence) mapping every single line number in the file to its corresponding diff chunk (`new Array(seqLength + 1).fill(...)`). For a 50,000 line file, this allocates and fills 250,000 array elements per keystroke.

**Fix Concept:**
Replace the $O(N)$ array pre-allocation with an $O(\log C)$ on-demand binary search (where $C$ is the number of diff chunks).

**Recommended Implementation:**
- Delete `_lineCache`, `_updateLineCache()`, `_updateLineCacheForChunk()`, and `_fillRemainingLineCache()` from `src/matchers/diffutil.ts`.
- Rewrite `locateChunk(pane: number, line: number): LineCacheEntry` to perform a binary search over `_mergeCache`. Since chunks are strictly ordered sequentially by line number, the binary search can quickly find the chunk bounds encompassing the requested `line` index.
- Return the `[foundIndex, prevIndex, nextIndex]` directly from the search result.

**Benchmarking Improvement:**
- **Current test:** `test/benchmarking/ui_stress.test.ts` (if it exists) likely tests small files.
- **New Benchmark:** Add a `webview_survival_stress.test` scenario that loads a 50,000+ line file with thousands of diff chunks. Simulate 500+ continuous single-character typing edits. Measure time-per-edit and garbage collection pauses. The new approach should yield a massive reduction in memory allocation and stable, flat latency regardless of file size.

---

### 2. Zero-Allocation Line Break Counting

**Problem:** 
Counting line breaks allocates unnecessary memory.

**How it happens:**
In `src/webview/ui/mergedPaneEdits.ts`, the `countLineBreaks(text)` function is implemented as `text.split("\n").length - 1`. When applying Monaco `ContentChange` events (e.g., pasting a large block of text), this splits the inserted text into a brand new string array just to read its length, which is then immediately thrown away.

**Fix Concept:**
Count line break characters using manual string iteration to avoid array allocation.

**Recommended Implementation:**
- Replace the split-based implementation in `mergedPaneEdits.ts` with a standard `for` loop:
  ```typescript
  const countLineBreaks = (text: string): number => {
      let count = 0;
      for (let i = 0; i < text.length; i++) {
          if (text[i] === "\n") count++;
      }
      return count;
  };
  ```

**Benchmarking Improvement:**
- **New Benchmark:** Add a stress test specifically targeting the `applyMeldStyleContentChanges` pipeline. Simulate large paste operations (e.g., pasting a 10,000-line string) and measure the JS heap size delta and execution time.

---

### 3. Enforcing Pre-Computed `lines` in `FileState`

**Problem:** 
Repeatedly parsing lines during highlighting computations.

**How it happens:**
`FileState` allows `lines?: string[]` to be optional. During render cycles, functions like `calculateReplaceHighlights` in `highlightUtil.ts` rely on `getFileLines(file)`, which falls back to `file.content.split('\n')` if the array is missing. This results in heavy string splitting being redundantly executed on the main thread during UI renders.

**Fix Concept:**
Guarantee that the `lines` array is fully populated exactly once upon file initialization, allowing downstream components to treat it as guaranteed.

**Recommended Implementation:**
- Update `src/webview/ui/types.ts` to make `lines: string[]` a required field in the `FileState` interface.
- Find the root instantiation points (e.g., where `DiffPayload` is received from the VS Code host in `src/webview/ui/App.tsx` or `appHooks.ts`) and ensure `lines: content.split('\n')` is explicitly computed when the file state is constructed.
- Remove the optional chaining and fallback logic from `getFileLines` in `highlightUtil.ts` (or remove `getFileLines` entirely in favor of directly accessing `file.lines`).

**Benchmarking Improvement:**
- **New Benchmark:** Measure the render time of the highlight computations specifically when a file first loads or undergoes a massive full-recompute. Tracking the exact number of `.split('\n')` calls via a spy could ensure we've eliminated redundant parsing.

---

## User Review Required

Does this accurately reflect the optimization goals? Should we proceed with executing these changes and building out the corresponding benchmark tests?
