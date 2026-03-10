// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { extensions, workspace } from "vscode";

interface GitAPI {
	git: {
		path: string;
	};
}

interface GitExtension {
	getAPI(version: number): GitAPI;
}

async function getExtensionPath(): Promise<string | undefined> {
	const gitExtension = extensions.getExtension<GitExtension>("vscode.git");
	if (gitExtension) {
		if (!gitExtension.isActive) {
			await gitExtension.activate();
		}
		const exports = gitExtension.exports;
		if (exports && typeof exports.getAPI === "function") {
			const api = exports.getAPI(1);
			if (api?.git?.path) {
				return api.git.path;
			}
		}
	}
	return;
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
