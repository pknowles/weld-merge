// In-memory store for the "initial git conflict" side of a Compare view.
//
// When the user chose Compare after we detected their working-tree file had
// drifted from the auto-merge result, we need to present the original
// conflicted text (from `git merge-file -p`) in a VS Code diff tab. Rather
// than writing a temp file, we keep that content in memory here and serve it
// via a TextDocumentContentProvider registered for the custom URI scheme.
//
// This module is deliberately vscode-free: it deals in plain string keys so
// it is trivially unit-testable. The caller (meldWebviewPanel) is responsible
// for building the key from a document Uri.

const INITIAL_CONFLICT_SCHEME_CONST = "weld-initial-conflict";

const store = new Map<string, string>();

const makeInitialConflictKeyImpl = (documentUriString: string): string =>
	encodeURIComponent(documentUriString);

const setInitialConflictContentImpl = (
	documentUriString: string,
	content: string,
): string => {
	const key = makeInitialConflictKeyImpl(documentUriString);
	store.set(key, content);
	return key;
};

const clearInitialConflictContentImpl = (documentUriString: string): void => {
	const key = makeInitialConflictKeyImpl(documentUriString);
	store.delete(key);
};

const getInitialConflictContentImpl = (key: string): string => {
	const content = store.get(key);
	if (content === undefined) {
		throw new Error(
			`No initial conflict content registered for key "${key}".`,
		);
	}
	return content;
};

export const INITIAL_CONFLICT_SCHEME = INITIAL_CONFLICT_SCHEME_CONST;
export const makeInitialConflictKey = makeInitialConflictKeyImpl;
export const setInitialConflictContent = setInitialConflictContentImpl;
export const clearInitialConflictContent = clearInitialConflictContentImpl;
export const getInitialConflictContent = getInitialConflictContentImpl;
