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

import type { Uri } from "vscode";
import {
	type ConflictStages,
	createConflictSnapshot,
	createGitMergeFileContent,
	fetchConflictStages,
	GIT_STAGE_BASE,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	getBaseCommitInfo,
	getCommitInfo,
	getGitState,
	getRemoteRef,
} from "../conflictSnapshot.ts";
import { MyersSequenceMatcher } from "../matchers/myers.ts";
import { createThreeWayChanges } from "../matchers/threeWayDiff.ts";
import type { ConflictedItem } from "../repoContext.ts";
import type { ConflictLabels } from "./conflictLabels.ts";
import type { DiffChunk, PayloadFiles, WebviewPayload } from "./ui/types.ts";

interface BuildDiffPayloadOptions {
	stages?: ConflictStages;
	// The merged pane text that the user will edit and that syncs to the file
	// on disk. On first open this is seeded by createConflictSnapshot(); on
	// re-runs (e.g. after an external .git state change) the caller passes the
	// live TextDocument text so diffs align with what the user currently sees.
	workingContent?: string;
}

const runDiff = (
	localLines: string[],
	workingLines: string[],
	remoteLines: string[],
) => {
	const changes = createThreeWayChanges({
		local: localLines,
		middle: workingLines,
		remote: remoteLines,
	});
	const leftDiffs = changes
		.map((pair) => pair[0])
		.filter((c): c is DiffChunk => c !== null);
	const rightDiffs = changes
		.map((pair) => pair[1])
		.filter((c): c is DiffChunk => c !== null);

	return { leftDiffs, rightDiffs };
};

function buildInitialConflictedState(
	repoUri: Uri,
	stages: ConflictStages,
	labels: ConflictLabels,
): Promise<string> {
	// Re-run git merge-file with the user's current Git config and the same
	// labels from the working file markers. If this exactly matches the file on
	// disk, then the conflicted text is trivially reproducible via Git (for
	// example, `git checkout -m`) and the editor can safely replace it with the
	// auto-merged buffer. If it differs, either the user edited the file or the
	// relevant Git config changed; both cases mean we must preserve the file and
	// ask before replacing it.
	// git merge-file requires real files on disk, so this helper creates a
	// temporary directory and always removes it in the finally block.
	return createGitMergeFileContent(repoUri.fsPath, stages, [
		labels.localLabel,
		labels.kind === "diff3" ? labels.baseLabel : "BASE",
		labels.remoteLabel,
	]);
}

async function buildDiffPayload(
	repoContext: ConflictedItem,
	options: BuildDiffPayloadOptions = {},
): Promise<WebviewPayload["data"]> {
	const { repository } = repoContext;
	const stages = options.stages ?? (await fetchConflictStages(repoContext));
	const { local, remote } = stages;

	const [localCommit, remoteRef] = await Promise.all([
		getCommitInfo(repository, "HEAD"),
		getRemoteRef(repository),
	]);
	const remoteCommit =
		remoteRef === null
			? undefined
			: await getCommitInfo(repository, remoteRef);

	const localLines = local.split("\n");
	const remoteLines = remote.split("\n");

	const workingContent =
		options.workingContent ?? createConflictSnapshot(stages).mergedContent;
	// Diffs are computed against the exact working-pane content we will render.
	// This keeps hunk actions/highlights aligned with what the user sees.
	const workingLines = workingContent.split("\n");

	const { leftDiffs, rightDiffs } = runDiff(
		localLines,
		workingLines,
		remoteLines,
	);

	const contents: PayloadFiles = [
		{ label: "Local", content: local, commit: localCommit },
		{ label: "Merged", content: workingContent },
		{ label: "Remote", content: remote, commit: remoteCommit },
	];

	return {
		files: contents,
		diffs: [leftDiffs, rightDiffs],
		isConflicted: true,
	};
}

async function buildBaseDiffPayload(
	repoContext: ConflictedItem,
	file: Uri,
	side: "left" | "right",
) {
	const { repository } = repoContext;
	// Base is stage 1, Local is 2, Remote is 3
	const targetStage = side === "left" ? GIT_STAGE_LOCAL : GIT_STAGE_REMOTE;
	const [base, target] = await Promise.all([
		getGitState(repository, file, GIT_STAGE_BASE),
		getGitState(repository, file, targetStage),
	]);

	const baseCommit = await getBaseCommitInfo(repository);

	const baseLines = base.split("\n");
	const targetLines = target.split("\n");

	// We only need a 2-way diff for this.
	// For left side (Base -> Local), a=Base, b=Local
	// For right side (Remote <- Base), a=Remote, b=Base
	const seqA = side === "left" ? baseLines : targetLines;
	const seqB = side === "left" ? targetLines : baseLines;

	const matcher = new MyersSequenceMatcher(null, seqA, seqB);
	matcher.initialize();

	const diffs = matcher.getDifferenceOpcodes();

	return {
		command: "loadBaseDiff",
		data: {
			side,
			file: {
				label: "Base",
				content: base,
				commit: baseCommit,
			},
			diffs,
		},
	};
}

export { buildBaseDiffPayload, buildDiffPayload, buildInitialConflictedState };
