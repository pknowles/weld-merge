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

// Minimum marker length, not the exact default (7): git's conflict-marker-size
// gitattribute lets a repo configure any positive integer length, and its
// whole purpose is letting people go LONGER than 7 to disambiguate from
// content that already contains 7-char runs — going shorter than the
// existing 4/9/10 lengths this codebase already tests (see
// makeContextConflictWithMarkerStyle in helpers.ts) is not a realistic
// real-world config. {4,} is deliberately stricter than agentConflicts.ts's
// contextAround/contextStopLine, which treats any run (even length 1) of the
// marker character as "stop rendering context here" — being over-eager
// there only shortens shown context (never wrong), but being over-eager
// here would refuse to stage (or falsely flag) a file over unrelated text
// that merely starts with a single stray marker character.
//
// The fully correct fix would read the actual configured
// conflict-marker-size per file (a `git check-attr conflict-marker-size --
// <path>` call, since it's resolved via gitattributes pattern matching
// across .gitattributes/.git/info/attributes/the global attributes file —
// not a simple config lookup) rather than guessing a length floor. Not done
// here: an extra subprocess call on every stray-marker scan for a config
// nobody in this codebase's test suite or experience has seen set below the
// default. See TODO.md if this floor ever produces a real false negative.
const GIT_MARKER_START_REGEX = /^<{4,}(?:\s|$)/u;
const GIT_MARKER_END_REGEX = /^>{4,}(?:\s|$)/u;
const GIT_MARKER_MIDDLE_REGEX = /^(={4,}|\|{4,})(?:\s|$)/u;
// Anchored to line start, matching the git marker regexes above: getUnresolvedReasons's
// existing, tested contract requires both marker kinds to start the line, so a
// mid-line "prefix (??) also not" is deliberately not flagged (see gitUtils.test.ts).
const WELD_SENTINEL_REGEX = /^\(\?\?\)/u;

/** One-based [startLine, endLineExclusive) in the file on disk. */
type DiskRange = [startLine: number, endLineExclusive: number];

interface StrayMarker {
	range: DiskRange;
	kind: "gitMarker" | "weldSentinel";
}

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

// Git commands take repo-relative, forward-slash paths regardless of
// platform. node:path's `relative` owns the platform-specific fsPath
// semantics (Windows drive letters, separators, casing); this only remaps
// the separator and rejects paths git could misinterpret.
function repositoryRelativePath(rootUri: Uri, fileUri: Uri): string {
	const relativePath = relative(rootUri.fsPath, fileUri.fsPath)
		.split(sep)
		.join("/");
	if (
		relativePath.length === 0 ||
		relativePath.startsWith("../") ||
		relativePath === ".." ||
		relativePath.includes("\n") ||
		relativePath.includes("\t")
	) {
		throw new Error(
			`Cannot use ${fileUri.toString()}: invalid repository path.`,
		);
	}
	return relativePath;
}

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
	const relativePath = repositoryRelativePath(repository.rootUri, file);
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

function strayMarkerRange(start: number, endExclusive: number): DiskRange {
	return [start + 1, endExclusive + 1];
}

/**
 * Scans text for leftover git conflict-marker syntax (`<`/`=`/`>`/`|` runs
 * of 4 or more, matching git's default 7-char markers and every
 * conflict-marker-size this codebase's own tests configure — see
 * GIT_MARKER_START_REGEX's comment for why 4 and not an exact length) and
 * Weld `(??)` sentinels, returning their one-based line ranges. This is the
 * single detector behind both `getUnresolvedReasons` (the interactive Stage
 * Resolved gate) and agentConflicts.ts's `weld_list_conflicts`/
 * `weld_stage_resolved` responses, so the UI and the agent tools can never
 * disagree on what counts as a stray marker. A full `<<<<<<< ... =======
 * ... >>>>>>>` block still left in the file is reported as one range
 * spanning start to end, not three separate single-line entries; a marker
 * line found outside an open block (e.g. a lone leftover `=======`) is its
 * own single-line range.
 */
function scanStrayMarkers(text: string): StrayMarker[] {
	const markers: StrayMarker[] = [];
	let markerStart: number | null = null;
	const lines = text.split(LINE_BREAK_REGEX);
	for (const [index, line] of lines.entries()) {
		if (WELD_SENTINEL_REGEX.test(line)) {
			markers.push({
				range: strayMarkerRange(index, index + 1),
				kind: "weldSentinel",
			});
		}
		if (GIT_MARKER_START_REGEX.test(line)) {
			if (markerStart !== null) {
				markers.push({
					range: strayMarkerRange(markerStart, index),
					kind: "gitMarker",
				});
			}
			markerStart = index;
			continue;
		}
		if (markerStart !== null && GIT_MARKER_END_REGEX.test(line)) {
			markers.push({
				range: strayMarkerRange(markerStart, index + 1),
				kind: "gitMarker",
			});
			markerStart = null;
			continue;
		}
		if (markerStart === null && GIT_MARKER_MIDDLE_REGEX.test(line)) {
			markers.push({
				range: strayMarkerRange(index, index + 1),
				kind: "gitMarker",
			});
		}
	}
	if (markerStart !== null) {
		markers.push({
			range: strayMarkerRange(markerStart, lines.length),
			kind: "gitMarker",
		});
	}
	return markers;
}

/**
 * Checks for unresolved merge conflict markers or (??) markers, as coarse
 * reason strings for the interactive Stage Resolved error message. Derived
 * from scanStrayMarkers rather than its own text scan so this can never
 * disagree with the agent tools' stray-marker detection.
 */
function getUnresolvedReasons(text: string): string[] {
	const markers = scanStrayMarkers(text);
	const reasons: string[] = [];
	if (markers.some((marker) => marker.kind === "gitMarker")) {
		reasons.push("merge conflict markers");
	}
	if (markers.some((marker) => marker.kind === "weldSentinel")) {
		reasons.push("(??) markers");
	}
	return reasons;
}

export type { ConflictState, DiskRange, StrayMarker };
export {
	describeConflictStatusEvidence,
	execGit,
	execGitWithInput,
	getErrorMessage,
	getGitDirUri,
	getUnresolvedReasons,
	parseGitDirPointer,
	readConflictState,
	readIndexStageContent,
	repositoryRelativePath,
	scanStrayMarkers,
};
