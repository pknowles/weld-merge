// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { TextDecoder, TextEncoder } from "node:util";
import {
	Range,
	type TextDocument,
	type Uri,
	WorkspaceEdit,
	workspace,
} from "vscode";
import { fetchConflictStages } from "../conflictSnapshot.ts";
import { getErrorMessage } from "../gitUtils.ts";
import { getWeldLogChannel } from "../log.ts";
import { GitTextMerger } from "../matchers/gitTextMerger.ts";
import type { ConflictedItem, ConflictLocation } from "../repoContext.ts";
import { extractConflictLabels } from "./conflictLabels.ts";
import { buildInitialConflictedState } from "./diffPayload.ts";

// remainingConflicts is always reported, regardless of outcome, because it
// is the fact that actually matters, not the outcome label: "merged" wrote
// the merge just now; "autoResolutionsAlreadyApplied" means every
// resolution auto-merge can produce was already present in the file, so
// this call had nothing left to write (not the same as "no conflicts
// remain" — check remainingConflicts for that); "skippedWouldClobber"
// means the call never touched the file, so remainingConflicts here
// describes what auto-merge would produce, not the live document's actual
// state.
//
// staged is true only when remainingConflicts was 0 AND `git add` actually
// succeeded — false covers both "there were still conflicts, so staging was
// never attempted" and "staging was attempted but failed" (logged, see
// stageIfClean). A caller that cares whether the file is really staged must
// check this rather than inferring it from remainingConflicts === 0.
type AutoMergeResult =
	| { kind: "merged"; remainingConflicts: number; staged: boolean }
	| {
			kind: "autoResolutionsAlreadyApplied";
			remainingConflicts: number;
			staged: boolean;
	  }
	| {
			kind: "skippedWouldClobber";
			remainingConflicts: number;
			staged: false;
	  };

// Distinct from any other performAutoMerge failure: the file itself is
// fine, it was just edited since the conflict was created, so applying the
// merge would discard that edit. A caller asking for one specific file
// (weld_apply_automerge, the tree/editor commands) should turn
// "skippedWouldClobber" into a rejection — there is no "skip and continue"
// for an explicit single-file request; a batch caller (autoMergeAll)
// should leave it as a normal result entry instead, so one such file never
// aborts the run.
class WouldClobberEditError extends Error {
	constructor(uri: Uri) {
		super(
			`Refusing to auto-merge ${uri.fsPath}: its content has changed ` +
				"since the conflict was created (or it never had the expected " +
				"conflict markers), so applying the auto-merge result would " +
				"discard that change. Pass force to overwrite it anyway.",
		);
		this.name = "WouldClobberEditError";
	}
}

// Stages a file whose conflicts are confirmed resolved. Callers (this
// module's own performAutoMerge, and agentConflicts.ts's weld_stage_resolved)
// must have already confirmed the file has no leftover conflict-marker
// syntax on disk before calling this — it never re-derives that from the
// text itself (see getUnresolvedReasons in gitUtils.ts, the text-scanning
// check the interactive "add" command uses, and scanMarkers in
// agentConflicts.ts, the equivalent check weld_stage_resolved uses; this
// deliberately does not duplicate either). Note performAutoMerge's caller
// confirms via remainingConflicts === 0 (Weld's own index-stage diff, valid
// there since it only ever stages its own generated merge output) while
// weld_stage_resolved's caller confirms via absence of stray markers (the
// only signal that generalizes to arbitrary hand-written text) — different
// checks for different content, same "no markers left" invariant this relies
// on. Logs rather than throws on failure: staging is a convenience on top of
// a resolution that already succeeded, not a reason to fail that resolution
// — but the caller still needs to know it failed (returned false) rather
// than silently reporting success, so callers can surface it.
async function stageIfClean(conflictedItem: ConflictedItem): Promise<boolean> {
	try {
		await conflictedItem.repository.add([conflictedItem.uri.fsPath]);
		return true;
	} catch (error: unknown) {
		getWeldLogChannel().error(
			`Weld auto-merge resolved ${conflictedItem.uri.fsPath} but could not stage it: ${getErrorMessage(error)}`,
		);
		return false;
	}
}

