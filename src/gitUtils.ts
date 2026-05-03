// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { execFile } from "node:child_process";
import { FileType, Uri, workspace } from "vscode";
import { getGitExecutable } from "./gitPath.ts";
import type { GitApiRepository } from "./repoContext.ts";

const LINE_BREAK_REGEX = /\r?\n/;
const WINDOWS_DRIVE_PREFIX_REGEX = /^[A-Za-z]:[\\/]/;
const PATH_SEPARATOR_REGEX = /[\\/]+/;
const GITDIR_POINTER_REGEX = /^gitdir:\s*(.+)$/i;
const ONE_KILOBYTE = 1024;
const TEN_MEGABYTES = 10 * ONE_KILOBYTE * ONE_KILOBYTE;
const MAX_BUFFER_SIZE = TEN_MEGABYTES;

type ConflictOperation =
	| "merge"
	| "cherry-pick"
	| "revert"
	| "rebase-merge"
	| "rebase-apply";

interface ConflictState {
	operation: ConflictOperation;
	otherRef: "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD";
}

const CONFLICT_STATE_FILES: Array<{
	operation: ConflictOperation;
	statePath: string;
	otherRef: ConflictState["otherRef"];
}> = [
	// Order matters: prefer merge/cherry-pick/revert heads before rebase
	// directory sentinels so we resolve to the most specific active operation.
	{ operation: "merge", statePath: "MERGE_HEAD", otherRef: "MERGE_HEAD" },
	{
		operation: "cherry-pick",
		statePath: "CHERRY_PICK_HEAD",
		otherRef: "CHERRY_PICK_HEAD",
	},
	{ operation: "revert", statePath: "REVERT_HEAD", otherRef: "REVERT_HEAD" },
	{
		operation: "rebase-merge",
		statePath: "rebase-merge",
		otherRef: "REBASE_HEAD",
	},
	{
		operation: "rebase-apply",
		statePath: "rebase-apply",
		otherRef: "REBASE_HEAD",
	},
];

const gitDirByRepoUri: Map<string, Uri> = new Map();

function getParentUri(uri: Uri): Uri {
	const path = uri.path;
	const slash = path.lastIndexOf("/");
	const parentPath = slash <= 0 ? "/" : path.slice(0, slash);
	return uri.with({ path: parentPath });
}

function parseGitDirPointer(pointer: string, repoRootUri: Uri): Uri {
	const normalizedPointer = pointer.trim();
	if (normalizedPointer.length === 0) {
		throw new Error(`Empty gitdir pointer for ${repoRootUri.toString()}.`);
	}
	if (normalizedPointer.startsWith("/")) {
		return repoRootUri.with({ path: normalizedPointer });
	}
	if (
		repoRootUri.scheme === "file" &&
		WINDOWS_DRIVE_PREFIX_REGEX.test(normalizedPointer)
	) {
		return Uri.file(normalizedPointer);
	}

	const segments = normalizedPointer
		.split(PATH_SEPARATOR_REGEX)
		.filter((segment) => segment.length > 0);
	return Uri.joinPath(repoRootUri, ...segments);
}

async function getGitDirUri(repository: GitApiRepository): Promise<Uri> {
	const repoKey = repository.rootUri.toString();
	const cachedGitDir = gitDirByRepoUri.get(repoKey);
	if (cachedGitDir) {
		return cachedGitDir;
	}

	const dotGitUri = Uri.joinPath(repository.rootUri, ".git");
	const dotGitStat = await workspace.fs.stat(dotGitUri);
	if (dotGitStat.type & FileType.Directory) {
		gitDirByRepoUri.set(repoKey, dotGitUri);
		return dotGitUri;
	}
	if (dotGitStat.type & FileType.File) {
		const gitPointerFile = await workspace.fs.readFile(dotGitUri);
		const gitPointerText = new TextDecoder("utf-8")
			.decode(gitPointerFile)
			.trim();
		const gitDirMatch = GITDIR_POINTER_REGEX.exec(gitPointerText);
		if (!gitDirMatch?.[1]) {
			throw new Error(
				`Invalid .git pointer in ${dotGitUri.toString()} for ${repoKey}.`,
			);
		}
		const gitDirUri = parseGitDirPointer(
			gitDirMatch[1],
			getParentUri(dotGitUri),
		);
		gitDirByRepoUri.set(repoKey, gitDirUri);
		return gitDirUri;
	}
	throw new Error(`Unsupported .git type for ${repoKey}.`);
}

async function readConflictState(
	repository: GitApiRepository,
): Promise<ConflictState | undefined> {
	const gitDir = await getGitDirUri(repository);
	const stateChecks = await Promise.allSettled(
		CONFLICT_STATE_FILES.map((conflictState) =>
			workspace.fs.stat(Uri.joinPath(gitDir, conflictState.statePath)),
		),
	);
	for (const [index, stateCheck] of stateChecks.entries()) {
		if (stateCheck.status !== "fulfilled") {
			continue;
		}
		const conflictState = CONFLICT_STATE_FILES[index];
		if (conflictState) {
			return {
				operation: conflictState.operation,
				otherRef: conflictState.otherRef,
			};
		}
	}
	return;
}

/**
 * Executes a git command and returns the stdout.
 */
function execGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			getGitExecutable(),
			args,
			{ cwd, maxBuffer: MAX_BUFFER_SIZE },
			(err, stdout) => {
				if (err) {
					reject(err);
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

/**
 * Gets the list of currently conflicted files in a repository.
 */
function getConflictedFiles(repository: GitApiRepository): Uri[] {
	const result: Uri[] = [];
	for (const change of repository.state.mergeChanges) {
		result.push(change.uri);
	}
	return result;
}

/**
 * Checks for unresolved merge conflict markers or (??) markers.
 */
function getUnresolvedReasons(text: string): string[] {
	const reasons: string[] = [];
	const lines = text.split(LINE_BREAK_REGEX);
	const conflictMarkers = ["<<<<<<<", "=======", ">>>>>>>", "|||||||"];

	let hasConflict = false;
	let hasQuestion = false;

	for (const line of lines) {
		if (!hasConflict && conflictMarkers.some((m) => line.startsWith(m))) {
			hasConflict = true;
			reasons.push("merge conflict markers");
		}
		if (!hasQuestion && line.startsWith("(??)")) {
			hasQuestion = true;
			reasons.push("(??) markers");
		}
		if (hasConflict && hasQuestion) {
			break;
		}
	}
	return reasons;
}

export {
	execGit,
	getConflictedFiles,
	getGitDirUri,
	getUnresolvedReasons,
	readConflictState,
};
export type { ConflictState };
