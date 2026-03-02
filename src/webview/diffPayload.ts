// Copyright (C) 2002-2006 Stephen Kennedy <stevek@gnome.org>
// Copyright (C) 2009-2019 Kai Willadsen <kai.willadsen@gmail.com>
// Copyright (C) 2026 Pyarelal Knowles
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 2 of the License, or (at
// your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as cp from "node:child_process";
import { Differ } from "../matchers/diffutil";
import { Merger } from "../matchers/merge";

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
	): Promise<
		| {
				hash: string;
				title: string;
				authorName: string;
				authorEmail: string;
				date: string;
				body: string;
		  }
		| undefined
	> => {
		return new Promise((resolve) => {
			cp.exec(
				`git log -1 --format="%H%x00%s%x00%an%x00%ae%x00%aI%x00%b" ${ref}`,
				{ cwd: repoPath },
				(err, stdout) => {
					if (err) {
						resolve(undefined);
					} else {
						const parts = stdout.trim().split("\0");
						if (parts.length < 5) resolve(undefined);
						else
							resolve({
								hash: parts[0],
								title: parts[1],
								authorName: parts[2],
								authorEmail: parts[3],
								date: parts[4],
								body: parts.slice(5).join("\0"),
							});
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

	// Step 1: Run the Merger to produce merged text with (??) conflict markers
	// This matches Meld's _merge_files() in filediff.py
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

	// Step 2: Initialize the Differ with [Local, Merged, Incoming]
	// This matches Meld's _diff_files() in filediff.py, which runs AFTER
	// _merge_files() has placed the merged text in the middle buffer.
	// set_sequences_iter computes diffs as matcher(sequences[1], sequences[i*2])
	// so the Differ diffs Merged(a) vs Local(b) and Merged(a) vs Incoming(b).
	// The three-way _auto_merge logic naturally produces 'conflict' tags.
	const differ = new Differ();
	const diffSequences = [localLines, mergedLines, incomingLines];
	const diffInit = differ.set_sequences_iter(diffSequences);
	let step = diffInit.next();
	while (!step.done) {
		step = diffInit.next();
	}

	const contents = [
		{ label: "Local (Ours)", content: local, commit: localCommit },
		{ label: "Merged", content: mergedContent },
		{ label: "Incoming (Theirs)", content: incoming, commit: incomingCommit },
	];

	// Extract from _merge_cache, not differ.diffs.
	// differ.diffs is raw Myers output (replace/insert/delete/equal only).
	// conflict tags only exist in _merge_cache, produced by _merge_diffs/_auto_merge.
	// This matches what Meld's pair_changes() method yields for rendering.
	// _merge_cache[i] = [chunk_for_diffs0 | null, chunk_for_diffs1 | null]
	// These chunks have a=Merged(pane1), b=Outer(Local or Incoming).
	const leftDiffs = differ._merge_cache
		.map((pair) => pair[0])
		.filter((c): c is NonNullable<typeof c> => c !== null);
	const rightDiffs = differ._merge_cache
		.map((pair) => pair[1])
		.filter((c): c is NonNullable<typeof c> => c !== null);

	return {
		command: "loadDiff",
		data: {
			files: contents,
			diffs: [leftDiffs, rightDiffs],
		},
	};
}
