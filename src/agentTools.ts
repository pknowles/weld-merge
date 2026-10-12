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
	type StageResolvedToolInput,
	stageResolved,
} from "./agentConflicts.ts";
import { getWeldLogChannel } from "./log.ts";
import type {
	AutoMergeAllResult,
	AutoMergeResult,
} from "./webview/autoMerge.ts";

interface ApplyAutomergeAllInput {
	force?: boolean;
}
type ApplyAutomergeAllResult = AutoMergeAllResult;
type ApplyAutomergeAll = (
	input: ApplyAutomergeAllInput,
) => Promise<ApplyAutomergeAllResult>;
type ApplyAutomergeResult = Exclude<
	AutoMergeResult,
	{ kind: "skippedWouldClobber" }
>;
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
	const stageResolvedDisposable = lm.registerTool<StageResolvedToolInput>(
		"weld_stage_resolved",
		{
			async invoke(options) {
				const result = await stageResolved(options.input);
				const stagedCount = result.files.filter(
					(file) => file.staged,
				).length;
				getWeldLogChannel().info(
					`Weld agent tool weld_stage_resolved: staged ${stagedCount} of ${result.files.length} file(s)`,
				);
				return new LanguageModelToolResult([
					new LanguageModelTextPart(JSON.stringify(result)),
				]);
			},
		},
	);
	getWeldLogChannel().info(
		"Registered Weld agent tools weld_apply_automerge_all, weld_apply_automerge, weld_list_conflicts, weld_get_conflict, weld_stage_resolved",
	);
	return VscodeDisposable.from(
		applyAllDisposable,
		applySingleDisposable,
		listDisposable,
		getDisposable,
		stageResolvedDisposable,
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