// remainingConflicts is the number of conflicts the merge could not
// resolve (left as <<<<<<< markers in the document): differ.conflicts
// (populated by initialize()'s three-way diff, one entry per conflicting
// hunk), not differ.unresolved (populated by merge3FilesGit, one entry
// per marker *line* — the same distinction agentConflicts.ts's
// conflictCount draws via conflictChangeIndexes vs. individual
// DiffChunks).
async function createAutoMergeCandidate(conflictedItem: ConflictedItem) {
	// Reuses fetchConflictStages rather than fetching git stage 1 directly:
	// a both-added conflict has no stage 1 (no common ancestor), and
	// git show :1: throws for it. fetchConflictStages already knows this
	// and substitutes "" for base, matching the empty-base convention
	// createThreeWayComparison relies on elsewhere.
	const stages = await fetchConflictStages(conflictedItem);
	const {
		base: baseContent,
		local: localContent,
		remote: remoteContent,
	} = stages;

	const merger = new GitTextMerger();
	const localLines = localContent.split("\n");
	const baseLines = baseContent.split("\n");
	const remoteLines = remoteContent.split("\n");

	const sequences = [localLines, baseLines, remoteLines];
	merger.initialize(sequences, sequences);

	return {
		stages,
		finalMergedText: merger.merge3FilesGit(true),
		remainingConflicts: merger.differ.conflicts.length,
	};
}

// The two things that differ between auto-merging the working tree and
// auto-merging an already-open document: how to read the current text to
// check against, and how to write the merge result back. Each of
// performAutoMergeOnDisk/performAutoMergeOnDocument builds one of these and
// hands it to the shared decision logic in runAutoMerge, so neither the
// "disk" vs. "document" choice nor its read/write behavior is ever implicit.
interface AutoMergeTarget {
	read(): Promise<string>;
	write(finalMergedText: string, currentText: string): Promise<void>;
	// Persists the target to disk if it has an unsaved copy that read() might
	// have returned (a dirty document). Called before staging on every path,
	// including "already applied", since staging always reads from disk.
	ensureSaved(): Promise<void>;
}

function diskAutoMergeTarget(documentUri: Uri): AutoMergeTarget {
	return {
		async read() {
			return new TextDecoder().decode(
				await workspace.fs.readFile(documentUri),
			);
		},
		async write(finalMergedText) {
			await workspace.fs.writeFile(
				documentUri,
				new TextEncoder().encode(finalMergedText),
			);
		},
		async ensureSaved() {
			// Nothing to save: disk is already the source of truth.
		},
	};
}

function documentAutoMergeTarget(
	document: TextDocument,
	conflictedItem: ConflictedItem,
): AutoMergeTarget {
	const save = async () => {
		if (!(await document.save())) {
			throw new Error(
				`Failed to save auto-merged text to ${conflictedItem.uri}; it was not staged.`,
			);
		}
	};
	return {
		read() {
			return Promise.resolve(document.getText());
		},
		async write(finalMergedText, currentText) {
			const edit = new WorkspaceEdit();
			edit.replace(
				document.uri,
				new Range(
					document.positionAt(0),
					document.positionAt(currentText.length),
				),
				finalMergedText,
			);
			if (!(await workspace.applyEdit(edit))) {
				throw new Error(
					`Failed to apply merged text to ${conflictedItem.uri}.`,
				);
			}
			await save();
		},
		async ensureSaved() {
			if (document.isDirty) {
				await save();
			}
		},
	};
}

// Runs Weld's three-way merge for a single conflicted file and writes the
// result to whichever target the caller built. Throws on any operational
// failure so every caller can surface the real reason instead of swallowing
// it. Callers must only pass a file that is actually a 3-way text-merge
// candidate (both sides modified it, common ancestor present); a
// delete/modify or both-deleted conflict has no 3-way merge to compute and
// is filtered out by each caller before this is ever reached.
//
// Never blindly overwrites its target: the merge is computed from Git's
// index stages, so it refuses (returns "skippedWouldClobber", unless force)
// when the target's current text is neither the raw pre-merge conflict
// markers nor already the auto-merge result.
async function runAutoMerge(
	conflictedItem: ConflictedItem,
	target: AutoMergeTarget,
	force: boolean,
): Promise<AutoMergeResult> {
	const { stages, finalMergedText, remainingConflicts } =
		await createAutoMergeCandidate(conflictedItem);
	const targetText = await target.read();
	if (targetText === finalMergedText) {
		await target.ensureSaved();
		const staged =
			remainingConflicts === 0 && (await stageIfClean(conflictedItem));
		return {
			kind: "autoResolutionsAlreadyApplied",
			remainingConflicts,
			staged,
		};
	}
	if (!force) {
		const labels = extractConflictLabels(targetText);
		const initialGitState = labels
			? await buildInitialConflictedState(
					conflictedItem.rootUri,
					stages,
					labels,
				)
			: null;
		if (targetText !== initialGitState) {
			return {
				kind: "skippedWouldClobber",
				remainingConflicts,
				staged: false,
			};
		}
	}

	await target.write(finalMergedText, targetText);
	const staged =
		remainingConflicts === 0 && (await stageIfClean(conflictedItem));
	return { kind: "merged", remainingConflicts, staged };
}

