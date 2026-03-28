// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { basename, relative, sep } from "node:path";
import { Uri } from "vscode";
import { execGit, execGitWithInput, readConflictState } from "./gitUtils.ts";
import type { GitApiRepository } from "./repoContext.ts";

const GITLINK_MODE = "160000";
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";
const STAGE_BASE = 1;
const STAGE_LOCAL = 2;
const STAGE_REMOTE = 3;
const SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const SHA_PREFIX_REGEX = /^[0-9a-fA-F]{4,40}$/;
const RAW_DIFF_REGEX = /^:(\d{6}) (\d{6}) [0-9a-fA-F]+ [0-9a-fA-F]+ [A-Z]/;
const LS_TREE_ENTRY_REGEX = /^(\d{6})\s+\S+\s+[0-9a-fA-F]+\t/;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LOG_RECORD_SEPARATOR = "\x00";
const LOG_FIELD_SEPARATOR = "\x01";
const LOG_RECORD_SEPARATOR_FORMAT = "%x00";
const LOG_FIELD_SEPARATOR_FORMAT = "%x01";
const PRE_BASE_CONTEXT_COMMITS = 20;

interface SubmoduleStageShas {
	base: string;
	local: string;
	remote: string;
}

interface ChangedFile {
	path: string;
	status: string;
}

interface CommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
	message: string;
	authorName: string;
	authorEmail: string;
	authorDate: string;
	committerName: string;
	committerEmail: string;
	committerDate: string;
	parents: string[];
	refs: string[];
	files: ChangedFile[] | null;
}

interface SubmoduleConflictSnapshot {
	submoduleName: string;
	repositoryRoot: string;
	submodulePath: string;
	base: string;
	local: string;
	remote: string;
	selected: string;
	commits: CommitInfo[];
}

interface SubmoduleConflictIdentity {
	repositoryRoot: Uri;
	submodulePath: string;
}

type CommitLogFields = [
	hash: string,
	shortHash: string,
	authorName: string,
	authorEmail: string,
	authorDate: string,
	committerName: string,
	committerEmail: string,
	committerDate: string,
	rawParents: string,
	rawRefs: string,
	rawBody: string,
];

class SubmoduleConflictUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SubmoduleConflictUnavailableError";
	}
}

class SubmoduleConflict {
	readonly repository: GitApiRepository;
	readonly uri: Uri;
	readonly repoRelativePath: string;
	readonly shas: SubmoduleStageShas;

	private constructor(
		repository: GitApiRepository,
		uri: Uri,
		repoRelativePath: string,
		shas: SubmoduleStageShas,
	) {
		this.repository = repository;
		this.uri = uri;
		this.repoRelativePath = repoRelativePath;
		this.shas = shas;
	}

	/**
	 * Submodule conflicts are represented in Git's index as gitlink entries
	 * (mode 160000), not as text file contents. VS Code's Git API reliably
	 * gives us repository lifecycle and merge-change paths, but it cannot read
	 * gitlink stage object IDs: `repository.show(":2", path)` fails because the
	 * staged value is a commit SHA from another repository, not a blob in the
	 * parent. This boundary is the single place that validates "is this path a
	 * live submodule conflict?" and the only place that uses raw Git for
	 * gitlink stage/index plumbing. We intentionally avoid `git ls-files`; the
	 * candidate path comes from the VS Code Git API and the raw commands are
	 * path-scoped checks or writes for that one gitlink. Read-only history
	 * helpers lower in this module also shell out inside the submodule
	 * repository because the VS Code Git API has no graph/search/file-list API
	 * for an arbitrary nested repository.
	 */
	static async load(
		repository: GitApiRepository,
		submoduleUri: Uri,
	): Promise<SubmoduleConflict> {
		const repoRelativePath = getRepoRelativePath(
			repository.rootUri,
			submoduleUri,
		);
		const mergeChange = repository.state.mergeChanges.find(
			(change) => change.uri.toString() === submoduleUri.toString(),
		);
		if (!mergeChange) {
			throw new SubmoduleConflictUnavailableError(
				`Submodule conflict is no longer active for ${repoRelativePath}.`,
			);
		}
		await assertGitlinkConflict(repository, repoRelativePath);
		const shas = await readStagedSubmoduleShas(
			repository,
			repoRelativePath,
		);
		return new SubmoduleConflict(
			repository,
			submoduleUri,
			repoRelativePath,
			shas,
		);
	}

