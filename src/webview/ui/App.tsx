// Copyright (C) 2002-2006 Stephen Kennedy <stevek@gnome.org>
// Copyright (C) 2009-2019 Kai Willadsen <kai.willadsen@gmail.com>
// Copyright (C) 2026 Pyarelal Knowles
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 2 of the License, or (at
// your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import debounce from "lodash.debounce";
import * as monaco from "monaco-editor";
import type { editor } from "monaco-editor";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Differ } from "../../matchers/diffutil";
import { CodePane } from "./CodePane";
import { DiffCurtain } from "./DiffCurtain";
import { diffChars } from "diff";
import type { DiffChunk, FileState, Highlight } from "./types";
import { ErrorBoundary } from "./ErrorBoundary";

interface VsCodeApi {
	postMessage: (msg: unknown) => void;
}

let vscodeApi: VsCodeApi | null = null;
try {
	vscodeApi = (
		window as unknown as { acquireVsCodeApi: () => VsCodeApi }
	).acquireVsCodeApi();
} catch (_e) {
	// Not in a VS Code webview
}

// Must match the splitLines used when initializing the Differ (in diffPayload.ts),
// which pops trailing empty strings. Module-level so it's a stable reference
// (does not need to appear in useCallback dependency arrays).
const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
};

const App: React.FC = () => {
	const [files, setFiles] = useState<FileState[]>([]);
	const filesRef = useRef<FileState[]>([]);
	const [diffs, setDiffs] = useState<DiffChunk[][]>([]);
	const diffsRef = useRef<DiffChunk[][]>([]);
	const differRef = useRef<Differ | null>(null);
	const [externalSyncId, setExternalSyncId] = useState(0);
	const [debounceDelay, setDebounceDelay] = useState(300);
	const [syntaxHighlighting, setSyntaxHighlighting] = useState(true);
	const [renderTrigger, setRenderTrigger] = useState(0);
	const editorRefs = useRef<editor.IStandaloneCodeEditor[]>([]);
	// Pending clipboard read requests: requestId -> resolve function
	const clipboardPendingRef = useRef<Map<number, (text: string) => void>>(new Map());
	const clipboardRequestIdRef = useRef(0);

	// Routes clipboard paste through the VS Code extension host because
	// navigator.clipboard.readText() is blocked in the webview sandbox.
	const requestClipboardText = React.useCallback((): Promise<string> => {
		const id = ++clipboardRequestIdRef.current;
		return new Promise<string>((resolve) => {
			clipboardPendingRef.current.set(id, resolve);
			vscodeApi?.postMessage({ command: "readClipboard", requestId: id });
			// Fallback: if not in a webview, try the browser clipboard directly
			if (!vscodeApi) {
				navigator.clipboard.readText().then(resolve).catch(() => resolve(""));
			}
		});
	}, []);

	const writeClipboardText = React.useCallback((text: string) => {
		vscodeApi?.postMessage({ command: "writeClipboard", text });
		if (!vscodeApi) {
			navigator.clipboard.writeText(text).catch(() => {});
		}
	}, []);
	// Index of the editor that initiated the current scroll sync.
	// While set, other editors' scroll handlers skip to avoid feedback loops.
	const syncingFrom = useRef<number | null>(null);

	const commitModelUpdate = React.useCallback((value: string) => {
		// All computation must happen outside the setFiles updater.
		// Calling setDiffs() inside setFiles(updater) is illegal in React — it causes
		// diffs to become undefined for a frame, DiffCurtain early-outs to null, and
		// the entire UI goes blank.
		const files = filesRef.current;
		if (!files || files.length !== 3) return;

		const oldMidLines = splitLines(files[1].content);
		const newMidLines = splitLines(value);

		let newDiffs: DiffChunk[][] | null = null;
		const differ = differRef.current;
		if (differ) {
			let startidx = 0;
			const minLen = Math.min(oldMidLines.length, newMidLines.length);
			while (startidx < minLen && oldMidLines[startidx] === newMidLines[startidx]) {
				startidx++;
			}
			const sizechange = newMidLines.length - oldMidLines.length;

			const leftLines = splitLines(files[0].content);
			const rightLines = splitLines(files[2].content);

			differ.change_sequence(
				1,
				startidx,
				sizechange,
				[leftLines, newMidLines, rightLines],
			);

			const leftDiffs = differ._merge_cache
				.map((pair) => pair[0])
				.filter((c): c is NonNullable<typeof c> => c !== null);
			const rightDiffs = differ._merge_cache
				.map((pair) => pair[1])
				.filter((c): c is NonNullable<typeof c> => c !== null);
			newDiffs = [leftDiffs, rightDiffs];
			diffsRef.current = newDiffs;
		}

		const newFiles = [...files];
		newFiles[1] = { ...newFiles[1], content: value };
		filesRef.current = newFiles;
		setFiles(newFiles);
		if (newDiffs !== null) {
			setDiffs(newDiffs);
		}
		setRenderTrigger((p) => p + 1);
	}, []);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.command === "loadDiff") {
				filesRef.current = message.data.files;
				setFiles(message.data.files);
				setDiffs(message.data.diffs);
				diffsRef.current = message.data.diffs;
				// We bump externalSyncId here because a loadDiff is conceptually an external sync
				// from the extension that provides entirely new file contents we need to push into Monaco
				// via computeMinimalEdits, preserving the undo stack.
				setExternalSyncId((id) => id + 1);
				if (message.data.config?.debounceDelay !== undefined) {
					setDebounceDelay(message.data.config.debounceDelay);
				}
				if (message.data.config?.syntaxHighlighting !== undefined) {
					setSyntaxHighlighting(message.data.config.syntaxHighlighting);
				}

				const localLines = splitLines(message.data.files[0].content);
				const midLines = splitLines(message.data.files[1].content);
				const rightLines = splitLines(message.data.files[2].content);

				const differ = new Differ();
				const init = differ.set_sequences_iter([
					localLines,
					midLines,
					rightLines,
				]);
				let step = init.next();
				while (!step.done) {
					step = init.next();
				}
				differRef.current = differ;

				setTimeout(() => setRenderTrigger((prev) => prev + 1), 500);
			} else if (message.command === "updateContent") {
				setExternalSyncId((id) => id + 1);
				commitModelUpdate(message.text);
			} else if (message.command === "updateConfig") {
				if (message.config?.debounceDelay !== undefined) {
					setDebounceDelay(message.config.debounceDelay);
				}
				if (message.config?.syntaxHighlighting !== undefined) {
					setSyntaxHighlighting(message.config.syntaxHighlighting);
				}
			} else if (message.command === "clipboardText") {
				const resolve = clipboardPendingRef.current.get(message.requestId);
				if (resolve) {
					clipboardPendingRef.current.delete(message.requestId);
					resolve(message.text as string);
				}
			}
		};
		window.addEventListener("message", handleMessage);

		if (vscodeApi) {
			vscodeApi.postMessage({ command: "ready" });
		}

		const handleClipboard = (e: ClipboardEvent) => {
			const activeEditor = editorRefs.current.find((ed) => ed?.hasWidgetFocus());
			if (!activeEditor) return;

			if (e.type === "paste") {
				if (!activeEditor.getOption(monaco.editor.EditorOption.readOnly)) {
					e.preventDefault();
					requestClipboardText().then((text) => {
						activeEditor.trigger("keyboard", "paste", { text });
					});
				}
				return;
			}

			// Copy or Cut
			const selection = activeEditor.getSelection();
			if (!selection) return;

			const model = activeEditor.getModel();
			if (!model) return;

			let text = "";
			let rangeToDelete = selection;

			if (!selection.isEmpty()) {
				text = model.getValueInRange(selection);
			} else {
				// Empty selection: copy/cut the whole line (matching native behavior)
				const line = selection.startLineNumber;
				text = `${model.getLineContent(line)}\n`;
				rangeToDelete = new monaco.Selection(line, 1, line + 1, 1);
			}

			if (text) {
				e.preventDefault();
				writeClipboardText(text);
				if (
					e.type === "cut" &&
					!activeEditor.getOption(monaco.editor.EditorOption.readOnly)
				) {
					activeEditor.executeEdits("cut", [{ range: rangeToDelete, text: "" }]);
				}
			}
		};

		document.addEventListener("copy", handleClipboard);
		document.addEventListener("cut", handleClipboard);
		document.addEventListener("paste", handleClipboard);

		return () => {
			window.removeEventListener("message", handleMessage);
			document.removeEventListener("copy", handleClipboard);
			document.removeEventListener("cut", handleClipboard);
			document.removeEventListener("paste", handleClipboard);
		};
	}, [commitModelUpdate, requestClipboardText, writeClipboardText]);

	const attachScrollListener = (
		ed: editor.IStandaloneCodeEditor,
		edIndex: number,
	) => {
		// Using proper Monaco scroll event type from the top-level namespace
		return ed.onDidScrollChange((e: monaco.IScrollEvent) => {
			setRenderTrigger((prev) => prev + 1);

			if (syncingFrom.current !== null && syncingFrom.current !== edIndex)
				return;

			const dRef = diffsRef.current;

			const mapLineWithDiff = (
				sLine: number,
				diff: DiffChunk[],
				sourceIsA: boolean,
				tIndex: number,
			): number => {
				const maxLines = editorRefs.current[tIndex]?.getModel()?.getLineCount() || 1;
				
				if (!diff || diff.length === 0) return Math.min(sLine, maxLines);
				let lastChunk = diff[0];
				for (const chunk of diff) {
					const sStart = sourceIsA ? chunk.start_a : chunk.start_b;
					const sEnd = sourceIsA ? chunk.end_a : chunk.end_b;
					const tStart = sourceIsA ? chunk.start_b : chunk.start_a;
					const tEnd = sourceIsA ? chunk.end_b : chunk.end_a;

					if (sLine >= sStart && sLine < sEnd) {
						if (chunk.tag === "equal") {
							return Math.min(tStart + (sLine - sStart), maxLines);
						}
						const sLen = sEnd - sStart;
						const tLen = tEnd - tStart;
						const ratio = sLen > 0 ? (sLine - sStart) / sLen : 0;
						return Math.min(tStart + ratio * tLen, maxLines);
					}
					lastChunk = chunk;
				}
				const sEnd = sourceIsA ? lastChunk.end_a : lastChunk.end_b;
				const tEnd = sourceIsA ? lastChunk.end_b : lastChunk.end_a;
				return Math.min(tEnd + (sLine - sEnd), maxLines);
			};

			const mapLine = (sLine: number, sIdx: number, tIdx: number): number => {
				if (sIdx === 0 && tIdx === 1)
					return mapLineWithDiff(sLine, dRef[0], false, 1);
				if (sIdx === 1 && tIdx === 0)
					return mapLineWithDiff(sLine, dRef[0], true, 0);
				if (sIdx === 1 && tIdx === 2)
					return mapLineWithDiff(sLine, dRef[1], true, 2);
				if (sIdx === 2 && tIdx === 1)
					return mapLineWithDiff(sLine, dRef[1], false, 1);
				return sLine;
			};
			if (e.scrollTopChanged) {
				let lineHeight = ed.getTopForLineNumber(2) - ed.getTopForLineNumber(1);
				if (lineHeight <= 0) lineHeight = 19;
				const sourceLine = Math.max(0, e.scrollTop) / lineHeight;

				syncingFrom.current = edIndex;
				editorRefs.current.forEach((otherEditor, i) => {
					if (i !== edIndex && otherEditor) {
						let targetLine = sourceLine;
						if (edIndex === 0 && i === 1)
							targetLine = mapLine(sourceLine, 0, 1);
						else if (edIndex === 0 && i === 2)
							targetLine = mapLine(mapLine(sourceLine, 0, 1), 1, 2);
						else if (edIndex === 1 && i === 0)
							targetLine = mapLine(sourceLine, 1, 0);
						else if (edIndex === 1 && i === 2)
							targetLine = mapLine(sourceLine, 1, 2);
						else if (edIndex === 2 && i === 1)
							targetLine = mapLine(sourceLine, 2, 1);
						else if (edIndex === 2 && i === 0)
							targetLine = mapLine(mapLine(sourceLine, 2, 1), 1, 0);

						const targetScrollTop = targetLine * lineHeight;
						if (Math.abs(otherEditor.getScrollTop() - targetScrollTop) > 2) {
							otherEditor.setScrollTop(targetScrollTop);
						}
					}
				});
				syncingFrom.current = null;
			}

			if (e.scrollLeftChanged) {
				syncingFrom.current = edIndex;
				editorRefs.current.forEach((otherEditor, i) => {
					if (i !== edIndex && otherEditor) {
						if (Math.abs(otherEditor.getScrollLeft() - e.scrollLeft) > 2) {
							otherEditor.setScrollLeft(e.scrollLeft);
						}
					}
				});
				syncingFrom.current = null;
			}
		});
	};

	const handleEditorMount = (
		editor: editor.IStandaloneCodeEditor,
		index: number,
	) => {
		editorRefs.current[index] = editor;
		attachScrollListener(editor, index);
	};

	const handleEditorChange = React.useMemo(
		() =>
			debounce((value: string | undefined, index: number) => {
				if (value === undefined || index !== 1 || files.length !== 3) return;

				commitModelUpdate(value);

				vscodeApi?.postMessage({ command: "contentChanged", text: value });
			}, debounceDelay),
		[debounceDelay, files.length, commitModelUpdate],
	);

	const getHighlights = React.useCallback((paneIndex: number) => {
		const highlights: Highlight[] = [];
		if (files.length !== 3) return highlights;

		const processChunk = (
			chunk: DiffChunk,
			isMidPane: boolean,
			diffIndex: number
		) => {
			if (chunk.tag === "equal") return;
			const startLine = isMidPane ? chunk.start_a : chunk.start_b;
			const endLine = isMidPane ? chunk.end_a : chunk.end_b;

			highlights.push({
				startLine: startLine + 1,
				startColumn: 1,
				endLine: endLine,
				endColumn: 1,
				isWholeLine: true,
				tag: chunk.tag,
			});

			if (chunk.tag === "replace" && startLine < endLine) {
				const outerPaneIndex = diffIndex === 0 ? 0 : 2;
				const otherStartLine = isMidPane ? chunk.start_b : chunk.start_a;
				const otherEndLine = isMidPane ? chunk.end_b : chunk.end_a;

				// Our text
				const myLines = splitLines(files[paneIndex].content).slice(startLine, endLine);
				const myText = myLines.join("\n") + (myLines.length > 0 ? "\n" : "");

				// Other text
				const otherLines = splitLines(files[isMidPane ? outerPaneIndex : 1].content).slice(otherStartLine, otherEndLine);
				const otherText = otherLines.join("\n") + (otherLines.length > 0 ? "\n" : "");

				const changes = diffChars(myText, otherText);
				let currentLine = startLine + 1;
				let currentColumn = 1;

				for (const change of changes) {
					const lines = change.value.split("\n");
					const nextLine = currentLine + lines.length - 1;
					const nextColumn = lines.length === 1 ? currentColumn + lines[0].length : lines[lines.length - 1].length + 1;

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

		if (paneIndex === 0 && diffs[0]) {
			diffs[0].forEach((d) => { processChunk(d, false, 0); });
		} else if (paneIndex === 1) {
			if (diffs[0]) {
				diffs[0].forEach((d) => { processChunk(d, true, 0); });
			}
			if (diffs[1]) {
				diffs[1].forEach((d) => { processChunk(d, true, 1); });
			}
		} else if (paneIndex === 2 && diffs[1]) {
			diffs[1].forEach((d) => { processChunk(d, false, 1); });
		}
		return highlights;
	}, [diffs, files]);

	const handleApplyChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex === 0 ? 0 : 2;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[1];
		if (!sourceEditor || !mergedEditor) return;
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!sourceModel || !mergedModel) return;

		let sourceText = "";
		if (chunk.start_b < chunk.end_b) {
			const startLine = chunk.start_b + 1;
			const endLine = chunk.end_b;
			const maxEndLine = sourceModel.getLineCount();
			if (endLine < maxEndLine) {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine + 1,
					endColumn: 1
				});
			} else {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: maxEndLine,
					endColumn: sourceModel.getLineMaxColumn(maxEndLine)
				});
				if (chunk.end_a < mergedModel.getLineCount() && sourceText !== "") {
					sourceText += "\n";
				}
			}
		}

		let startLine = chunk.start_a + 1;
		const endLine = chunk.end_a;
		const mergedMaxLine = mergedModel.getLineCount();

		let eLine = endLine + 1;
		let eCol = 1;
		if (endLine >= mergedMaxLine) {
			eLine = mergedMaxLine;
			eCol = mergedModel.getLineMaxColumn(mergedMaxLine);
		}
		
		if (startLine > mergedMaxLine) {
			startLine = mergedMaxLine;
			eLine = mergedMaxLine;
			const maxCol = mergedModel.getLineMaxColumn(mergedMaxLine);
			if (sourceText && !sourceText.startsWith("\n")) {
				sourceText = `\n${sourceText}`;
			}
			mergedEditor.executeEdits("meld-action", [{
				range: { startLineNumber: startLine, startColumn: maxCol, endLineNumber: eLine, endColumn: maxCol },
				text: sourceText,
				forceMoveMarkers: true
			}]);
			return;
		}

		mergedEditor.executeEdits("meld-action", [{
			range: {
				startLineNumber: startLine,
				startColumn: 1,
				endLineNumber: eLine,
				endColumn: eCol
			},
			text: sourceText,
			forceMoveMarkers: true
		}]);
	};

	const handleDeleteChunk = (_paneIndex: number, chunk: DiffChunk) => {
		const mergedEditor = editorRefs.current[1];
		if (!mergedEditor) return;
		const mergedModel = mergedEditor.getModel();
		if (!mergedModel) return;
		
		if (chunk.start_a >= chunk.end_a) return;

		let startLine = chunk.start_a + 1;
		const endLine = chunk.end_a;
		const mergedMaxLine = mergedModel.getLineCount();

		let eLine = endLine + 1;
		let eCol = 1;
		if (endLine >= mergedMaxLine) {
			eLine = mergedMaxLine;
			eCol = mergedModel.getLineMaxColumn(mergedMaxLine);
			if (startLine > 1) {
				startLine -= 1;
				eCol = mergedModel.getLineMaxColumn(mergedMaxLine);
				mergedEditor.executeEdits("meld-action", [{
					range: {
						startLineNumber: startLine,
						startColumn: mergedModel.getLineMaxColumn(startLine),
						endLineNumber: eLine,
						endColumn: eCol
					},
					text: "",
					forceMoveMarkers: true
				}]);
				return;
			}
		}

		mergedEditor.executeEdits("meld-action", [{
			range: {
				startLineNumber: startLine,
				startColumn: 1,
				endLineNumber: eLine,
				endColumn: eCol
			},
			text: "",
			forceMoveMarkers: true
		}]);
	};

	const handleCopyUpChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex === 0 ? 0 : 2;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[1];
		if (!sourceEditor || !mergedEditor) return;
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!sourceModel || !mergedModel) return;

		let sourceText = "";
		if (chunk.start_b < chunk.end_b) {
			const startLine = chunk.start_b + 1;
			const endLine = chunk.end_b;
			const maxEndLine = sourceModel.getLineCount();
			if (endLine < maxEndLine) {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine + 1,
					endColumn: 1
				});
			} else {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: maxEndLine,
					endColumn: sourceModel.getLineMaxColumn(maxEndLine)
				});
				sourceText += "\n";
			}
		}

		if (!sourceText) return;

		const startLine = chunk.start_a + 1;
		const maxLine = mergedModel.getLineCount();
		if (startLine > maxLine) {
			const maxCol = mergedModel.getLineMaxColumn(maxLine);
			if (!sourceText.startsWith("\n")) {
				sourceText = `\n${sourceText}`;
			}
			mergedEditor.executeEdits("meld-action", [{
				range: { startLineNumber: maxLine, startColumn: maxCol, endLineNumber: maxLine, endColumn: maxCol },
				text: sourceText,
				forceMoveMarkers: true
			}]);
			return;
		}

		mergedEditor.executeEdits("meld-action", [{
			range: {
				startLineNumber: startLine,
				startColumn: 1,
				endLineNumber: startLine,
				endColumn: 1
			},
			text: sourceText,
			forceMoveMarkers: true
		}]);
	};

	const handleCopyDownChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex === 0 ? 0 : 2;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[1];
		if (!sourceEditor || !mergedEditor) return;
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!sourceModel || !mergedModel) return;

		let sourceText = "";
		if (chunk.start_b < chunk.end_b) {
			const startLine = chunk.start_b + 1;
			const endLine = chunk.end_b;
			const maxEndLine = sourceModel.getLineCount();
			if (endLine < maxEndLine) {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine + 1,
					endColumn: 1
				});
			} else {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: maxEndLine,
					endColumn: sourceModel.getLineMaxColumn(maxEndLine)
				});
				if (chunk.end_a < mergedModel.getLineCount() && sourceText !== "") {
					sourceText += "\n";
				}
			}
		}

		if (!sourceText) return;

		const endLine = chunk.end_a;
		const maxLine = mergedModel.getLineCount();
		const insertLine = endLine + 1;
		
		if (insertLine > maxLine) {
			const maxCol = mergedModel.getLineMaxColumn(maxLine);
			if (sourceText && !sourceText.startsWith("\n")) {
				sourceText = `\n${sourceText}`;
			}
			mergedEditor.executeEdits("meld-action", [{
				range: { startLineNumber: maxLine, startColumn: maxCol, endLineNumber: maxLine, endColumn: maxCol },
				text: sourceText,
				forceMoveMarkers: true
			}]);
			return;
		}

		mergedEditor.executeEdits("meld-action", [{
			range: {
				startLineNumber: insertLine,
				startColumn: 1,
				endLineNumber: insertLine,
				endColumn: 1
			},
			text: sourceText,
			forceMoveMarkers: true
		}]);
	};

	const handleCopyHash = (hash: string) => {
		vscodeApi?.postMessage({ command: "copyHash", hash });
	};

	const handleShowDiff = (paneIndex: number) => {
		vscodeApi?.postMessage({ command: "showDiff", paneIndex });
	};

	const handleCompleteMerge = () => {
		vscodeApi?.postMessage({ command: "completeMerge" });
	};

	return (
		<ErrorBoundary>
			<div
				style={{
					display: "flex",
					width: "100vw",
					height: "100vh",
					flexDirection: "row",
					backgroundColor: "#1e1e1e",
					overflow: "hidden",
				}}
			>
				<style>{`
					.diff-insert { background-color: var(--vscode-meldMerge-diffInsertBackground, rgba(0, 200, 0, 0.15)) !important; }
					.diff-delete { background-color: var(--vscode-meldMerge-diffDeleteBackground, rgba(0, 200, 0, 0.15)) !important; }
					.diff-replace { background-color: var(--vscode-meldMerge-diffReplaceBackground, rgba(0, 100, 255, 0.15)) !important; }
					.diff-conflict { background-color: var(--vscode-meldMerge-diffConflictBackground, rgba(255, 0, 0, 0.15)) !important; }
					.diff-replace-inline { background-color: var(--vscode-meldMerge-diffReplaceInlineBackground, rgba(0, 100, 255, 0.35)) !important; }
				`}</style>
				{files.length === 0 ? (
					<div
						style={{ color: "white", padding: "20px", fontFamily: "sans-serif" }}
					>
						Loading Diff...
					</div>
				) : (
					files.map((file, index) => (
						<React.Fragment key={file.label}>
							<CodePane
								file={file}
								index={index}
								onMount={handleEditorMount}
								onChange={handleEditorChange}
								isMiddle={index === 1}
								highlights={getHighlights(index)}
								onCompleteMerge={index === 1 ? handleCompleteMerge : undefined}
								onCopyHash={handleCopyHash}
								onShowDiff={() => handleShowDiff(index)}
								externalSyncId={index === 1 ? externalSyncId : undefined}
								requestClipboardText={index === 1 ? requestClipboardText : undefined}
								writeClipboardText={writeClipboardText}
								syntaxHighlighting={syntaxHighlighting}
							/>
							{index < files.length - 1 && (
								<DiffCurtain
									diffs={diffs[index]}
									leftEditor={editorRefs.current[index]}
									rightEditor={editorRefs.current[index + 1]}
									renderTrigger={renderTrigger}
									reversed={index === 0}
									onApplyChunk={(chunk) => handleApplyChunk(index, chunk)}
									onDeleteChunk={(chunk) => handleDeleteChunk(index, chunk)}
									onCopyUpChunk={(chunk) => handleCopyUpChunk(index, chunk)}
									onCopyDownChunk={(chunk) => handleCopyDownChunk(index, chunk)}
								/>
							)}
						</React.Fragment>
					))
				)}
			</div>
		</ErrorBoundary>
	);
};

export default App;
