// Copyright (C) 2026 Pyarelal Knowles, GPL v2

export const DIFF_WIDTH = 40;

export interface FileState {
	label: string;
	content: string;
	commit?: {
		hash: string;
		title: string;
		authorName: string;
		authorEmail: string;
		date: string;
		body: string;
	};
}

export interface DiffChunk {
	tag: string;
	start_a: number;
	end_a: number;
	start_b: number;
	end_b: number;
}

export interface Highlight {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	isWholeLine: boolean;
	tag: string;
}

export interface BaseDiffPayload {
	side: "left" | "right";
	file: FileState;
	diffs: DiffChunk[];
}