	static async restore(
		repository: GitApiRepository,
		submoduleUri: Uri,
	): Promise<void> {
		const repoRelativePath = getRepoRelativePath(
			repository.rootUri,
			submoduleUri,
		);
		const conflictState = await readConflictState(repository);
		if (!conflictState) {
			throw new Error(
				`Cannot restore ${repoRelativePath}: no active merge/cherry-pick/rebase state found.`,
			);
		}
		// Git does not keep the old unmerged gitlink entries after a user stages
		// a resolved submodule. For merge conflicts we can reconstruct them from
		// HEAD, MERGE_HEAD, and their merge base. Cherry-pick/revert submodule
		// restores follow the same conflict-state abstraction used by text-file
		// restore; if Git reports a non-merge operation here, the base entry is
		// necessarily best-effort because the original staged gitlink base is no
		// longer exposed by the VS Code Git API.
		const parentMergeBase = await repository.getMergeBase(
			"HEAD",
			conflictState.otherRef,
		);
		const [baseSha, localSha, remoteSha] = await Promise.all([
			readSubmoduleShaAtRef(
				repository,
				parentMergeBase,
				repoRelativePath,
			),
			readSubmoduleShaAtRef(repository, "HEAD", repoRelativePath),
			readSubmoduleShaAtRef(
				repository,
				conflictState.otherRef,
				repoRelativePath,
			),
		]);
		if (localSha === null && remoteSha === null) {
			throw new Error(
				`Cannot restore ${repoRelativePath}: neither side has a submodule entry.`,
			);
		}
		await removeResolvedIndexEntry(repository, repoRelativePath);
		await writeSubmoduleIndexStages(repository, repoRelativePath, {
			base: baseSha,
			local: localSha,
			remote: remoteSha,
		});
	}

	async buildSnapshot(): Promise<SubmoduleConflictSnapshot> {
		const commits = await readCommitWindow(this);
		return {
			submoduleName: basename(this.repoRelativePath),
			repositoryRoot: this.repository.rootUri.toString(),
			submodulePath: this.repoRelativePath,
			base: this.shas.base,
			local: this.shas.local,
			remote: this.shas.remote,
			selected: this.shas.local,
			commits,
		};
	}

	async stage(sha: string): Promise<void> {
		if (!SHA_REGEX.test(sha)) {
			throw new Error(
				`Cannot stage invalid submodule commit SHA: ${sha}`,
			);
		}
		await assertSubmoduleCommitExists(this, sha);
		await execGit(
			["update-index", "--force-remove", "--", this.repoRelativePath],
			this.repository.rootUri.fsPath,
		);
		await execGit(
			[
				"update-index",
				"--add",
				"--cacheinfo",
				GITLINK_MODE,
				sha,
				this.repoRelativePath,
			],
			this.repository.rootUri.fsPath,
		);
	}

	submoduleRepoPath(): string {
		return Uri.joinPath(
			this.repository.rootUri,
			...this.repoRelativePath.split("/"),
		).fsPath;
	}
}

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

async function isSubmoduleGitlinkChange(
	repository: GitApiRepository,
	submoduleUri: Uri,
): Promise<boolean> {
	const repoRelativePath = getRepoRelativePath(
		repository.rootUri,
		submoduleUri,
	);
	const rawDiff = await execGit(
		["diff", "--raw", "HEAD", "--", repoRelativePath],
		repository.rootUri.fsPath,
	);
	const match = RAW_DIFF_REGEX.exec(rawDiff.trim());
	return Boolean(
		match?.[1] &&
			match[2] &&
			(match[1] === GITLINK_MODE || match[2] === GITLINK_MODE),
	);
}

