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

const validatePoint = (lines: string[], point: TextPoint) => {
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
};

const applyRangeReplacement = (
	lines: string[],
	start: TextPoint,
	end: TextPoint,
	text: string,
): void => {
	validatePoint(lines, start);
	validatePoint(lines, end);
	if (
		end.lineIndex < start.lineIndex ||
		(end.lineIndex === start.lineIndex &&
			end.columnIndex < start.columnIndex)
	) {
		throw new Error("content change range end precedes start");
	}
	const startLine = lines[start.lineIndex];
	const endLine = lines[end.lineIndex];
	if (startLine === undefined || endLine === undefined) {
		throw new Error("validated edit range disappeared");
	}
	const insertedLines = splitLines(text);
	const firstInserted = insertedLines[0];
	const lastInserted = insertedLines.at(-1);
	if (firstInserted === undefined || lastInserted === undefined) {
		throw new Error("split edit text unexpectedly produced no lines");
	}
	const replacement =
		insertedLines.length === 1
			? [
					`${startLine.slice(0, start.columnIndex)}${firstInserted}${endLine.slice(end.columnIndex)}`,
				]
			: [
					`${startLine.slice(0, start.columnIndex)}${firstInserted}`,
					...insertedLines.slice(1, -1),
					`${lastInserted}${endLine.slice(end.columnIndex)}`,
				];
	lines.splice(
		start.lineIndex,
		end.lineIndex - start.lineIndex + 1,
		...replacement,
	);
};

const isNonEmptyRange = (change: MonacoContentChange): boolean =>
	change.range.startLineNumber !== change.range.endLineNumber ||
	change.range.startColumn !== change.range.endColumn;

function applyMeldStyleContentChanges(
	differ: Differ,
	localLines: string[],
	mergedLines: string[],
	remoteLines: string[],
	changes: MonacoContentChange[],
): void {
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
			applyRangeReplacement(mergedLines, start, end, "");
			differ.changeSequence(1, start.lineIndex, -deletedLines, [
				localLines,
				mergedLines,
				remoteLines,
			]);
		}

		if (change.text !== "") {
			applyRangeReplacement(mergedLines, start, start, change.text);
			differ.changeSequence(1, start.lineIndex, insertedLines, [
				localLines,
				mergedLines,
				remoteLines,
			]);
		}
	}
}

function contentChangeForFullReplacementFromLines(
	oldLines: string[],
	newContent: string,
): MonacoContentChange {
	const lastLine = oldLines.at(-1);
	if (lastLine === undefined) {
		throw new Error("line content unexpectedly has no lines");
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

export {
	applyMeldStyleContentChanges,
	contentChangeForFullReplacementFromLines,
	splitLines,
};