// Used by everything that treats the working tree as authoritative: agent
// tools, tree actions, auto-merge-all, and auto-merge-on-open. Never inspects
// a dirty VS Code document — see runAutoMerge's clobber check, which compares
// against disk content only.
function performAutoMergeOnDisk(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
	force: boolean,
): Promise<AutoMergeResult> {
	return runAutoMerge(
		conflictedItem,
		diskAutoMergeTarget(documentUri),
		force,
	);
}

// Used only by the explicit active-editor command, which intentionally
// targets the user's open document instead of disk: it inspects and edits
// `document` directly, then saves it through VS Code before staging.
function performAutoMergeOnDocument(
	conflictedItem: ConflictedItem,
	document: TextDocument,
	force: boolean,
): Promise<AutoMergeResult> {
	return runAutoMerge(
		conflictedItem,
		documentAutoMergeTarget(document, conflictedItem),
		force,
	);
}

// One file's outcome from an auto-merge-all run, in the same
// repositoryRoot/path shape weld_list_conflicts and weld_get_conflict use to
// identify files, so an agent can feed a skipped entry straight into
// weld_apply_automerge with force without reformatting anything.
// remainingConflicts is always present, on every outcome — including
// "skippedWouldClobber", where it describes what auto-merge would produce,
// not the live file's actual state, since the merge was never applied — so
// "this outcome fixed nothing" is never confused with "there is nothing
// left to fix": a caller must read remainingConflicts, not the outcome
// label alone, to know whether the file still needs attention. staged is
// true only when remainingConflicts was 0 and `git add` actually succeeded —
// see AutoMergeResult.
type AutoMergeAllEntry = ConflictLocation & {
	remainingConflicts: number;
	staged: boolean;
} & ( // Wrote the 3-way merge result to the file this call.
		| { outcome: "merged" }
		// Auto-merge was not able to do anything this call: the live file
		// already held exactly the auto-merge result, so nothing was
		// written. Not the same as "resolved" — remainingConflicts still
		// names what, if anything, is left.
		| { outcome: "autoResolutionsAlreadyApplied" }
		// Applying the merge would have discarded an edit already made to
		// this file (WouldClobberEditError) — never an abort reason for
		// the batch, and never produced when force is set. Needs
		// weld_apply_automerge with force, or a manual resolution.
		| { outcome: "skippedWouldClobber" }
	);

interface AutoMergeAllResult {
	files: AutoMergeAllEntry[];
	totalCount: number;
}

// Thrown when a batch auto-merge stops early on a genuine operational
// failure (not a per-file outcome — see AutoMergeAllEntry's outcome union
// for those). Carries the files/totalCount already collected so a caller
// need not lose track of what was actually written to disk before the
// failure: entries in `files` are done, real writes, but "attempted
// successfully" does not mean "fully resolved" — check each entry's
// remainingConflicts, same as any other AutoMergeAllEntry.
class AutoMergeAllAbortedError extends Error {
	readonly files: AutoMergeAllEntry[];
	readonly totalCount: number;
	constructor(
		message: string,
		files: AutoMergeAllEntry[],
		totalCount: number,
		cause: unknown,
	) {
		super(message, { cause });
		this.name = "AutoMergeAllAbortedError";
		this.files = files;
		this.totalCount = totalCount;
	}
}

export type { AutoMergeAllEntry, AutoMergeAllResult, AutoMergeResult };
export {
	AutoMergeAllAbortedError,
	performAutoMergeOnDisk,
	performAutoMergeOnDocument,
	stageIfClean,
	WouldClobberEditError,
};
