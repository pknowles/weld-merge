import { diffChars } from "diff";
import type { DiffChunk, FileState, Highlight } from "./types.ts";

const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

interface ReplaceContext {
	chunk: DiffChunk;
	useA: boolean;
	innerFile: FileState;
	outerFile: FileState;
}

const calculateReplaceHighlights = (ctx: ReplaceContext): Highlight[] => {
	const { chunk, useA, innerFile, outerFile } = ctx;
	const replaceHighlights: Highlight[] = [];

	const startLine = useA ? chunk.startA : chunk.startB;
	const endLine = useA ? chunk.endA : chunk.endB;
	const otherStartLine = useA ? chunk.startB : chunk.startA;
	const otherEndLine = useA ? chunk.endB : chunk.endA;

	const myLines = splitLines(innerFile.content).slice(startLine, endLine);
	const myText = `${myLines.join("\n")}${myLines.length > 0 ? "\n" : ""}`;

	const otherLines = splitLines(outerFile.content).slice(
		otherStartLine,
		otherEndLine,
	);
	const otherText = `${otherLines.join("\n")}${otherLines.length > 0 ? "\n" : ""}`;

	const changes = diffChars(myText, otherText);
	let currentLine = startLine + 1;
	let currentColumn = 1;

	for (const change of changes) {
		const lines = change.value.split("\n");
		const nextLine = currentLine + lines.length - 1;
		const lastLine = lines.at(-1);
		const nextColumn =
			lines.length === 1
				? currentColumn + (lines[0]?.length ?? 0)
				: (lastLine?.length ?? 0) + 1;

		if (change.removed) {
			replaceHighlights.push({
				startLine: currentLine,
				startColumn: currentColumn,
				endLine: nextLine,
				endColumn: nextColumn,
				isWholeLine: false,
				tag: "replace",
			});
		}

		if (!change.added) {
			currentLine = nextLine;
			currentColumn = nextColumn;
		}
	}
	return replaceHighlights;
};

const processChunk = (
	highlights: Highlight[],
	chunk: DiffChunk | null,
	useA: boolean,
	innerFile: FileState | null,
	outerFile: FileState | null,
) => {
	if (!chunk || chunk.tag === "equal") {
		return;
	}
	const startLine = useA ? chunk.startA : chunk.startB;
	const endLine = useA ? chunk.endA : chunk.endB;

	highlights.push({
		startLine: startLine + 1,
		startColumn: 1,
		endLine,
		endColumn: 1,
		isWholeLine: true,
		tag: chunk.tag,
	});

	if (chunk.tag === "replace" && startLine < endLine) {
		if (!(innerFile && outerFile)) {
			return;
		}
		const replaceHighlights = calculateReplaceHighlights({
			chunk,
			useA,
			innerFile,
			outerFile,
		});
		highlights.push(...replaceHighlights);
	}
};

type F = (FileState | null)[];
type D = (DiffChunk[] | null)[];

function getHighlights0(files: F, diffs: D): Highlight[] {
	const h: Highlight[] = [];
	const d = diffs[0];
	if (d && files.length > 1) {
		for (const c of d) {
			processChunk(h, c, true, files[0] ?? null, files[1] ?? null);
		}
	}
	return h;
}

function getHighlights1(files: F, diffs: D, isLBC: boolean): Highlight[] {
	const h: Highlight[] = [];
	const d = isLBC ? diffs[0] : diffs[1];
	if (d && files.length > 2) {
		for (const c of d) {
			processChunk(
				h,
				c,
				false,
				files[1] ?? null,
				isLBC ? (files[0] ?? null) : (files[2] ?? null),
			);
		}
	}
	return h;
}

function getHighlights2(files: F, diffs: D): Highlight[] {
	const h: Highlight[] = [];
	const [d1, d2] = [diffs[1], diffs[2]];
	if (files.length > 3) {
		if (d1) {
			for (const c of d1) {
				processChunk(h, c, true, files[2] ?? null, files[1] ?? null);
			}
		}
		if (d2) {
			for (const c of d2) {
				processChunk(h, c, true, files[2] ?? null, files[3] ?? null);
			}
		}
	}
	return h;
}

function getHighlights3(files: F, diffs: D, isRBC: boolean): Highlight[] {
	const h: Highlight[] = [];
	const d = isRBC ? diffs[3] : diffs[2];
	if (d && files.length > 4) {
		for (const c of d) {
			processChunk(
				h,
				c,
				isRBC,
				files[3] ?? null,
				isRBC ? (files[4] ?? null) : (files[2] ?? null),
			);
		}
	}
	return h;
}

function getHighlights4(files: F, diffs: D): Highlight[] {
	const h: Highlight[] = [];
	const d = diffs[3];
	if (d && files.length > 4) {
		for (const c of d) {
			processChunk(h, c, false, files[4] ?? null, files[3] ?? null);
		}
	}
	return h;
}

export function getPaneHighlights(
	paneIndex: number,
	files: (FileState | null)[],
	diffs: (DiffChunk[] | null)[],
	isLBC: boolean,
	isRBC: boolean,
): Highlight[] {
	switch (paneIndex) {
		case 0:
			return getHighlights0(files, diffs);
		case 1:
			return getHighlights1(files, diffs, isLBC);
		case 2:
			return getHighlights2(files, diffs);
		case 3:
			return getHighlights3(files, diffs, isRBC);
		case 4:
			return getHighlights4(files, diffs);
		default:
			return [];
	}
}
