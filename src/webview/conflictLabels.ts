// Parse Git conflict-marker labels from working-tree text.
//
// Git does not persist the human-readable conflict labels (HEAD, common
// ancestor, remote branch) in .git metadata. The only source that lets us
// reproduce `git merge-file` output byte-for-byte is the markers embedded in
// the file itself on disk.

const LOCAL_LABEL_REGEX = /^<<<<<<< (.*)$/m;
const BASE_LABEL_REGEX = /^\|\|\|\|\|\|\| (.*)$/m;
const REMOTE_LABEL_REGEX = /^>>>>>>> (.*)$/m;

interface NormalConflictLabels {
	kind: "normal";
	localLabel: string;
	remoteLabel: string;
}

interface Diff3ConflictLabels {
	kind: "diff3";
	localLabel: string;
	baseLabel: string;
	remoteLabel: string;
}

export type ConflictLabels = NormalConflictLabels | Diff3ConflictLabels;

export const extractConflictLabels = (
	docText: string,
): ConflictLabels | null => {
	const localLabel = docText.match(LOCAL_LABEL_REGEX)?.[1];
	const baseLabel = docText.match(BASE_LABEL_REGEX)?.[1];
	const remoteLabel = docText.match(REMOTE_LABEL_REGEX)?.[1];
	if (!(localLabel && remoteLabel)) {
		return null;
	}
	if (baseLabel) {
		return { kind: "diff3", localLabel, baseLabel, remoteLabel };
	}
	return { kind: "normal", localLabel, remoteLabel };
};
