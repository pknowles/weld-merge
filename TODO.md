# Future Improvements & Known Issues

## Intuitive usage

- Add a keyboard shortcut to go to the source tree tab with the merge conflict list
- Popup when a merge conflict is first detected?
- Remove vscode default 3-way merge
- Open conflicts with our 3-way editor on click? or at least make the 3-way view more obvious
- Call these out in the readme for first time users

## Prev/Next diff and conflict buttons

Configurable shortcuts to do so. Match Meld's?

Automatically focus on the first conflict when opened (default-on settings
option for this).

## Detect when the user forgot to resolve a conflict and preserve conflict markers

This is a feature meld doesn't have; probably because it's hard.

## Robust Tracking of "Resolved" Files During a Merge

Currently, the extension parses `.git/MERGE_MSG` to determine which files were originally conflicted but have now been resolved (so we can list them in the "Resolved" section of the TreeView and allow users to run `checkout -m` on them).

This is a good heuristic, but `MERGE_MSG` is not 100% reliable as it could potentially be missing, modified, or not cover cherry-picks or specific rebases properly.

A more robust solution for the future is to identify the overlapping files between our current HEAD and the other branch being merged/cherry-picked. The logic in bash looks like this:

```bash
# 1. Identify the 'other' side (Merge or Cherry-pick)
if [ -f .git/MERGE_HEAD ]; then
    OTHER_HEAD="MERGE_HEAD"
elif [ -f .git/CHERRY_PICK_HEAD ]; then
    OTHER_HEAD="CHERRY_PICK_HEAD"
elif [ -f .git/REVERT_HEAD ]; then
    OTHER_HEAD="REVERT_HEAD"
elif [ -d .git/rebase-merge ]; then
    # During a rebase, the commit being applied is usually here:
    OTHER_HEAD=$(cat .git/rebase-merge/stopped-sha)
elif [ -d .git/rebase-apply ]; then
    # During git am, the current patch's SHA is here:
    OTHER_HEAD=$(cat .git/rebase-apply/original-commit)
fi

# 2. Identify the common ancestor
BASE=$(git merge-base HEAD $OTHER_HEAD)

# 3. Find the overlap and reset to conflict state
comm -12 <(git diff --name-only $BASE..HEAD | sort) \
         <(git diff --name-only $BASE..$OTHER_HEAD | sort) \
| xargs git checkout -m
```

This logic can be implemented directly using the VS Code CLI/Node.js to get an exact list of files involved in the complex operation, ensuring accurate resolved tracking in all edge cases. Currently, if parsing fails, we gracefully degrade to just missing the resolved files, guaranteeing that actual conflicted files *always* show up via `git diff --name-only --diff-filter=U`.

## Gemini's Lazy Load Monaco Idea

To solve a possible delay reading a 10MB index.tsx all at once...

*   **Remove Sync Import**: Remove `import * as monaco` in `src/webview/ui/index.tsx`.
*   **Copy Local Files**: Add a build script to copy `node_modules/monaco-editor/min/vs` directly into `out/vs`.
*   **Webview URI Configuration**: Make `MeldWebviewPanel.ts` expose a Webview URI for `out/vs` to the frontend (`window.__MONACO_VS_URI__`).
*   **Configure Loader**: Set `loader.config({ paths: { vs: window.__MONACO_VS_URI__ } })` so Monaco lazy-loads instead of bundling entirely.
*   **Fix Workers**: Fix cross-origin worker issues by returning a Blob in `getWorkerUrl` that uses `importScripts('${window.__MONACO_VS_URI__}/base/worker/workerMain.js')` so bundler plugins are not required.

## Open Blank 3-way merge

For people that want a 3-way merge with copy/pasted content. We'd need to make
all panels editable and maybe default one of the base windows to be open and
share content. What about saving? Vscode has this for 2-way diff and IIRC can
save individual panels. Low !/$.