async function isActiveSubmoduleGitlinkConflict(
	repository: GitApiRepository,
	submoduleUri: Uri,
): Promise<boolean> {
	const mergeChange = repository.state.mergeChanges.find(
		(change) => change.uri.toString() === submoduleUri.toString(),
	);
	if (!mergeChange) {
		return false;
	}
	const repoRelativePath = getRepoRelativePath(
		repository.rootUri,
		submoduleUri,
	);
	try {
		await assertGitlinkConflict(repository, repoRelativePath);
		return true;
	} catch (error: unknown) {
		if (error instanceof SubmoduleConflictUnavailableError) {
			return false;
		}
		throw error;
	}
}

async function isKnownSubmoduleConflictPath(
	repository: GitApiRepository,
	submoduleUri: Uri,
): Promise<boolean> {
	// Resolved conflicts may no longer differ from HEAD if the user stages the
	// local gitlink, so classification cannot rely on the current index diff.
	// MERGE_MSG gives us the original path; the active operation refs tell us
	// whether that path was a gitlink in the conflict being resolved.
	const repoRelativePath = getRepoRelativePath(
		repository.rootUri,
		submoduleUri,
	);
	const conflictState = await readConflictState(repository);
	if (!conflictState) {
		return false;
	}
	const parentMergeBase = await repository.getMergeBase(
		"HEAD",
		conflictState.otherRef,
	);
	const modes = await Promise.all([
		readTreeMode(repository, parentMergeBase, repoRelativePath),
		readTreeMode(repository, "HEAD", repoRelativePath),
		readTreeMode(repository, conflictState.otherRef, repoRelativePath),
	]);
	return modes.some((mode) => mode === GITLINK_MODE);
}

function submoduleUriFromIdentity(identity: SubmoduleConflictIdentity): Uri {
	return Uri.joinPath(
		identity.repositoryRoot,
		...identity.submodulePath.split("/"),
	);
}

function submoduleConflictUri(identity: SubmoduleConflictIdentity): Uri {
	const params = new URLSearchParams({
		repositoryRoot: identity.repositoryRoot.toString(),
		submodulePath: identity.submodulePath,
	});
	return Uri.from({
		scheme: "weld-submodule-conflict",
		path: `/${basename(identity.submodulePath)}.weld-submodule-conflict`,
		query: params.toString(),
	});
}

function parseSubmoduleConflictUri(uri: Uri): SubmoduleConflictIdentity {
	const params = new URLSearchParams(uri.query);
	const repositoryRoot = params.get("repositoryRoot");
	const submodulePath = params.get("submodulePath");
	if (!(repositoryRoot && submodulePath)) {
		throw new Error(`Invalid submodule conflict URI: ${uri.toString()}`);
	}
	return {
		repositoryRoot: Uri.parse(repositoryRoot),
		submodulePath,
	};
}

async function assertGitlinkConflict(
	repository: GitApiRepository,
	repoRelativePath: string,
): Promise<void> {
	const rawDiff = await readRawGitlinkConflictDiff(
		repository,
		repoRelativePath,
	);
	const match = RAW_DIFF_REGEX.exec(rawDiff.trim());
	if (!(match?.[1] && match[2])) {
		throw new SubmoduleConflictUnavailableError(
			`${repoRelativePath} is not an active Git conflict.`,
		);
	}
	if (match[1] !== GITLINK_MODE && match[2] !== GITLINK_MODE) {
		throw new SubmoduleConflictUnavailableError(
			`${repoRelativePath} is not a submodule conflict.`,
		);
	}
}

async function readRawGitlinkConflictDiff(
	repository: GitApiRepository,
	repoRelativePath: string,
): Promise<string> {
	try {
		return await execGit(
			["diff", "--raw", "--", repoRelativePath],
			repository.rootUri.fsPath,
		);
	} catch (error: unknown) {
		throw new Error(
			`Cannot inspect submodule conflict state for ${repoRelativePath}.`,
			{ cause: error },
		);
	}
}

async function readStageSha(
	repository: GitApiRepository,
	repoRelativePath: string,
	stage: number,
): Promise<string> {
	const output = await execGit(
		["rev-parse", "--verify", `:${stage}:${repoRelativePath}`],
		repository.rootUri.fsPath,
	);
	const sha = output.trim();
	if (!SHA_REGEX.test(sha)) {
		throw new Error(
			`Stage ${stage} for ${repoRelativePath} is not a commit SHA: ${sha}`,
		);
	}
	return sha;
}

