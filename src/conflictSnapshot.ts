// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Merger } from "./matchers/merge.ts";
import type { ThreeWayChange } from "./matchers/threeWayDiff.ts";
import type { ConflictedItem, GitApiRepository } from "./repoContext.ts";
import { GitStatus } from "./repoContext.ts";

const GIT_STAGE_BASE = 1;
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;

interface ConflictStages {
	base: string;
	local: string;
	remote: string;
}

interface ConflictSnapshot {
	stages: ConflictStages;
	lines: {
		base: string[];
		local: string[];
		remote: string[];
	};
	mergedContent: string;
	changes: ThreeWayChange[];
	conflictChangeIndexes: number[];
}

function getGitState(
	repository: GitApiRepository,
	file: ConflictedItem["uri"],
	stage: number,
): Promise<string> {
	return repository.show(`:${stage}`, file.fsPath);
}

async function fetchConflictStages(
	conflictedItem: ConflictedItem,
): Promise<ConflictStages> {
	const { repository, uri } = conflictedItem;
	const isBothAdded =
		conflictedItem.mergeChange?.status === GitStatus.BOTH_ADDED;
	const [base, local, remote] = await Promise.all([
		isBothAdded ? "" : getGitState(repository, uri, GIT_STAGE_BASE),
		getGitState(repository, uri, GIT_STAGE_LOCAL),
		getGitState(repository, uri, GIT_STAGE_REMOTE),
	]);
	return { base, local, remote };
}

function createConflictSnapshot(stages: ConflictStages): ConflictSnapshot {
	const lines = {
		base: stages.base.split("\n"),
		local: stages.local.split("\n"),
		remote: stages.remote.split("\n"),
	};
	const sequences = [lines.local, lines.base, lines.remote];
	const merger = new Merger();
	merger.initialize(sequences, sequences);
	const changes = merger.differ.allChanges();
	const conflictChangeIndexes = merger.differ.conflicts.slice();
	const mergedContent = merger.merge3Files(true);
	return { stages, lines, mergedContent, changes, conflictChangeIndexes };
}

export type { ConflictStages };
export {
	createConflictSnapshot,
	fetchConflictStages,
	GIT_STAGE_BASE,
	GIT_STAGE_LOCAL,
	GIT_STAGE_REMOTE,
	getGitState,
};
