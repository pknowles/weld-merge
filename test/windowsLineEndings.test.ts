// Copyright (C) 2026 Pyarelal Knowles

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { Uri } from "vscode";
import { readIndexStageContent } from "../src/gitUtils.ts";
import { GitTextMerger } from "../src/matchers/gitTextMerger.ts";
import { Merger } from "../src/matchers/merge.ts";
import type { GitApiRepository } from "../src/repoContext.ts";
import { extractConflictLabels } from "../src/webview/conflictLabels.ts";
import {
	buildInitialConflictedState,
	fetchConflictStages,
} from "../src/webview/diffPayload.ts";
import { runGit } from "./runGit.ts";

// These tests force Git's CRLF checkout-conversion path in a temp repo rather
// than relying on running on Windows: setting core.autocrlf=true makes Git
// check out CRLF on any OS, exercising the same smudge path Windows hits by
// default. Windows-specific path handling (backslashes, drive letters) is
// covered by feeding Windows-shaped fsPaths through the same production code.
// See windows_line_ending_conversion.plan.md.

const GIT_STAGE_BASE = 1;
const GIT_STAGE_LOCAL = 2;
const GIT_STAGE_REMOTE = 3;
const OUTSIDE_ROOT_ERROR_REGEX = /invalid repository path/;
const CAT_FILE_ERROR_REGEX = /cat-file/;
const CARRIAGE_RETURN_REGEX = /\r/g;

// A both-modified conflict where the local and remote sides do NOT
// auto-resolve, so the merged output contains synthesized conflict-marker
// lines. Base has nothing between "header" and "tail": both sides insert
// different content at the same empty base region, so the marker/placeholder
// lines the merger synthesizes are pure literals with no real line to borrow
// a "\r" from (see merge.ts::_handleConflictInMerger's empty-region branch
// and gitTextMerger.ts's literal marker pushes).
async function makeCrlfConflictRepo(autocrlf: boolean): Promise<string> {
	const repoPath = await mkdtemp(join(tmpdir(), "weld-crlf-"));
	runGit(["init", "-b", "main"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	if (autocrlf) {
		runGit(["config", "core.autocrlf", "true"], repoPath);
	}

	const eol = autocrlf ? "\r\n" : "\n";
	const writeLines = (lines: string[]) =>
		writeFile(join(repoPath, "tracked.txt"), lines.join(eol) + eol);

	await writeLines(["header", "tail"]);
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "init"], repoPath);

	runGit(["checkout", "-b", "other"], repoPath);
	await writeLines(["header", "remote-insert", "tail"]);
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "remote change"], repoPath);

	runGit(["checkout", "main"], repoPath);
	await writeLines(["header", "local-insert", "tail"]);
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "local change"], repoPath);

	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits 1 for a conflict — expected
	}
	return repoPath;
}

// Minimal GitApiRepository fake. `show` resolves to a recognizable sentinel
// and records calls: production code must only reach it through
// readIndexStageContent's spawn-failure fallback, so tests can assert both
// that the fallback works and that real git errors never silently divert
// to it.
const API_SHOW_SENTINEL = "sentinel: raw blob from repository.show\n";
function fakeRepository(rootFsPath: string): GitApiRepository & {
	showCalls: string[];
} {
	const showCalls: string[] = [];
	return {
		showCalls,
		rootUri: Uri.file(rootFsPath),
		state: {
			mergeChanges: [],
			onDidChange: () => ({ dispose: () => undefined }),
		},
		status: () => Promise.resolve(),
		show: (ref: string) => {
			showCalls.push(ref);
			return Promise.resolve(API_SHOW_SENTINEL);
		},
		getCommit: () => Promise.reject(new Error("not used in this fixture")),
		getMergeBase: () =>
			Promise.reject(new Error("not used in this fixture")),
		add: () => Promise.resolve(),
	};
}

async function readStages(repoPath: string) {
	const repository = fakeRepository(repoPath);
	const file = Uri.file(join(repoPath, "tracked.txt"));
	const [base, local, incoming] = await Promise.all([
		readIndexStageContent(repository, file, GIT_STAGE_BASE),
		readIndexStageContent(repository, file, GIT_STAGE_LOCAL),
		readIndexStageContent(repository, file, GIT_STAGE_REMOTE),
	]);
	expect(repository.showCalls).toEqual([]);
	return { base, local, incoming };
}

