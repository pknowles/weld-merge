# Changelog

## [Unreleased]

### Added
- None

### Changed
- None

### Fixed
- None

## [0.0.5] - 2026-03-07

### Added
- **5-Way Merge View**: Integrated two optional "Base" comparison columns for Local and Remote panes, allowing Stage 2 and 3 to be compared against Stage 1 (Base) in a single unified view.
- **Navigation Shortcuts**: Added `Alt+Up`/`Down` for diff navigation and `Ctrl+J`/`K` for conflict navigation in the Merged editor.
- **Auto-Focus**: Automatically focuses the first conflict when opening the merge editor.
- **N-Way Scroll Sync**: Implemented a robust chaining algorithm for proportional scrolling across any number of active panes.
- **Smooth Interpolation**: Introduced a new scroll mapping engine that ensures smooth, continuous transitions even through highly disproportionate diff chunks.
- **Unit Tests**: Added comprehensive test coverage for line mapping and multi-pane synchronization logic.

### Changed
- **UI Architecture**: Transitioned to a dynamic animated layout that adjusts between 3 and 5 columns.
- **Diff Curtains**: Enhanced Bezier connections with smooth fade-in/out animations and precise vertical alignment using a resize-observer based offset calculation.

### Fixed
- **Animation Glitches**: Fixed flickering and "zombie" connection lines occurring when toggling side panels.
- **Sync Issues**: Resolved corner cases where scrolling would become jittery or throw errors at file boundaries.

## [0.0.4] - 2026-03-03

### Changed
- **perf**: Parallelize Git stage content fetching to improve load times.
- **refactor**: Separate `App.tsx` scrolling and messaging logic into reusable React hooks.

### Fixed
- **security**: Prevent command injection vulnerabilities by executing `git` commands with `execFile`.
- **build**: Bundle `monaco-editor` securely for offline use without CDN dependencies.
- **docs**: Updated documentation with more accurate instructions.

## [0.0.3] - 2026-03-02

### Added
- **Clipboard**: Added cut, copy, paste functionality to the diff viewer, including inline diff highlighting.
- **Icons**: Added the official Gnome Meld app icon to the VS Code extension.
- **CI**: Added continuous integration workflow.

### Changed
- **Config**: Restored marketplace name and updated `.vscodeignore` exclusions.
- **Docs**: Overhauled README with screenshots, clearer features list, credits, and license sections.

## [0.0.2] - 2026-03-01

### Added
- **Merge Actions**: Add interactable chunk actions (push, copy, delete) to directly apply diff chunks.
- **N-Way Diff Viewer**: Advanced Webview UI containing N-way Monaco CodePanes and Meld-style connecting Bezier curves as a `DiffCurtain`.
- **Merge Editing**: Middle column automatically pre-populates with merged results and highlights conflict chunks.
- **Context Toolbar**: Added "Save" and "Save & Complete Merge" buttons that trigger git add when resolving conflicts.
- **Settings**: Added configurable debounce delay (`meld.mergeEditor.debounceDelay`) and syntax highlighting toggles.

### Changed
- **Architecture**: Transitions to `CustomTextEditorProvider` for native VS Code document lifecycle management.
- **Git Sync**: Sync webview to base text document to mirror external updates cleanly and avoid infinite write loops.
- **Commands**: Refactored `checkoutConflicted` to use `WorkspaceEdit` for more robust opening operations.

### Fixed
- **Sync Issues**: Fixed webview synchronisation by adding an explicit refresh option and using `externalSyncId`.
- **Cursor State**: Fixed editor sync logic and cursor jumping by implementing minimal structural edits in the CodePane using diffLines.

## [0.0.1] - 2026-02-23

### Added
- **Extension UI**: Added "Conflicted Files" TreeView interface to discover and access ongoing conflicts.
- **Merge Engine**: Initialized the VS Code extension with a TypeScript port of the Python Meld text merging engine.
- **QoL**: Quality-of-life Git wrapper commands integrated as extension commands like "Auto-Merge Current File" and "Git Add Resolved".
- **E2E Tests**: Full automated E2E test parity directly ported from the original Meld Python test suite.
- **Conflict Markers**: Added accurate trailing newline logic to complete git conflict markers parsing in the auto-merger.
