// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { workspace } from "vscode";
import { getGitApi } from "./repoContext.ts";

async function getExtensionPath(): Promise<string | undefined> {
	const api = await getGitApi();
	return api.git.path || undefined;
}

// TODO: code smell returning undefined. Fail fast.
function getConfigPath(): string | undefined {
	const configPath = workspace
		.getConfiguration("git")
		.get<string | string[]>("path");

	if (Array.isArray(configPath) && configPath.length > 0) {
		const first = configPath[0];
		if (first) {
			return first;
		}
	}
	if (typeof configPath === "string" && configPath.trim() !== "") {
		return configPath;
	}
	return;
}

export async function getGitExecutable(): Promise<string> {
	const extensionPath = await getExtensionPath();
	if (extensionPath) {
		return extensionPath;
	}
	const configPath = getConfigPath();
	// TODO: fallback are a violation o the coding standards.
	if (configPath) {
		return configPath;
	}
	throw new Error(
		"Cannot determine git executable: the VS Code git extension exposed no path and no 'git.path' setting is configured.",
	);
}
