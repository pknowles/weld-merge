import type { Differ } from "../../matchers/diffutil.ts";
import type { MonacoContentChange } from "./types.ts";

interface TextPoint {
	lineIndex: number;
	columnIndex: number;
}

const splitLines = (content: string): string[] => content.split("\n");

const countLineBreaks = (text: string): number => text.split("\n").length - 1;

const compareChangesDescending = (
	left: MonacoContentChange,
	right: MonacoContentChange,
): number => {
	if (left.range.startLineNumber !== right.range.startLineNumber) {
		return right.range.startLineNumber - left.range.startLineNumber;
	}
	return right.range.startColumn - left.range.startColumn;
};

const offsetAt = (content: string, point: TextPoint): number => {
	let offset = 0;
	const lines = splitLines(content);
	for (let i = 0; i < point.lineIndex; i++) {
		const line = lines[i];
		if (line === undefined) {
			throw new Error(`line ${i} missing while applying content change`);
		}
		offset += line.length + 1;
	}
	const line = lines[point.lineIndex];
	if (line === undefined) {
		throw new Error(
			`line ${point.lineIndex} missing while applying content change`,
		);
	}
	if (point.columnIndex > line.length) {
		throw new Error(
			`column ${point.columnIndex} exceeds line ${point.lineIndex} length ${line.length}`,
		);
	}
	return offset + point.columnIndex;
};

const applyRangeReplacement = (
	content: string,
	start: TextPoint,
	end: TextPoint,
	text: string,
): string => {
	const startOffset = offsetAt(content, start);
	const endOffset = offsetAt(content, end);
	if (endOffset < startOffset) {
		throw new Error("content change range end precedes start");
	}
	return `${content.slice(0, startOffset)}${text}${content.slice(endOffset)}`;
};

const isNonEmptyRange = (change: MonacoContentChange): boolean =>
	change.range.startLineNumber !== change.range.endLineNumber ||
	change.range.startColumn !== change.range.endColumn;

function applyMeldStyleContentChanges(
	differ: Differ,
	localLines: string[],
	mergedContent: string,
	remoteLines: string[],
	changes: MonacoContentChange[],
): string {
	let content = mergedContent;
	const sortedChanges = changes.slice().sort(compareChangesDescending);

	for (const change of sortedChanges) {
		const start = {
			lineIndex: change.range.startLineNumber - 1,
			columnIndex: change.range.startColumn - 1,
		};
		const end = {
			lineIndex: change.range.endLineNumber - 1,
			columnIndex: change.range.endColumn - 1,
		};
		const deletedLines =
			change.range.endLineNumber - change.range.startLineNumber;
		const insertedLines = countLineBreaks(change.text);

		if (isNonEmptyRange(change)) {
			content = applyRangeReplacement(content, start, end, "");
			differ.changeSequence(1, start.lineIndex, -deletedLines, [
				localLines,
				splitLines(content),
				remoteLines,
			]);
		}

		if (change.text !== "") {
			content = applyRangeReplacement(content, start, start, change.text);
			differ.changeSequence(1, start.lineIndex, insertedLines, [
				localLines,
				splitLines(content),
				remoteLines,
			]);
		}
	}

	return content;
}

function contentChangeForFullReplacement(
	oldContent: string,
	newContent: string,
): MonacoContentChange {
	const oldLines = splitLines(oldContent);
	const lastLine = oldLines.at(-1);
	if (lastLine === undefined) {
		throw new Error("split content unexpectedly produced no lines");
	}
	return {
		range: {
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: oldLines.length,
			endColumn: lastLine.length + 1,
		},
		text: newContent,
	};
}

export { applyMeldStyleContentChanges, contentChangeForFullReplacement };
