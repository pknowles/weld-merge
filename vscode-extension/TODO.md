# Future Improvements & Known Issues

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
