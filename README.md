# Meld Auto-Merge for VS Code

This extension ports the advanced auto-merge heuristics from the popular [Meld](https://meldmerge.org/) visual diff and merge tool directly into VS Code. 

## Purpose

VS Code's built-in Git merge conflict resolution is excellent, but it often gives up and presents conflict markers for situations that are actually automatically resolvable (for example, changes separated by whitespace, or complex insert/delete overlaps that have unambiguous resolutions).

Meld has a robust, highly tuned `AutoMergeDiffer` algorithm written in Python that is capable of automatically resolving these complex conflicts, dramatically saving developers time during painful rebases or merges.

## Design

To achieve native performance and avoid requiring users to install Python or background daemons, we have **ported Meld's core diffing and merging algorithms directly to pure TypeScript**.

This includes:
- `diffutil.ts`: The core sequence management and chunk tracking.
- `myers.ts`: An implementation of the `O(NP)` Myers diff algorithm, complete with Meld's custom inline k-mer matching and syncpoint optimizations.
- `merge.ts`: The 3-way merge logic and the critical Auto-Merge heuristics (such as delete/delete splitting and complex conflict interpolation).

This logic runs entirely inside the VS Code extension host process with zero external dependencies.

## Features (In Development)
- ✨ **Meld: Auto-Merge Current File**: Analyzes standard Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`), extracts the LOCAL, BASE, and REMOTE contents via `git show`, and runs them through the Meld algorithm.
- 🚀 **Checkout -m**: A quick action to reset a botched merge attempt on a file back to its conflicted state.
- 🧠 **Rerere Forget**: Quickly tell Git to forget any automatically recorded resolutions for the current file if they are incorrect.
- ✅ **Smart Add**: A safe `git add` that verifies absolutely no conflict markers accidentally remain in the file.
