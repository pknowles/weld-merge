// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	type Disposable,
	type ExtensionContext,
	LanguageModelTextPart,
	LanguageModelToolResult,
	lm,
	Disposable as VscodeDisposable,
	workspace,
} from "vscode";
import {
	type ConflictLocation,
	type GetConflictToolInput,
	getConflict,
	type ListConflictsToolInput,
	listConflicts,
	normalizeGetConflictInput,
} from "./agentConflicts.ts";
import { getWeldLogChannel } from "./log.ts";

interface ApplyAutomergeAllInput {
	force?: boolean;
}
// Mirrors extension.ts's AutoMergeAllEntry: one entry per file the batch
// attempted, in the same repositoryRoot/path shape every other tool uses to
// identify a file, so a skipped entry can be fed straight into
// weld_apply_automerge with force. remainingConflicts is always present —
// including on "skippedWouldClobber", where it describes what auto-merge
// would produce, not the live file's actual state, since the merge was
// never applied. "merged" wrote the 3-way merge (remainingConflicts left as
// <<<<<<< markers is opportunistic, not guaranteed zero); nothing here
// asserts the file is fully resolved — check remainingConflicts for that.
// "skippedWouldClobber" means the file's live content had already changed
// since the conflict was created, so it was left untouched rather than
// discarding that change — never a batch-aborting failure, and never
// produced when force is set.
type ApplyAutomergeAllEntry = ConflictLocation & {
	remainingConflicts: number;
} & (
		| { outcome: "merged" }
		| { outcome: "autoResolutionsAlreadyApplied" }
		| { outcome: "skippedWouldClobber" }
	);
interface ApplyAutomergeAllResult {
	files: ApplyAutomergeAllEntry[];
	totalCount: number;
}
type ApplyAutomergeAll = (
	input: ApplyAutomergeAllInput,
) => Promise<ApplyAutomergeAllResult>;
// Mirrors extension.ts's AutoMergeResult: "merged" wrote the 3-way merge;
// "autoResolutionsAlreadyApplied" means the live file already equalled the
// auto-merge result, so this call had nothing left to write — not the same
// as "fully resolved" (see remainingConflicts). performAutoMerge refuses
// (throws WouldClobberEditError) rather than overwrite a file that has
// diverged from both the pre-merge conflict markers and the auto-merge
// result, unless the caller passes force.
type ApplyAutomergeResult =
	| { kind: "merged"; remainingConflicts: number }
	| { kind: "autoResolutionsAlreadyApplied"; remainingConflicts: number };
type ApplyAutomergeSingleInput = ConflictLocation & { force?: boolean };
type ApplyAutomergeSingle = (
	input: ApplyAutomergeSingleInput,
) => Promise<ApplyAutomergeResult>;

function registerEnabledTools(
	applyAutomergeAll: ApplyAutomergeAll,
	applyAutomergeSingle: ApplyAutomergeSingle,
): Disposable | null {
	if (
		workspace.getConfiguration("weld").get<boolean>("agent.enable") !== true
	) {
		return null;
	}
	const applyAllDisposable = lm.registerTool<ApplyAutomergeAllInput>(
		"weld_apply_automerge_all",
		{
			async invoke(options) {
				const result = await applyAutomergeAll(options.input);
				const mergedCount = result.files.filter(
					(file) => file.outcome !== "skippedWouldClobber",
				).length;
				const skippedCount = result.files.length - mergedCount;
				getWeldLogChannel().info(
					`Weld agent tool weld_apply_automerge_all: merged ${mergedCount} of ${result.totalCount} file(s), skipped ${skippedCount}`,
				);
				return new LanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify(result)),
				]);
			},
		},
	);
	const applySingleDisposable = lm.registerTool<ApplyAutomergeSingleInput>(
		"weld_apply_automerge",
		{
			async invoke(options) {
				const result = await applyAutomergeSingle(options.input);
				getWeldLogChannel().info(
					result.kind === "autoResolutionsAlreadyApplied"
						? `Weld agent tool weld_apply_automerge: ${options.input.path} already matches the auto-merge result; no change made, ${result.remainingConflicts} conflict(s) remaining`
						: `Weld agent tool weld_apply_automerge: ${options.input.path} has ${result.remainingConflicts} conflict(s) remaining`,
				);
				return new LanguageModelToolResult([
					new LanguageModelTextPart(
						JSON.stringify({
							repositoryRoot: options.input.repositoryRoot,
							path: options.input.path,
							...result,
						}),
					),
				]);
			},
		},
	);
	const listDisposable = lm.registerTool<ListConflictsToolInput>(
		"weld_list_conflicts",
		{
			async invoke(options) {
				const result = await listConflicts(options.input);
				getWeldLogChannel().info(
					`Weld agent tool weld_list_conflicts: listed ${result.files.length} file(s)`,
				);
				return new LanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify(result)),
				]);
			},
		},
	);
	const getDisposable = lm.registerTool<GetConflictToolInput>(
		"weld_get_conflict",
		{
			async invoke(options) {
				const result = await getConflict(
					normalizeGetConflictInput(options.input),
				);
				getWeldLogChannel().info(
					`Weld agent tool weld_get_conflict: returned ${result.type} response for ${result.path}`,
				);
				return new LanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify(result)),
				]);
			},
		},
	);
	getWeldLogChannel().info(
		"Registered Weld agent tools weld_apply_automerge_all, weld_apply_automerge, weld_list_conflicts, weld_get_conflict",
	);
	return VscodeDisposable.from(
		applyAllDisposable,
		applySingleDisposable,
		listDisposable,
		getDisposable,
	);
}

function registerAgentTools(
	context: ExtensionContext,
	applyAutomergeAll: ApplyAutomergeAll,
	applyAutomergeSingle: ApplyAutomergeSingle,
): void {
	let registration = registerEnabledTools(
		applyAutomergeAll,
		applyAutomergeSingle,
	);
	const configurationSubscription = workspace.onDidChangeConfiguration(
		(event) => {
			if (!event.affectsConfiguration("weld.agent.enable")) {
				return;
			}
			registration?.dispose();
			registration = registerEnabledTools(
				applyAutomergeAll,
				applyAutomergeSingle,
			);
		},
	);
	context.subscriptions.push(configurationSubscription, {
		dispose() {
			registration?.dispose();
		},
	});
}

export type { ApplyAutomergeAll, ApplyAutomergeSingle };
export { registerAgentTools };
