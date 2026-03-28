// Copyright (C) 2026 Pyarelal Knowles, GPL v2

export interface CommitInfo {
	hash: string;
	shortHash: string;
	message: string;
	subject: string;
	authorName: string;
	authorEmail: string;
	authorDate: string;
	committerName: string;
	committerEmail: string;
	committerDate: string;
	parents: string[];
	marker?: string;
	files?: ChangedFile[];
}

export interface ChangedFile {
	path: string;
	status: string;
}
