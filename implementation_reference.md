# Implementation Reference

## Core Algorithms (The "Meld" Port)
Found in `src/matchers/`. High-performance, side-effect-free TypeScript logic.
- **`myers.ts`**: `O(NP)` diffing algorithm with Meld-style k-mer matching.
- **`diffutil.ts`**: Advanced sequence management, chunk tracking, and alignment logic.
- **`merge.ts`**: 3-way merge logic and `AutoMergeDiffer` heuristics.
- **`gitTextMerger.ts`**: Entry point for running the 3-way merge on raw text strings.

## Extension Host (VS Code Plumbing)
Entry point and Git integration.
- **`extension.ts`**: Extension lifecycle, command registrations, and workspace event handling.
- **`gitUtils.ts`**: Extracts `LOCAL`, `BASE`, and `REMOTE` text contents from Git objects.
- **`treeView.ts`**: Implementation of the "Conflicted Files" view in the SCM panel.
- **`webview/meldWebviewPanel.ts`**: Manages the custom editor lifecycle, lifecycle of the Webview, and message passing.

## Webview UI (React Frontend)
Located in `src/webview/ui/`.
- **`App.tsx`**: Main UI container, state orchestration, and message bus handling.
- **`CodePane.tsx`**: Individual editor panels (Monaco integration).
- **`DiffCurtain.tsx`**: SVG-based connecting lines ("curtains") and action buttons between panels.
- **`meldPane.tsx`**: High-level layout for a 3-panel merge view.

## Frontend Logic & Synchronization
- **`appHooks.ts`**: React hooks for overall application state and message handling.
- **`useSynchronizedScrolling.ts`**: Logic for proportional scrolling across differently sized diff chunks.
- **`scrollMapping.ts`**: Calculations for mapping line indices between Local/Base/Remote/Merged.
- **`highlightUtil.ts`**: Logic for generating Monaco-compatible line decorations from diff chunks.
- **`editorActions.ts`**: Functions for modifying text content in response to UI actions (arrows/crosses).