function runMergers(stages: { base: string; local: string; incoming: string }) {
	const sequences = [
		stages.local.split("\n"),
		stages.base.split("\n"),
		stages.incoming.split("\n"),
	];
	const merger = new Merger();
	merger.initialize(sequences, sequences);
	const gitMerger = new GitTextMerger();
	gitMerger.initialize(sequences, sequences);
	return {
		merged: merger.merge3Files(true),
		gitMerged: gitMerger.merge3FilesGit(true),
	};
}

// Every line, including synthesized marker lines, must carry exactly the
// given EOL as its own terminator — checking `text.includes("\n")` would
// always report mixed endings since "\r\n" contains "\n" as a substring.
// Split into lines the same way the merger does and check each line's own
// trailing character instead. (The final split element is whatever follows
// the last "\n" — typically "" — and has no terminator of its own to check.)
function assertUniformEol(mergedText: string, eol: string): void {
	for (const line of mergedText.split("\n").slice(0, -1)) {
		expect(line.endsWith("\r")).toBe(eol === "\r\n");
	}
}

describe("Windows line-ending conversion: fallback discrimination", () => {
	it("rejects files outside the repository root before running git", async () => {
		const repository = fakeRepository("/nonexistent-weld-test/repo");
		const file = Uri.file("/nonexistent-weld-test/elsewhere/tracked.txt");
		await expect(
			readIndexStageContent(repository, file, GIT_STAGE_LOCAL),
		).rejects.toThrow(OUTSIDE_ROOT_ERROR_REGEX);
		expect(repository.showCalls).toEqual([]);
	});

	it("falls back to repository.show only when git cannot be spawned", async () => {
		// This root does not exist, so execFile fails with a string syscall
		// code (ENOENT) before git ever runs — the exact condition of a host
		// with no usable git. The read must then come from the Git API, not
		// fail.
		const repository = fakeRepository("/nonexistent-weld-test/repo");
		const file = Uri.file("/nonexistent-weld-test/repo/tracked.txt");
		const content = await readIndexStageContent(
			repository,
			file,
			GIT_STAGE_LOCAL,
		);
		expect(content).toBe(API_SHOW_SENTINEL);
		expect(repository.showCalls).toEqual([":2"]);
	});

	it("rethrows real git failures instead of silently falling back", async () => {
		// Requesting a stage that does not exist is a genuine git error
		// (numeric exit code). Falling back to repository.show here would
		// silently reintroduce the CRLF bug under real failures.
		const repoPath = await makeCrlfConflictRepo(true);
		try {
			const repository = fakeRepository(repoPath);
			const file = Uri.file(join(repoPath, "not-in-conflict.txt"));
			await expect(
				readIndexStageContent(repository, file, GIT_STAGE_LOCAL),
			).rejects.toThrow(CAT_FILE_ERROR_REGEX);
			expect(repository.showCalls).toEqual([]);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});

describe("Windows line-ending conversion: stage fetch", () => {
	it("returns worktree-form content, matching what a fresh checkout writes to disk", async () => {
		const repoPath = await makeCrlfConflictRepo(true);
		try {
			const { local } = await readStages(repoPath);

			// Ground truth: checking out the local side in a scratch clone lets
			// Git itself perform the exact checkout conversion. core.autocrlf is
			// a local (non-cloned) config, so `clone` materializes the file
			// before it can take effect; delete and re-checkout to force Git to
			// re-smudge with the now-active conversion (`checkout -f` and
			// `checkout -- path` are no-ops while Git sees no diff to resolve).
			const scratchPath = await mkdtemp(
				join(tmpdir(), "weld-crlf-scratch-"),
			);
			try {
				runGit(["clone", repoPath, scratchPath], scratchPath);
				runGit(["config", "core.autocrlf", "true"], scratchPath);
				await rm(join(scratchPath, "tracked.txt"));
				runGit(["checkout", "--", "tracked.txt"], scratchPath);
				const diskContent = await readFile(
					join(scratchPath, "tracked.txt"),
					"utf8",
				);
				expect(local).toBe(diskContent);
				expect(local).toContain("\r\n");
			} finally {
				await rm(scratchPath, { recursive: true, force: true });
			}
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});

	it("fetchConflictStages produces the same stages for a CRLF repo as an LF repo, modulo EOL", async () => {
		const crlfRepoPath = await makeCrlfConflictRepo(true);
		const lfRepoPath = await makeCrlfConflictRepo(false);
		try {
			const conflictedItem = (repoPath: string) => ({
				repository: fakeRepository(repoPath),
				rootUri: Uri.file(repoPath),
				uri: Uri.file(join(repoPath, "tracked.txt")),
				mergeChange: null,
				conflictStatus: () =>
					Promise.reject(new Error("not used in this fixture")),
			});
			const crlf = await fetchConflictStages(
				conflictedItem(crlfRepoPath),
			);
			const lf = await fetchConflictStages(conflictedItem(lfRepoPath));

			// Today's bug: without worktree-form conversion, every CRLF-fetched
			// stage line carries a trailing \r its LF counterpart doesn't, and
			// the editor reports the whole file as one conflict.
			expect(crlf.base.replace(CARRIAGE_RETURN_REGEX, "")).toBe(lf.base);
			expect(crlf.local.replace(CARRIAGE_RETURN_REGEX, "")).toBe(
				lf.local,
			);
			expect(crlf.incoming.replace(CARRIAGE_RETURN_REGEX, "")).toBe(
				lf.incoming,
			);
			expect(crlf.local).toContain("\r\n");

			// Parity must survive the merge pipeline too: identical conflict
			// structure, differing only in line endings.
			const crlfOut = runMergers(crlf);
			const lfOut = runMergers(lf);
			expect(crlfOut.merged.replace(CARRIAGE_RETURN_REGEX, "")).toBe(
				lfOut.merged,
			);
			expect(crlfOut.gitMerged.replace(CARRIAGE_RETURN_REGEX, "")).toBe(
				lfOut.gitMerged,
			);
		} finally {
			await rm(crlfRepoPath, { recursive: true, force: true });
			await rm(lfRepoPath, { recursive: true, force: true });
		}
	});
});

describe("Windows line-ending conversion: merge output", () => {
	it.each([
		["CRLF", true, "\r\n"],
		["LF", false, "\n"],
	])("keeps merge output line endings uniform (%s repo, including synthesized conflict markers)", async (_label, autocrlf, eol) => {
		const repoPath = await makeCrlfConflictRepo(autocrlf);
		try {
			const { merged, gitMerged } = runMergers(
				await readStages(repoPath),
			);
			// This conflict does not auto-resolve, so both outputs contain
			// synthesized marker lines — the only lines that could end up
			// with the wrong terminator (real lines carry their own).
			expect(merged).toContain("(??)");
			assertUniformEol(merged, eol);
			expect(gitMerged).toContain("<<<<<<< HEAD");
			assertUniformEol(gitMerged, eol);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});

describe("Windows line-ending conversion: auto-merge reproducibility", () => {
	it("buildInitialConflictedState reproduces the on-disk CRLF conflict byte-for-byte", async () => {
		// This is the exact comparison _maybeApplyAutoMerge performs to decide
		// whether auto-merge may replace the document. On Windows today it
		// never matches (LF reproduction vs CRLF file), so auto-merge never
		// applies — this test is the end-to-end fix for that symptom, covering
		// git merge-file's marker EOL behavior as well as stage conversion.
		const repoPath = await makeCrlfConflictRepo(true);
		try {
			const diskContent = await readFile(
				join(repoPath, "tracked.txt"),
				"utf8",
			);
			expect(diskContent).toContain("\r\n");
			const labels = extractConflictLabels(diskContent);
			if (!labels) {
				throw new Error(
					"Expected conflict markers in the checked-out file",
				);
			}
			const stages = await readStages(repoPath);
			const reproduced = await buildInitialConflictedState(
				Uri.file(repoPath),
				stages,
				labels,
			);
			expect(reproduced).toBe(diskContent);

			// And a genuine user edit must break the match, so normalized
			// stage fetching cannot weaken the "preserve the user's file"
			// decision into a false "unchanged".
			const edited = diskContent.replace(
				"local-insert",
				"hand-edited-content",
			);
			expect(reproduced).not.toBe(edited);
		} finally {
			await rm(repoPath, { recursive: true, force: true });
		}
	});
});
