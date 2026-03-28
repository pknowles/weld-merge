// Copyright (C) 2026 Pyarelal Knowles, GPL v2

interface ChangedFile {
	path: string;
	status: string;
}

interface CommitInfo {
	hash: string;
	shortHash: string;
	subject: string;
	message: string;
	authorName: string;
	authorEmail: string;
	authorDate: string;
	committerName: string;
	committerEmail: string;
	committerDate: string;
	parents: string[];
	refs: string[];
	files: ChangedFile[] | null;
}

interface SubmoduleConflictSnapshot {
	submoduleName: string;
	repositoryRoot: string;
	submodulePath: string;
	base: string;
	local: string;
	remote: string;
	selected: string;
	commits: CommitInfo[];
}

type HostMessage =
	| { command: "snapshot"; snapshot: SubmoduleConflictSnapshot }
	| { command: "conflictLost"; message: string }
	| { command: "searchResults"; commits: CommitInfo[] }
	| { command: "commitFiles"; sha: string; files: ChangedFile[] }
	| { command: "staged" }
	| { command: "error"; message: string };

interface VsCodeApi {
	postMessage(message: unknown): void;
}

export type {
	ChangedFile,
	CommitInfo,
	HostMessage,
	SubmoduleConflictSnapshot,
	VsCodeApi,
};
