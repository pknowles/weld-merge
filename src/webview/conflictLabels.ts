// Parse Git conflict-marker labels from working-tree text.
//
// Git does not persist the human-readable conflict labels (HEAD, common
// ancestor, remote branch) in .git metadata. The only source that lets us
// reproduce `git merge-file` output byte-for-byte is the markers embedded in
// the file itself on disk.

const LOCAL_LABEL_REGEX = /^<<<<<<< (.*)$/m;
const BASE_LABEL_REGEX = /^\|\|\|\|\|\|\| (.*)$/m;
const REMOTE_LABEL_REGEX = /^>>>>>>> (.*)$/m;

export interface ConflictLabels {
	localLabel: string;
	baseLabel: string;
	remoteLabel: string;
}

export const extractConflictLabels = (
	docText: string,
): ConflictLabels | null => {
	const localLabel = docText.match(LOCAL_LABEL_REGEX)?.[1];
	const baseLabel = docText.match(BASE_LABEL_REGEX)?.[1];
	const remoteLabel = docText.match(REMOTE_LABEL_REGEX)?.[1];
	if (!(localLabel && baseLabel && remoteLabel)) {
		return null;
	}
	return { localLabel, baseLabel, remoteLabel };
};
