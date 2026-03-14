// Copyright (C) 2026 Pyarelal Knowles, GPL v2
import type { DiffChunkTag } from "../../matchers/myers.ts";

export interface Commit {
	hash: string;
	title: string;
	authorName: string;
	authorEmail: string;
	date: string;
	body: string;
}

export interface FileState {
	label: string;
	content: string;
	commit?: Commit | undefined;
}

export interface DiffChunk {
	tag: DiffChunkTag;
	startA: number;
	endA: number;
	startB: number;
	endB: number;
}

export interface Highlight {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	isWholeLine: boolean;
	tag: string;
}

export interface WebviewPayload {
	command: "loadDiff" | "updateConfig";
	data: {
		files: FileState[];
		diffs: DiffChunk[][];
		config?: {
			debounceDelay: number;
			syntaxHighlighting: boolean;
			baseCompareHighlighting: boolean;
			smoothScrolling: boolean;
		};
	};
}

export interface BaseDiffPayload {
	side: "left" | "right";
	file: FileState;
	diffs: DiffChunk[];
}

export const ANIMATION_DURATION = 300;
export const ANIMATION_TRANSITION =
	"margin-left 0.3s ease-in-out, margin-right 0.3s ease-in-out";
