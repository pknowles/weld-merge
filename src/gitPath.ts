// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import * as vscode from "vscode";

export async function getGitExecutable(): Promise<string> {
	const gitExtension = vscode.extensions.getExtension("vscode.git");
	if (gitExtension) {
		if (!gitExtension.isActive) {
			await gitExtension.activate();
		}
		const exports = gitExtension.exports;
		if (typeof exports?.getAPI === "function") {
			const api = exports.getAPI(1);
			if (api?.git?.path) {
				return api.git.path;
			}
		}
	}
	const configPath = vscode.workspace
		.getConfiguration("git")
		.get<string | string[]>("path");
	if (configPath) {
		if (Array.isArray(configPath) && configPath.length > 0) {
			return configPath[0];
		}
		if (typeof configPath === "string" && configPath.trim() !== "") {
			return configPath;
		}
	}
	return "git";
}
