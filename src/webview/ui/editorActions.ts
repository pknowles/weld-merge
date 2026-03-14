import type { editor } from "monaco-editor";
import type { DiffChunk } from "./types.ts";

/**
 * Gets the text for a specific chunk from a source model.
 */
export function getChunkText(
	model: editor.ITextModel,
	chunk: DiffChunk,
	targetLineCount: number,
): string {
	if (chunk.startB >= chunk.endB) {
		return "";
	}

	const sL = chunk.startB + 1;
	const eL = chunk.endB;
	const max = model.getLineCount();

	if (eL < max) {
		return model.getValueInRange({
			startLineNumber: sL,
			startColumn: 1,
			endLineNumber: eL + 1,
			endColumn: 1,
		});
	}

	let text = model.getValueInRange({
		startLineNumber: sL,
		startColumn: 1,
		endLineNumber: max,
		endColumn: model.getLineMaxColumn(max),
	});

	if (chunk.endA < targetLineCount && text !== "") {
		text += "\n";
	}
	return text;
}

/**
 * Applies a text change to a target editor at a specific chunk's location.
 */
export function applyChunkEdit(
	targetEditor: editor.IStandaloneCodeEditor,
	chunk: DiffChunk,
	text: string,
) {
	const model = targetEditor.getModel();
	if (!model) {
		return;
	}

	const sL = chunk.startA + 1;
	const eL = chunk.endA;
	const mMax = model.getLineCount();

	if (sL > mMax) {
		const maxCol = model.getLineMaxColumn(mMax);
		const formattedText =
			text && !text.startsWith("\n") ? `\n${text}` : text;
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: mMax,
					startColumn: maxCol,
					endLineNumber: mMax,
					endColumn: maxCol,
				},
				text: formattedText,
				forceMoveMarkers: true,
			},
		]);
	} else {
		const eLine = eL >= mMax ? mMax : eL + 1;
		const eCol = eL >= mMax ? model.getLineMaxColumn(mMax) : 1;
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: sL,
					startColumn: 1,
					endLineNumber: eLine,
					endColumn: eCol,
				},
				text,
				forceMoveMarkers: true,
			},
		]);
	}
}

/**
 * Deletes the target text corresponding to a chunk.
 */
export function deleteChunk(
	targetEditor: editor.IStandaloneCodeEditor,
	chunk: DiffChunk,
) {
	const model = targetEditor.getModel();
	if (!model || chunk.startA >= chunk.endA) {
		return;
	}

	const sL = chunk.startA + 1;
	const eL = chunk.endA;
	const mMax = model.getLineCount();

	if (eL >= mMax && sL > 1) {
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: sL - 1,
					startColumn: model.getLineMaxColumn(sL - 1),
					endLineNumber: mMax,
					endColumn: model.getLineMaxColumn(mMax),
				},
				text: "",
				forceMoveMarkers: true,
			},
		]);
	} else {
		const eLine = eL >= mMax ? mMax : eL + 1;
		const eCol = eL >= mMax ? model.getLineMaxColumn(mMax) : 1;
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: sL,
					startColumn: 1,
					endLineNumber: eLine,
					endColumn: eCol,
				},
				text: "",
				forceMoveMarkers: true,
			},
		]);
	}
}

/**
 * Copies the chunk text and inserts it BEFORE the target chunk location.
 */
export function copyUpChunk(
	targetEditor: editor.IStandaloneCodeEditor,
	chunk: DiffChunk,
	text: string,
) {
	const model = targetEditor.getModel();
	if (!(model && text)) {
		return;
	}

	const sL = chunk.startA + 1;
	const max = model.getLineCount();

	if (sL > max) {
		const formattedText = text.startsWith("\n") ? text : `\n${text}`;
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: max,
					startColumn: model.getLineMaxColumn(max),
					endLineNumber: max,
					endColumn: model.getLineMaxColumn(max),
				},
				text: formattedText,
				forceMoveMarkers: true,
			},
		]);
	} else {
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: sL,
					startColumn: 1,
					endLineNumber: sL,
					endColumn: 1,
				},
				text,
				forceMoveMarkers: true,
			},
		]);
	}
}

/**
 * Copies the chunk text and inserts it AFTER the target chunk location.
 */
export function copyDownChunk(
	targetEditor: editor.IStandaloneCodeEditor,
	chunk: DiffChunk,
	text: string,
) {
	const model = targetEditor.getModel();
	if (!(model && text)) {
		return;
	}

	const ins = chunk.endA + 1;
	const max = model.getLineCount();

	if (ins > max) {
		const formattedText = text.startsWith("\n") ? text : `\n${text}`;
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: max,
					startColumn: model.getLineMaxColumn(max),
					endLineNumber: max,
					endColumn: model.getLineMaxColumn(max),
				},
				text: formattedText,
				forceMoveMarkers: true,
			},
		]);
	} else {
		targetEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: ins,
					startColumn: 1,
					endLineNumber: ins,
					endColumn: 1,
				},
				text,
				forceMoveMarkers: true,
			},
		]);
	}
}
