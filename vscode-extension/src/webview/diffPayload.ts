import * as cp from "node:child_process";
import { Merger } from "../matchers/merge";
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

	// Run the auto-merger to produce the merged text for the middle column
	const merger = new Merger();
	const sequences = [localLines, baseLines, incomingLines];
	const initGen = merger.initialize(sequences, sequences);
	let val = initGen.next();
	while (!val.done) {
		val = initGen.next();
	}

	const mergeGen = merger.merge_3_files(true);
	let mergedContent = base; // fallback to base if merge fails
	for (const res of mergeGen) {
		if (res !== null && typeof res === "string") {
			mergedContent = res;
		}
	}

	const mergedLines = splitLines(mergedContent);

	// Build a Set of unresolved (conflict) line indices in the merged text
	// for fast lookup when marking diff chunks as conflicts
	const unresolvedSet = new Set(merger.differ.unresolved);

	const contents = [
		{ label: "Local (Ours)", content: local, commit: localCommit },
		{ label: "Merged", content: mergedContent },
		{ label: "Incoming (Theirs)", content: incoming, commit: incomingCommit },
	];

	const getDiff = (linesA: string[], linesB: string[]) => {
		const matcher = new MyersSequenceMatcher(null, linesA, linesB);
		const initGen = matcher.initialise();
		let val = initGen.next();
		while (!val.done) {
			val = initGen.next();
		}
		return matcher.get_opcodes();
	};

	// Mark diff chunks as 'conflict' if their merged-side line range
	// overlaps with unresolved lines from the three-way merge.
	// Two-way Myers diffs can't produce 'conflict' tags, so we inject
	// them based on the merge result.
	const markConflicts = (
		opcodes: ReturnType<typeof getDiff>,
		mergedStart: "start_a" | "start_b",
		mergedEnd: "end_a" | "end_b",
	) => {
		return opcodes.map((chunk) => {
			if (chunk.tag === "equal") return chunk;
			for (let i = chunk[mergedStart]; i < chunk[mergedEnd]; i++) {
				if (unresolvedSet.has(i)) {
					return { ...chunk, tag: "conflict" as const };
				}
			}
			return chunk;
		});
	};

	// diffs[0]: a=Local(pane0), b=Merged(pane1) — merged side is b
	const diff1 = markConflicts(getDiff(localLines, mergedLines), "start_b", "end_b");
	// diffs[1]: a=Merged(pane1), b=Incoming(pane2) — merged side is a
	const diff2 = markConflicts(getDiff(mergedLines, incomingLines), "start_a", "end_a");

	return {
		command: "loadDiff",
		data: {
			files: contents,
			diffs: [diff1, diff2],
		},
	};
}
