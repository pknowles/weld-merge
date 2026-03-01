import * as cp from "node:child_process";
import { MyersSequenceMatcher } from "../matchers/myers";

export async function buildDiffPayload(
	repoPath: string,
	relativeFilePath: string,
) {
	const getGitState = async (stage: number): Promise<string> => {
		return new Promise<string>((resolve) => {
			cp.exec(
				`git show :${stage}:"${relativeFilePath}"`,
				{ cwd: repoPath },
				(err, stdout) => {
					if (err) {
						resolve(""); // return empty string silently if stage doesn't exist
					} else {
						resolve(stdout);
					}
				},
			);
		});
	};

	const base = await getGitState(1);
	const local = await getGitState(2);
	const incoming = await getGitState(3);

	const getCommitInfo = async (
		ref: string,
	): Promise<{ hash: string; title: string } | undefined> => {
		return new Promise((resolve) => {
			cp.exec(
				`git log -1 --format="%H|%s" ${ref}`,
				{ cwd: repoPath },
				(err, stdout) => {
					if (err) {
						resolve(undefined);
					} else {
						const parts = stdout.trim().split("|");
						if (parts.length < 2) resolve(undefined);
						else
							resolve({ hash: parts[0], title: parts.slice(1).join("|") });
					}
				},
			);
		});
	};

	const localCommit = await getCommitInfo("HEAD");
	let incomingCommit = await getCommitInfo("MERGE_HEAD");
	if (!incomingCommit) incomingCommit = await getCommitInfo("CHERRY_PICK_HEAD");
	if (!incomingCommit) incomingCommit = await getCommitInfo("REVERT_HEAD");
	if (!incomingCommit) incomingCommit = await getCommitInfo("REBASE_HEAD");

	const contents = [
		{ label: "Local (Ours)", content: local, commit: localCommit },
		{ label: "Base", content: base },
		{ label: "Incoming (Theirs)", content: incoming, commit: incomingCommit },
	];

	const splitLines = (text: string) => {
		const lines = text.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	};

	const localLines = splitLines(local);
	const baseLines = splitLines(base);
	const incomingLines = splitLines(incoming);

	const getDiff = (linesA: string[], linesB: string[]) => {
		const matcher = new MyersSequenceMatcher(null, linesA, linesB);
		const initGen = matcher.initialise();
		let val = initGen.next();
		while (!val.done) {
			val = initGen.next();
		}
		return matcher.get_opcodes();
	};

	// Diff 0->1 (Local vs Base)
	const diff1 = getDiff(localLines, baseLines);
	// Diff 1->2 (Base vs Incoming)
	const diff2 = getDiff(baseLines, incomingLines);

	return {
		command: "loadDiff",
		data: {
			files: contents,
			diffs: [diff1, diff2],
		},
	};
}
