// In-memory store for the "initial git conflict" side of a Compare view.
//
// When the user chooses Compare after we detect their working-tree file has
// drifted from the auto-merge result, we need to present the original
// conflicted text (from `git merge-file -p`) in a VS Code diff tab. Rather
// than writing a temp file, we keep that content in memory here and serve it
// via a TextDocumentContentProvider registered for the custom URI scheme.
//
// Keys are the full stringified form of the conflict URI (i.e. the Uri the
// content provider will be queried with). Callers are responsible for
// constructing that URI — typically by taking the original document URI and
// swapping its scheme to INITIAL_CONFLICT_SCHEME. Using the canonical
// Uri.toString() on both sides means we never have to worry about which
// characters Uri.parse does or doesn't decode.
//
// This module is deliberately vscode-free so it is trivially unit-testable.

const INITIAL_CONFLICT_SCHEME_CONST = "weld-initial-conflict";

const store = new Map<string, string>();

const setInitialConflictContentImpl = (
	conflictUri: string,
	content: string,
): void => {
	store.set(conflictUri, content);
};

const deleteInitialConflictContentImpl = (conflictUri: string): void => {
	store.delete(conflictUri);
};

const getInitialConflictContentImpl = (conflictUri: string): string => {
	const content = store.get(conflictUri);
	if (content === undefined) {
		throw new Error(
			`No initial conflict content registered for URI "${conflictUri}".`,
		);
	}
	return content;
};

export const INITIAL_CONFLICT_SCHEME = INITIAL_CONFLICT_SCHEME_CONST;
export const setInitialConflictContent = setInitialConflictContentImpl;
export const deleteInitialConflictContent = deleteInitialConflictContentImpl;
export const getInitialConflictContent = getInitialConflictContentImpl;
