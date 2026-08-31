// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { execFile, spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { FileType, Uri, workspace } from "vscode";
import { getGitExecutable } from "./gitPath.ts";
import type { ConflictedItem, GitApiRepository } from "./repoContext.ts";
import { getGitStatusName } from "./repoContext.ts";

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

const GIT_STAGE_BASE = 1;
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;

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
			(err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(
							`git ${args.join(" ")} failed: ${stderr || err.message}`,
							{ cause: err },
						),
					);
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

function execGitWithInput(
	args: string[],
	cwd: string,
	input: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(getGitExecutable(), args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(stdoutChunks).toString("utf8"));
				return;
			}
			reject(
				new Error(
					`git ${args.join(" ")} failed with exit code ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`,
				),
			);
		});
		child.stdin.end(input);
	});
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Git commands take repo-relative, forward-slash paths regardless of
// platform. node:path's `relative` owns the platform-specific fsPath
// semantics (Windows drive letters, separators, casing); this only remaps
// the separator and rejects paths git could misinterpret.
function getRepoRelativePath(rootUri: Uri, fileUri: Uri): string {
	const repoRelativePath = relative(rootUri.fsPath, fileUri.fsPath)
		.split(sep)
		.join("/");
	if (
		repoRelativePath.length === 0 ||
		repoRelativePath.startsWith("../") ||
		repoRelativePath === ".." ||
		repoRelativePath.includes("\n") ||
		repoRelativePath.includes("\t")
	) {
		throw new Error(
			`Cannot use ${fileUri.toString()}: invalid repository path.`,
		);
	}
	return repoRelativePath;
}

// Returns the content of an unmerged index stage exactly as Git's checkout
// would write it to the worktree: filtered through `core.autocrlf`,
// `.gitattributes` eol/text, and any smudge filters. This is required for
// conflict-stage content to compare and diff correctly against the on-disk
// document, which VS Code/Git wrote through those same filters (notably on
// Windows, where checkout produces CRLF but index blobs are LF). The VS Code
// Git API's `repository.show` returns the raw, unfiltered blob instead, which
// is why this bypasses it for stage content despite the project's general
// preference for the Git API over raw git (see implementation_reference.md).
//
// Falls back to `repository.show` only when git itself could not be spawned
// (a string syscall error code such as ENOENT/EACCES from execFile) — an
// environment lacking a git binary never ran a checkout smudge in the first
// place, so the raw index blob already equals the worktree form there. Any
// other failure (bad path, missing stage, dead repo) is a real git error and
// is rethrown unmodified so callers see git's stderr; it must never fall
// back silently, since that would reintroduce this exact CRLF bug.
async function readIndexStageContent(
	repository: GitApiRepository,
	file: Uri,
	stage: number,
): Promise<string> {
	const relativePath = getRepoRelativePath(repository.rootUri, file);
	try {
		return await execGit(
			["cat-file", "--filters", `:${stage}:${relativePath}`],
			repository.rootUri.fsPath,
		);
	} catch (error: unknown) {
		const spawnErrorCode = (error as { cause?: { code?: unknown } })?.cause
			?.code;
		if (typeof spawnErrorCode === "string") {
			return await repository.show(`:${stage}`, file.fsPath);
		}
		throw error;
	}
}

async function getStageDebugLine(
	repository: GitApiRepository,
	file: Uri,
	stage: number,
): Promise<string> {
	try {
		const content = await readIndexStageContent(repository, file, stage);
		return `stage ${stage}: present (${content.length} bytes)`;
	} catch (error: unknown) {
		return `stage ${stage}: missing (${getErrorMessage(error)})`;
	}
}

async function describeConflictStatusEvidence(
	conflictedItem: ConflictedItem,
): Promise<string> {
	const { repository, uri, mergeChange } = conflictedItem;
	const statusLine = mergeChange
		? `status=${mergeChange.status} (${getGitStatusName(mergeChange.status)})`
		: "status=<missing mergeChanges entry>";
	const stageLines = await Promise.all(
		[GIT_STAGE_BASE, GIT_STAGE_LOCAL, GIT_STAGE_REMOTE].map((stage) =>
			getStageDebugLine(repository, uri, stage),
		),
	);
	return [
		"Weld conflict status diagnostic",
		`file=${uri.toString()}`,
		`root=${repository.rootUri.toString()}`,
		`mergeChangeUri=${mergeChange?.uri.toString() ?? "<none>"}`,
		statusLine,
		...stageLines,
	].join("\n");
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

export type { ConflictState };
export {
	describeConflictStatusEvidence,
	execGit,
	execGitWithInput,
	getGitDirUri,
	getUnresolvedReasons,
	getRepoRelativePath,
	readConflictState,
	readIndexStageContent,
};
