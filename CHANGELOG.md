# Changelog

## [0.0.8]

### Added
- New test cases that only verify the algorithm, not the UI.

### Fixed
- Copy file contents on blur... *tableflip*
- Silent fallback to base contents

## [0.0.8] - 2026-03-28

### Added
- **Submodule Conflict Resolution**: Fully interactive submodule merge conflict UI for resolving git index conflicts by selecting specific commits.
- **GitGraph Integration**: Integrated a topologically accurate commit DAG visualization to navigate local, remote, and base submodule states.
- **Mock Testing Harness**: Added a standalone webview test environment in `test/webview/` for rapid UI iteration and mocking of extension-host messages.

## [0.0.7] - 2026-03-26

### Added
- **Benchmarking Suite**: Implemented high-precision, profiler-based benchmarking infrastructure with adaptive duration formatting.
- **Fuzz Testing**: Integrated Jazzer.js for structure-aware fuzzing of core diffing and merging components.
- **Stress Testing**: Added E2E survival stress tests and comprehensive UI validation to ensure deterministic merge logic.
- **Viewport Connection Filtering**: Optimized rendering by selectively drawing connectors only within the active viewport.
- **Regression Tests**: Added high-value tests for `merge.ts`, `scrollMapping.ts`, and incremental edit parity against the original Python Meld backend.

### Changed
- **Rebranding**: Officially renamed the project to **Weld Merge**, updating all UI elements and extension metadata.
- **Performance**: Surgical UI optimizations, including removal of scroll-induced "render storms" and build minification.
- **Scroll Engine**: Unified scroll mapping to a smooth-only proportional engine, removing the legacy discrete mode.
- **Infrastructure**: Setup comprehensive testing environment with coverage and mutation testing (Stryker) ratchets.
- **Refactoring**: Webview modularization and strict linting compliance.

### Fixed
- **Stability**: Resolved multiple `DiffCurtain` out-of-bounds crashes and connection accumulation issues.
- **Consistency**: Fixed a critical incremental diff consistency bug in `Differ._changeSequence`.
- **Layout**: Fixed animation glitches and layout stability in "Compare to Base" panels.
- **Git Integration**: Reverted to sequential auto-merge to avoid git index locks during batch operations.
- **UI**: Fixed reversed connectors in 5-panel view and addressed nested button errors.
- **Dependencies**: Updated project dependencies.

## [0.0.6] - 2026-03-15

### Added
- **Performance Analysis**: Conducted initial performance profiling and analysis of git command execution and webview rendering.

### Fixed
- **Scroll Synchronization**: Fixed regression in synchronized scrolling logic (temporary/quick fix for boundary conditions).

## [0.0.5] - 2026-03-07

### Added
- **5-Way Merge View**: Integrated two optional "Base" comparison columns for Local and Remote panes, allowing Stage 2 and 3 to be compared against Stage 1 (Base) in a single unified view.
- **Navigation Shortcuts**: Added `Alt+Up`/`Down` for diff navigation and `Ctrl+J`/`K` for conflict navigation in the Merged editor.
- **Auto-Focus**: Automatically focuses the first conflict when opening the merge editor.
- **Notifications**: "Meld: N merge conflicts detected" and link when conflicts first detected
- **N-Way Scroll Sync**: Implemented a robust chaining algorithm for proportional scrolling across any number of active panes.
- **Smooth Interpolation**: Introduced a new scroll mapping engine that ensures smooth, continuous transitions even through highly disproportionate diff chunks.
- **Unit Tests**: Added comprehensive test coverage for line mapping and multi-pane synchronization logic.
- **Focus Shortcut**: Added `Alt+M` (or `Cmd+Alt+M` on Mac) to quickly focus the **Weld Merge : Conflicted Files** view in the Source Control panel.
- **Default Editor Action**: Added "Open File (Default Editor)" as a context menu option for conflicted files.

### Changed
- **UI Architecture**: Transitioned to a dynamic animated layout that adjusts between 3 and 5 columns.
- **Diff Curtains**: Enhanced Bezier connections with smooth fade-in/out animations and precise vertical alignment using a resize-observer based offset calculation.
- **Conflicted Files UI**: Simplified the conflict list by moving advanced actions (Auto-Merge, Checkout, Rerere, VS Code Merge) to a right-click context menu.
- **Default Click Action**: Clicking a conflicted file now opens it directly in the Meld 3-way merge editor.
- **Improved Tooltips**: Updated action titles and tooltips for better clarity in the Source Control panel.

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
- **Settings**: Added configurable debounce delay (`weld.mergeEditor.debounceDelay`) and syntax highlighting toggles.

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
