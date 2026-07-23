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
	type GetConflictToolInput,
	getConflict,
	listConflicts,
	normalizeGetConflictInput,
} from "./agentConflicts.ts";
import { getWeldLogChannel } from "./log.ts";

type ApplyAutomergeAll = () => Promise<string>;

function registerEnabledTools(
	applyAutomergeAll: ApplyAutomergeAll,
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
	const listDisposable = lm.registerTool("weld_list_conflicts", {
		async invoke() {
			const result = await listConflicts();
			getWeldLogChannel().info(
				`Weld agent tool weld_list_conflicts: listed ${result.files.length} file(s)`,
			);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(JSON.stringify(result, null, 2)),
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
					new LanguageModelTextPart(JSON.stringify(result, null, 2)),
				]);
			},
		},
	);
	getWeldLogChannel().info(
		"Registered Weld agent tools weld_apply_automerge_all, weld_list_conflicts, weld_get_conflict",
	);
	return VscodeDisposable.from(
		applyAllDisposable,
		listDisposable,
		getDisposable,
	);
}

function registerAgentTools(
	context: ExtensionContext,
	applyAutomergeAll: ApplyAutomergeAll,
): void {
	let registration = registerEnabledTools(applyAutomergeAll);
	const configurationSubscription = workspace.onDidChangeConfiguration(
		(event) => {
			if (!event.affectsConfiguration("weld.agent.enable")) {
				return;
			}
			registration?.dispose();
			registration = registerEnabledTools(applyAutomergeAll);
		},
	);
	context.subscriptions.push(configurationSubscription, {
		dispose() {
			registration?.dispose();
		},
	});
}

export { registerAgentTools };
