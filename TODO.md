# Future Improvements & Known Issues



## 5-Way merge

I'd like to add buttons to our custom merge view that add extra columns. currently we have 3: Local, Merged, Incoming. I want a button on the left of the Local that toggles a new "Base" column to the left. An equivalent button on the right of the "Incoming" title also toggles a new "Base" column to the right. Toggling both makes 5 columns total so you have:
Base, Local, Merged, Remote, Base

## Highlight characters that differ within changed lines differently

## Detect when the user forgot to resolve a conflict and preserve conflict markers

This is a feature meld doesn't have; probably because it's hard.

## Local and Remote Commit Cards

Clicking on the commit (local/remote) doesn't navigate me anywhere. is this because vscode doesn't have a way to do that? when I open up "Source Control" -> "Graph" and hover over a commit, I see a neat card displayed with the commit details. I can copy/paste from taht (select/copy) and it has a copy-commit shortcut. Is this reusable by an extension or would we have to write our own to do that?

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
