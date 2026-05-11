// Copyright (C) 2026 Pyarelal Knowles, GPL v2
import type { DiffChunkTag } from "../../matchers/myers.ts";

interface WireFileState {
	label: string;
	content: string;
	commit?: Commit | undefined;
}

export interface Commit {
	hash: string;
	title: string;
	authorName: string;
	authorEmail: string;
	date: string;
	body: string;
}

export interface FileState extends WireFileState {
	lines: string[];
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

export interface MonacoContentChange {
	range: {
		startLineNumber: number;
		startColumn: number;
		endLineNumber: number;
		endColumn: number;
	};
	text: string;
}

// The transport payload has a fixed shape: three file panes (local, merged,
// remote) and two diff lanes (local<->merged, merged<->remote). Using tuples
// keeps this contract in the type system so consumers cannot accidentally
// widen to `T | undefined` and reach for `?? []` fallbacks.
export type PayloadFiles = [WireFileState, WireFileState, WireFileState];
export type PayloadDiffs = [DiffChunk[], DiffChunk[]];

export interface WebviewPayload {
	command: "loadDiff";
	lastExternalChangeVersion: number;
	data: {
		files: PayloadFiles;
		diffs: PayloadDiffs;
		isConflicted: boolean;
		config?: {
			syntaxHighlighting: boolean;
			baseCompareHighlighting: boolean;
			smoothScrolling: boolean;
		};
	};
}

export interface BaseDiffPayload {
	side: "left" | "right";
	file: WireFileState;
	diffs: DiffChunk[];
}

export interface WebviewErrorPayload {
	title: string;
	message: string;
	details?: string | undefined;
}

export const DIFF_WIDTH = 40;
export const ANIMATION_DURATION = 430;
export const ANIMATION_TRANSITION = "margin 0.4s cubic-bezier(0.4, 0, 0.2, 1)";