async function readStagedSubmoduleShas(
	repository: GitApiRepository,
	repoRelativePath: string,
): Promise<SubmoduleStageShas> {
	const [base, local, remote] = await Promise.all([
		readStageSha(repository, repoRelativePath, STAGE_BASE),
		readStageSha(repository, repoRelativePath, STAGE_LOCAL),
		readStageSha(repository, repoRelativePath, STAGE_REMOTE),
	]);
	return { base, local, remote };
}

async function readSubmoduleShaAtRef(
	repository: GitApiRepository,
	ref: string,
	repoRelativePath: string,
): Promise<string | null> {
	try {
		const output = await execGit(
			["rev-parse", "--verify", `${ref}:${repoRelativePath}`],
			repository.rootUri.fsPath,
		);
		const sha = output.trim();
		if (!SHA_REGEX.test(sha)) {
			throw new Error(
				`${ref}:${repoRelativePath} is not a commit SHA: ${sha}`,
			);
		}
		return sha;
	} catch (error: unknown) {
		if (isMissingPathAtRefError(error, repoRelativePath)) {
			return null;
		}
		throw new Error(
			`Cannot read submodule gitlink at ${ref}:${repoRelativePath}.`,
			{ cause: error },
		);
	}
}

function isMissingPathAtRefError(
	error: unknown,
	repoRelativePath: string,
): boolean {
	const message = errorMessage(error);
	return (
		message.includes(`path '${repoRelativePath}'`) &&
		(message.includes("exists on disk, but not in") ||
			message.includes("does not exist in"))
	);
}

async function readTreeMode(
	repository: GitApiRepository,
	ref: string,
	repoRelativePath: string,
): Promise<string | null> {
	const output = await execGit(
		["ls-tree", ref, "--", repoRelativePath],
		repository.rootUri.fsPath,
	);
	const match = LS_TREE_ENTRY_REGEX.exec(output);
	if (match?.[1]) {
		return match[1];
	}
	return null;
}

async function removeResolvedIndexEntry(
	repository: GitApiRepository,
	repoRelativePath: string,
): Promise<void> {
	try {
		await execGit(
			["rm", "--cached", "--quiet", "--", repoRelativePath],
			repository.rootUri.fsPath,
		);
	} catch (removeError: unknown) {
		try {
			await execGit(
				["update-index", "--force-remove", "--", repoRelativePath],
				repository.rootUri.fsPath,
			);
		} catch (forceRemoveError: unknown) {
			throw new Error(
				`Cannot remove resolved index entry for ${repoRelativePath}: update-index --force-remove fallback failed: ${errorMessage(forceRemoveError)}`,
				{ cause: removeError },
			);
		}
	}
}

async function writeSubmoduleIndexStages(
	repository: GitApiRepository,
	repoRelativePath: string,
	shas: {
		base: string | null;
		local: string | null;
		remote: string | null;
	},
): Promise<void> {
	const lines: string[] = [`0 ${ZERO_OBJECT_ID}\t${repoRelativePath}`];
	if (shas.base) {
		lines.push(`${GITLINK_MODE} ${shas.base} 1\t${repoRelativePath}`);
	}
	if (shas.local) {
		lines.push(`${GITLINK_MODE} ${shas.local} 2\t${repoRelativePath}`);
	}
	if (shas.remote) {
		lines.push(`${GITLINK_MODE} ${shas.remote} 3\t${repoRelativePath}`);
	}
	lines.push("");
	await execGitWithInput(
		["update-index", "--index-info"],
		repository.rootUri.fsPath,
		lines.join("\n"),
	);
}

async function assertSubmoduleCommitExists(
	conflict: SubmoduleConflict,
	sha: string,
): Promise<void> {
	try {
		await execGit(
			["cat-file", "-e", `${sha}^{commit}`],
			conflict.submoduleRepoPath(),
		);
	} catch (error: unknown) {
		throw new Error(
			`Cannot stage ${sha}: commit does not exist in ${conflict.repoRelativePath}.`,
			{ cause: error },
		);
	}
}

