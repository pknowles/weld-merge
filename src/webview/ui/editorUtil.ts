// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { diffLines } from "diff";
import type { editor } from "monaco-editor";

export const computeMinimalEdits = (
	model: editor.ITextModel,
	newText: string,
): editor.IIdentifiedSingleEditOperation[] => {
	const originalText = model.getValue();
	if (originalText === newText) {
		return [];
	}

	const changes = diffLines(originalText, newText);
	let currentOffset = 0;
	const edits: editor.IIdentifiedSingleEditOperation[] = [];

	for (const change of changes) {
		const changeLen = change.value.length;
		if (change.added) {
			const pos = model.getPositionAt(currentOffset);
			edits.push({
				range: {
					startLineNumber: pos.lineNumber,
					startColumn: pos.column,
					endLineNumber: pos.lineNumber,
					endColumn: pos.column,
				},
				text: change.value,
			});
		} else if (change.removed) {
			const startPos = model.getPositionAt(currentOffset);
			const endPos = model.getPositionAt(currentOffset + changeLen);
			edits.push({
				range: {
					startLineNumber: startPos.lineNumber,
					startColumn: startPos.column,
					endLineNumber: endPos.lineNumber,
					endColumn: endPos.column,
				},
				text: "",
			});
			currentOffset += changeLen;
		} else {
			currentOffset += changeLen;
		}
	}
	return edits;
};
