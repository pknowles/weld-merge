// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Range, type Uri, WorkspaceEdit, workspace } from "vscode";
import type { ConflictLocation } from "../agentConflicts.ts";
import { fetchConflictStages } from "../conflictSnapshot.ts";
import { getErrorMessage } from "../gitUtils.ts";
import { getWeldLogChannel } from "../log.ts";
import { GitTextMerger } from "../matchers/gitTextMerger.ts";
import type { ConflictedItem } from "../repoContext.ts";
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

// Stages a file whose merge left zero remaining conflicts. Called only
// after performAutoMerge already confirmed remainingConflicts === 0 for
// this exact content, so this never re-derives that from the text (see
// getUnresolvedReasons in gitUtils.ts, the text-scanning check the
// interactive "add" command uses, which this deliberately does not
// duplicate). Logs rather than throws on failure: staging is a convenience
// on top of a merge that already succeeded, not a reason to fail the merge
// itself — but the caller still needs to know it failed (returned false)
// rather than silently reporting success, so callers can surface it.
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

// Runs Weld's three-way merge for a single conflicted file and writes the
// result back through a VS Code WorkspaceEdit. Throws on any operational
// failure so every caller can surface the real reason instead of
// swallowing it. Shared by extension.ts (tree/command auto-merge,
// autoMergeAll, the weld_apply_automerge* agent tools) and
// MeldCustomEditorProvider's auto-merge-on-open — both need identical
// clobber/force/staging behavior, so this is the one implementation both
// call rather than two that could drift apart. Callers must only pass a
// file that is actually a 3-way text-merge candidate (both sides
// modified it, common ancestor present); a delete/modify or both-deleted
// conflict has no 3-way merge to compute and is filtered out by each
// caller before this is ever reached.
//
// Never blindly overwrites the live document: the merge is computed from
// Git's index stages, not from what is actually in the document, so an
// edit applied without checking would silently destroy any change already
// made to the file (by hand or by another tool) since the conflict was
// created. Refuses (returns "skippedWouldClobber", unless force) when the
// live text is neither the raw pre-merge conflict markers (safe — nothing
// of the caller's is lost) nor already the auto-merge result (a no-op,
// reported as "autoResolutionsAlreadyApplied" — not an error).
//
// remainingConflicts is the number of conflicts the merge could not
// resolve (left as <<<<<<< markers in the document): differ.conflicts
// (populated by initialize()'s three-way diff, one entry per conflicting
// hunk), not differ.unresolved (populated by merge3FilesGit, one entry
// per marker *line* — the same distinction agentConflicts.ts's
// conflictCount draws via conflictChangeIndexes vs. individual
// DiffChunks).
async function performAutoMerge(
	conflictedItem: ConflictedItem,
	documentUri: Uri,
	options: { force?: boolean } = {},
): Promise<AutoMergeResult> {
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

	const finalMergedText = merger.merge3FilesGit(true);

	const remainingConflicts = merger.differ.conflicts.length;

	const document = await workspace.openTextDocument(documentUri);
	const docText = document.getText();
	if (docText === finalMergedText) {
		const staged =
			remainingConflicts === 0 && (await stageIfClean(conflictedItem));
		return {
			kind: "autoResolutionsAlreadyApplied",
			remainingConflicts,
			staged,
		};
	}
	if (!options.force) {
		const labels = extractConflictLabels(docText);
		const initialGitState = labels
			? await buildInitialConflictedState(
					conflictedItem.rootUri,
					stages,
					labels,
				)
			: null;
		if (docText !== initialGitState) {
			return {
				kind: "skippedWouldClobber",
				remainingConflicts,
				staged: false,
			};
		}
	}

	const fullRange = new Range(
		document.positionAt(0),
		document.positionAt(docText.length),
	);

	const edit = new WorkspaceEdit();
	edit.replace(documentUri, fullRange, finalMergedText);
	const applied = await workspace.applyEdit(edit);
	if (!applied) {
		throw new Error(
			`Failed to apply merged text to ${conflictedItem.uri}.`,
		);
	}
	const staged =
		remainingConflicts === 0 && (await stageIfClean(conflictedItem));
	return { kind: "merged", remainingConflicts, staged };
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
export { AutoMergeAllAbortedError, performAutoMerge, WouldClobberEditError };
