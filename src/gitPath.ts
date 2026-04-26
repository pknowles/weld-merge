// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { workspace } from "vscode";
import { getGitApi } from "./repoContext.ts";

async function getExtensionPath(): Promise<string | undefined> {
	try {
		const api = await getGitApi();
		return api.git.path || undefined;
	} catch {
		return;
	}
}

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
	return configPath || "git";
}
