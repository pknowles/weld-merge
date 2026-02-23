# Meld Auto-Merge for VS Code

This extension brings the power of [Meld's](https://meldmerge.org/) advanced 3-way auto-merge heuristics directly into Visual Studio Code. It is designed to automatically resolve complex merge conflicts that standard Git tools often give up on.

## Why Use This?

VS Code's built-in Git conflict resolution is excellent, but it often presents conflict markers for situations that are actually automatically resolvable. Meld has a robust, highly-tuned algorithm capable of:
- Resolving changes separated by whitespace.
- Handling complex insert/delete overlaps with unambiguous resolutions.
- Automatically interpolating conflict blocks to find common ground.

## Features

### ✨ Meld: Auto-Merge Current File
The core command of this extension. It extracts the **LOCAL**, **BASE**, and **REMOTE** versions of the current conflicted file via Git and runs them through the Meld `AutoMergeDiffer`. It then applies the merged result directly to your editor, leaving only the truly unresolvable conflicts for you to handle manually.

### 🛠️ Quality of Life Git Tools
- 🚀 **Meld: Checkout Conflicted (-m)**: Quickly reset a botched merge attempt in the active file back to its original conflicted state with `git checkout -m`.
- 🧠 **Meld: Rerere Forget File**: Tell Git to forget any automatically recorded resolution for the current file using `git rerere forget`.
- 🔍 **Meld: List Conflicted Files**: See a list of all current merge conflicts in your repository and jump directly to them.
- ✅ **Meld: Smart Git Add**: A safer `git add` that verifies absolutely no conflict markers (`<<<<<<<`) remain in the file before staging it.

## How It Works

To ensure maximum performance and zero external dependencies, we have **ported Meld's core Python logic to pure TypeScript**.

This includes:
- **`myers.ts`**: A high-performance `O(NP)` diff algorithm with Meld's custom k-mer inline matching.
- **`diffutil.ts`**: Advanced sequence management and chunk tracking.
- **`merge.ts`**: The 3-way merge logic and powerful `AutoMergeDiffer` heuristics.

The logic runs entirely within the VS Code extension host process—no Python installation or background daemons required.

## Getting Started

1. Open a file with Git merge conflicts.
2. Open the Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`).
3. Type **"Meld: Auto-Merge Current File"**.
4. Watch as the Meld heuristics resolve the manageable conflicts for you!

## Developer Setup

To run this extension locally for development or testing:

1. **Clone the repository.**
2. **Navigate to the extension directory**:
   ```bash
   cd vscode-extension
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Compile the extension**:
   ```bash
   npm run compile
   ```
5. **Launch in VS Code**:
   - Open the `vscode-extension` folder in VS Code.
   - Press `F5` to open a new "Extension Development Host" window with the extension loaded.

## Running Tests

We use Jest to verify the TypeScript port against Meld's original logic:

```bash
cd vscode-extension
npm test
```