function parseCommitBlob(blob: string): CommitInfo {
	const fields = blob.trim().split(LOG_FIELD_SEPARATOR);
	const expectedFieldCount = 11;
	if (fields.length !== expectedFieldCount) {
		throw new Error(
			`Malformed submodule commit log record: expected ${expectedFieldCount} fields, got ${fields.length}.`,
		);
	}
	const commitFields = fields as CommitLogFields;
	const [
		hash,
		shortHash,
		authorName,
		authorEmail,
		authorDate,
		committerName,
		committerEmail,
		committerDate,
		rawParents,
		rawRefs,
		rawBody,
	] = commitFields;
	const bodyLines = rawBody.split("\n");
	const subjectIndex = bodyLines.findIndex((line) => line.trim().length > 0);
	const subject = subjectIndex === -1 ? "" : (bodyLines[subjectIndex] ?? "");
	const message =
		subjectIndex === -1 ? "" : bodyLines.slice(subjectIndex + 1).join("\n");
	return {
		hash,
		shortHash,
		authorName,
		authorEmail,
		authorDate,
		committerName,
		committerEmail,
		committerDate,
		parents: rawParents.split(" ").filter((parent) => parent),
		refs: rawRefs.split(", ").filter((ref) => ref),
		subject: subject.trim(),
		message: message.trim(),
		files: null,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function commitLogFormat(): string {
	return [
		"%H",
		"%h",
		"%an",
		"%ae",
		"%aI",
		"%cn",
		"%ce",
		"%cI",
		"%P",
		"%D",
		"%B",
	].join(LOG_FIELD_SEPARATOR_FORMAT);
}

async function readCommitWindow(
	conflict: SubmoduleConflict,
): Promise<CommitInfo[]> {
	// The old resolver showed a small amount of history before the conflict
	// base so the graph had enough context to understand where the sides
	// diverged. Avoid `base~20`: it fails when the base is near the root and is
	// brittle in shallow submodule clones. The important bit is to ask Git for
	// one graph walk over base/local/remote, bounded by the parent(s) of the
	// oldest context commit, instead of merging separate ranges in TypeScript.
	// That preserves Git's own topo-order for side branches and keeps the
	// webview renderer out of the commit-ordering business.
	const contextOutput = await execGit(
		[
			"rev-list",
			"--topo-order",
			"--reverse",
			`-n${PRE_BASE_CONTEXT_COMMITS}`,
			conflict.shas.base,
		],
		conflict.submoduleRepoPath(),
	);
	const contextShas = parseShaLines(contextOutput);
	const oldestContextSha = contextShas[0] ?? conflict.shas.base;
	const oldestContextParents = await readCommitParentShas(
		conflict,
		oldestContextSha,
	);
	const output = await execGit(
		[
			"log",
			"--topo-order",
			"--reverse",
			"-n500",
			`--format=${commitLogFormat()}${LOG_RECORD_SEPARATOR_FORMAT}`,
			conflict.shas.local,
			conflict.shas.remote,
			conflict.shas.base,
			...oldestContextParents.map((parent) => `^${parent}`),
		],
		conflict.submoduleRepoPath(),
	);
	return parseCommitLogOutput(output);
}

function parseShaLines(output: string): string[] {
	return output
		.split("\n")
		.map((sha) => sha.trim())
		.filter((sha) => sha.length > 0);
}

async function readCommitParentShas(
	conflict: SubmoduleConflict,
	sha: string,
): Promise<string[]> {
	const output = await execGit(
		["rev-list", "--parents", "-n1", sha],
		conflict.submoduleRepoPath(),
	);
	const fields = output
		.trim()
		.split(" ")
		.filter((field) => field);
	return fields.slice(1);
}

function parseCommitLogOutput(output: string): CommitInfo[] {
	return output
		.split(LOG_RECORD_SEPARATOR)
		.map((blob) => blob.trim())
		.filter((blob) => blob.length > 0)
		.map(parseCommitBlob);
}

async function readSubmoduleCommit(
	conflict: SubmoduleConflict,
	sha: string,
): Promise<CommitInfo> {
	if (!SHA_REGEX.test(sha)) {
		throw new Error(`Cannot read invalid commit SHA: ${sha}`);
	}
	const format = commitLogFormat();
	const output = await execGit(
		["log", "-1", `--format=${format}${LOG_RECORD_SEPARATOR_FORMAT}`, sha],
		conflict.submoduleRepoPath(),
	);
	const commit = output
		.split(LOG_RECORD_SEPARATOR)
		.map((blob) => blob.trim())
		.filter((blob) => blob.length > 0)
		.map(parseCommitBlob)[0];
	if (!commit) {
		throw new Error(`Commit not found in submodule: ${sha}`);
	}
	return commit;
}

async function searchSubmoduleCommits(
	conflict: SubmoduleConflict,
	query: string,
): Promise<CommitInfo[]> {
	const trimmed = query.trim();
	if (trimmed.length < 3) {
		return [];
	}
	const format = commitLogFormat();
	const results = new Map<string, CommitInfo>();
	const grepOutput = await execGit(
		[
			"log",
			"--all",
			"--grep",
			trimmed,
			"-i",
			"-n50",
			`--format=${format}${LOG_RECORD_SEPARATOR_FORMAT}`,
		],
		conflict.submoduleRepoPath(),
	);
	for (const blob of grepOutput.split(LOG_RECORD_SEPARATOR)) {
		if (blob.trim().length > 0) {
			const commit = parseCommitBlob(blob);
			results.set(commit.hash, commit);
		}
	}
	if (SHA_PREFIX_REGEX.test(trimmed)) {
		try {
			const shaOutput = await execGit(
				[
					"log",
					"--all",
					"--no-walk",
					trimmed,
					"-n50",
					`--format=${format}${LOG_RECORD_SEPARATOR_FORMAT}`,
				],
				conflict.submoduleRepoPath(),
			);
			for (const blob of shaOutput.split(LOG_RECORD_SEPARATOR)) {
				if (blob.trim().length > 0) {
					const commit = parseCommitBlob(blob);
					results.set(commit.hash, commit);
				}
			}
		} catch (error: unknown) {
			if (isRevisionLookupMiss(error)) {
				return Array.from(results.values());
			}
			throw new Error(
				`Cannot search submodule commits by SHA prefix ${trimmed}.`,
				{ cause: error },
			);
		}
	}
	return Array.from(results.values());
}

function isRevisionLookupMiss(error: unknown): boolean {
	const message = errorMessage(error);
	return (
		message.includes("unknown revision") ||
		message.includes("ambiguous argument") ||
		message.includes("Needed a single revision")
	);
}

async function readCommitFiles(
	conflict: SubmoduleConflict,
	sha: string,
): Promise<ChangedFile[]> {
	if (!SHA_REGEX.test(sha)) {
		throw new Error(`Cannot read files for invalid commit SHA: ${sha}`);
	}
	const output = await execGit(
		["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", sha],
		conflict.submoduleRepoPath(),
	);
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const tab = line.indexOf("\t");
			if (tab === -1) {
				throw new Error(`Unexpected diff-tree output: ${line}`);
			}
			return { status: line.slice(0, tab), path: line.slice(tab + 1) };
		});
}

function parentRefForCommit(commit: CommitInfo): string {
	const parent = commit.parents[0];
	if (!parent) {
		return EMPTY_TREE_SHA;
	}
	return parent;
}

function changedFileUri(conflict: SubmoduleConflict, filePath: string): Uri {
	return Uri.joinPath(conflict.uri, ...filePath.split("/"));
}

export type { SubmoduleConflictIdentity };
export {
	changedFileUri,
	isActiveSubmoduleGitlinkConflict,
	isKnownSubmoduleConflictPath,
	isSubmoduleGitlinkChange,
	parentRefForCommit,
	parseSubmoduleConflictUri,
	readCommitFiles,
	readSubmoduleCommit,
	SubmoduleConflict,
	SubmoduleConflictUnavailableError,
	searchSubmoduleCommits,
	submoduleConflictUri,
	submoduleUriFromIdentity,
};
