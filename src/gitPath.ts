// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { getGitApi } from "./repoContext.ts";

function getExtensionPath(): string {
	const api = getGitApi();
	return api.git.path;
}

export function getGitExecutable(): string {
	return getExtensionPath();
}
