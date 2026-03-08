// Copyright (C) 2026 Pyarelal Knowles, GPL v2
import type { DiffChunkTag } from "../../matchers/myers.ts";

export const DIFF_WIDTH = 40;

export const PaneIndex = {
	baseLeft: 0,
	local: 1,
	merged: 2,
	remote: 3,
	baseRight: 4,
} as const;
export type PaneIndex = (typeof PaneIndex)[keyof typeof PaneIndex];

export const DiffIndex = {
	baseLeftToLocal: 0,
	localToMerged: 1,
	mergedToRemote: 2,
	remoteToBaseRight: 3,
} as const;
export type DiffIndex = (typeof DiffIndex)[keyof typeof DiffIndex];

export interface FileState {
	label: string;
	content: string;
	commit?:
		| {
				hash: string;
				title: string;
				authorName: string;
				authorEmail: string;
				date: string;
				body: string;
		  }
		| undefined;
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
