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
	listConflicts,
	normalizeGetConflictInput,
} from "./agentConflicts.ts";
import { getWeldLogChannel } from "./log.ts";

type ApplyAutomergeAll = () => Promise<string>;
type ApplyAutomergeSingle = (
	location: ConflictLocation,
) => Promise<{ remainingConflicts: number }>;

function registerEnabledTools(
	applyAutomergeAll: ApplyAutomergeAll,
	applyAutomergeSingle: ApplyAutomergeSingle,
): Disposable | null {
	if (
		workspace.getConfiguration("weld").get<boolean>("agent.enable") !== true
	) {
		return null;
	}
	const applyAllDisposable = lm.registerTool("weld_apply_automerge_all", {
		async invoke() {
			const message = await applyAutomergeAll();
			getWeldLogChannel().info(
				`Weld agent tool weld_apply_automerge_all: ${message}`,
			);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(message),
			]);
		},
	});
	const applySingleDisposable = lm.registerTool<ConflictLocation>(
		"weld_apply_automerge",
		{
			async invoke(options) {
				const result = await applyAutomergeSingle(options.input);
				getWeldLogChannel().info(
					`Weld agent tool weld_apply_automerge: ${options.input.path} has ${result.remainingConflicts} conflict(s) remaining`,
				);
				return new LanguageModelToolResult([
					new LanguageModelTextPart(
						JSON.stringify({ ...options.input, ...result }),
					),
				]);
			},
		},
	);
	const listDisposable = lm.registerTool("weld_list_conflicts", {
		async invoke() {
			const result = await listConflicts();
			getWeldLogChannel().info(
				`Weld agent tool weld_list_conflicts: listed ${result.files.length} file(s)`,
			);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(result)),
			]);
		},
	});
	const getDisposable = lm.registerTool<GetConflictToolInput>(
		"weld_get_conflict",
		{
			async invoke(options) {
				const result = await getConflict(
					normalizeGetConflictInput(options.input),
				);
				getWeldLogChannel().info(
					`Weld agent tool weld_get_conflict: returned ${result.type} conflict ${result.conflictIndex} for ${result.path}`,
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

export { registerAgentTools };
