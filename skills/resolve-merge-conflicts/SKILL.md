---
name: resolve-merge-conflicts
description: Resolve conflicts from a git merge/rebase/cherry-pick using Weld Merge to quickly inspect conflict blocks. No need to call git, parse conflict blocks or match local/remote blocks manually.
---

# Weld Merge Tooling

1. Call `weld_apply_automerge_all`. It's cheap, conservative and can occasionally resolves conflicts that git does not.
2. If conflicts remain, `weld_list_conflicts` can quickly show what's left. These need resolving by editing files like any other. Small results include diffs directly. If the resolution of the intent of both sides is clear it can be written directly. Due to the diff algorithm, some blocks may still be listed as conflicted after you have resolved them. The result reports remaining conflict markers.
3. Larger conflicts require a separate `weld_get_conflict` call. Passing `includeBaseDiffs: true` is recommended to see diffs of both branches and understand their separate intent that needs combining.
4. Verify there are no more conflict markers and the intent of both branches is maintained so that features from both branches still work - see General Conflict Resolution. Use `git range-diff` to make sure only expected changes exist, only once resolution commit(s) exist.
5. Continue with the user's instructions.

# General Conflict Resolution

Ask "what result preserves the intended changes from both histories?" The intended resolution is often apparent from the two changes, e.g. applying the diff/pattern from both sides. Don't blindly pick between local (ours/current), remote (theirs/incoming/cherry-picked/replayed/merging) or both changes from the conflicted block. Some cases require understanding the full intent and rewriting the conflicted block to fulfil both - beyond simply choosing sides. Seeing diffs against the base/common ancestor state makes this much easier. The value of Weld Merge is to make resolution trivial with quick context for these simpler cases. In rare cases, broader changes across areas of code that did not conflict are required - watch out for indications these are needed inside conflict blocks.

Prefer resolving the source inputs and regenerating checked-in generated files rather than manually merging generated files.

If conflicts are severe, it may be an indication of an earlier mistake and worth a sanity check before blindly resolving conflicts. E.g. histories with duplicates or cherry-picking in the wrong order.
