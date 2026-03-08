// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { diffChars } from "diff";
import type { DiffChunk, FileState, Highlight } from "./types.ts";

// Must match the splitLines used in App.tsx
const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

export const processChunk = (
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
		const otherStartLine = useA ? chunk.startB : chunk.startA;
		const otherEndLine = useA ? chunk.endB : chunk.endA;

		if (!(innerFile && outerFile)) {
			return;
		}

		// Our text
		const myLines = splitLines(innerFile.content).slice(startLine, endLine);
		const myText = myLines.join("\n") + (myLines.length > 0 ? "\n" : "");

		// Other text
		const otherLines = splitLines(outerFile.content).slice(
			otherStartLine,
			otherEndLine,
		);
		const otherText =
			otherLines.join("\n") + (otherLines.length > 0 ? "\n" : "");

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

			// the diffChars output is relative to myText. So removed means it's in myText but not otherText
			if (change.removed) {
				highlights.push({
					startLine: currentLine,
					startColumn: currentColumn,
					endLine: nextLine,
					endColumn: nextColumn,
					isWholeLine: false,
					tag: "replace",
				});
			}

			// We only advance our position for text that exists in myText (removed or equal)
			if (!change.added) {
				currentLine = nextLine;
				currentColumn = nextColumn;
			}
		}
	}
};
