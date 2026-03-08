// Copyright (C) 2026 Pyarelal Knowles, GPL v2

// biome-ignore lint/performance/noNamespaceImport: vscode namespace is standard for extensions
import * as vscode from "vscode";

async function getExtensionPath(): Promise<string | undefined> {
	const gitExtension = vscode.extensions.getExtension("vscode.git");
	if (gitExtension) {
		if (!gitExtension.isActive) {
			await gitExtension.activate();
		}
		const exports = gitExtension.exports;
		if (typeof exports?.getAPI === "function") {
			const api = exports.getAPI(1);
			if (api?.git?.path) {
				return api.git.path as string;
			}
		}
	}
	return;
}

function getConfigPath(): string | undefined {
	const configPath = vscode.workspace
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
