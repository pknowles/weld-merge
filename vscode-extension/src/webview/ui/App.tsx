import debounce from "lodash.debounce";
import type * as monaco from "monaco-editor";
import type { editor } from "monaco-editor";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Differ } from "../../matchers/diffutil";
import { CodePane } from "./CodePane";
import { DiffCurtain } from "./DiffCurtain";
import type { DiffChunk, FileState } from "./types";

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

const App: React.FC = () => {
	const [files, setFiles] = useState<FileState[]>([]);
	const [diffs, setDiffs] = useState<DiffChunk[][]>([]);
	const diffsRef = useRef<DiffChunk[][]>([]);
	const differRef = useRef<Differ | null>(null);
	const [externalSyncId, setExternalSyncId] = useState(0);
	const [debounceDelay, setDebounceDelay] = useState(300);
	const [renderTrigger, setRenderTrigger] = useState(0);
	const editorRefs = useRef<editor.IStandaloneCodeEditor[]>([]);
	// Index of the editor that initiated the current scroll sync.
	// While set, other editors' scroll handlers skip to avoid feedback loops.
	const syncingFrom = useRef<number | null>(null);

	const commitModelUpdate = React.useCallback((value: string) => {
		setFiles((prev) => {
			if (prev.length !== 3) return prev;

			const newFiles = [...prev];
			const oldMidLines = newFiles[1].content.split("\n");
			newFiles[1] = { ...newFiles[1], content: value };
			const newMidLines = value.split("\n");

			const differ = differRef.current;
			if (differ) {
				let startidx = 0;
				const minLen = Math.min(oldMidLines.length, newMidLines.length);
				while (startidx < minLen && oldMidLines[startidx] === newMidLines[startidx]) {
					startidx++;
				}
				const sizechange = newMidLines.length - oldMidLines.length;

				const leftLines = newFiles[0].content.split("\n");
				const rightLines = newFiles[2].content.split("\n");

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
				const newDiffs = [leftDiffs, rightDiffs];
				setDiffs(newDiffs);
				diffsRef.current = newDiffs;
			}

			setRenderTrigger((p) => p + 1);
			return newFiles;
		});
	}, []);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.command === "loadDiff") {
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

				const splitLines = (text: string) => {
					const lines = text.split("\n");
					if (lines.length > 0 && lines[lines.length - 1] === "") {
						lines.pop();
					}
					return lines;
				};
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
			}
		};
		window.addEventListener("message", handleMessage);

		if (vscodeApi) {
			vscodeApi.postMessage({ command: "ready" });
		}

		return () => window.removeEventListener("message", handleMessage);
	}, [commitModelUpdate]);

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
			): number => {
				if (!diff || diff.length === 0) return sLine;
				let lastChunk = diff[0];
				for (const chunk of diff) {
					const sStart = sourceIsA ? chunk.start_a : chunk.start_b;
					const sEnd = sourceIsA ? chunk.end_a : chunk.end_b;
					const tStart = sourceIsA ? chunk.start_b : chunk.start_a;
					const tEnd = sourceIsA ? chunk.end_b : chunk.end_a;

					if (sLine >= sStart && sLine < sEnd) {
						if (chunk.tag === "equal") {
							return tStart + (sLine - sStart);
						}
						const sLen = sEnd - sStart;
						const tLen = tEnd - tStart;
						const ratio = sLen > 0 ? (sLine - sStart) / sLen : 0;
						return tStart + ratio * tLen;
					}
					lastChunk = chunk;
				}
				const sEnd = sourceIsA ? lastChunk.end_a : lastChunk.end_b;
				const tEnd = sourceIsA ? lastChunk.end_b : lastChunk.end_a;
				return tEnd + (sLine - sEnd);
			};

			const mapLine = (sLine: number, sIdx: number, tIdx: number): number => {
				if (sIdx === 0 && tIdx === 1)
					return mapLineWithDiff(sLine, dRef[0], false);
				if (sIdx === 1 && tIdx === 0)
					return mapLineWithDiff(sLine, dRef[0], true);
				if (sIdx === 1 && tIdx === 2)
					return mapLineWithDiff(sLine, dRef[1], true);
				if (sIdx === 2 && tIdx === 1)
					return mapLineWithDiff(sLine, dRef[1], false);
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

	const getHighlights = (paneIndex: number) => {
		const highlights: { start: number; end: number; tag: string }[] = [];
		if (paneIndex === 0 && diffs[0]) {
			diffs[0].forEach((d) => {
				if (d.tag !== "equal") {
					highlights.push({ start: d.start_b + 1, end: d.end_b, tag: d.tag });
				}
			});
		} else if (paneIndex === 1) {
			if (diffs[0]) {
				diffs[0].forEach((d) => {
					if (d.tag !== "equal") {
						highlights.push({ start: d.start_a + 1, end: d.end_a, tag: d.tag });
					}
				});
			}
			if (diffs[1]) {
				diffs[1].forEach((d) => {
					if (d.tag !== "equal") {
						highlights.push({ start: d.start_a + 1, end: d.end_a, tag: d.tag });
					}
				});
			}
		} else if (paneIndex === 2 && diffs[1]) {
			diffs[1].forEach((d) => {
				if (d.tag !== "equal") {
					highlights.push({ start: d.start_b + 1, end: d.end_b, tag: d.tag });
				}
			});
		}
		return highlights;
	};

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
				.diff-insert { background-color: rgba(0, 200, 0, 0.15) !important; }
				.diff-delete { background-color: rgba(0, 200, 0, 0.15) !important; }
				.diff-replace { background-color: rgba(0, 100, 255, 0.15) !important; }
				.diff-conflict { background-color: rgba(255, 0, 0, 0.15) !important; }
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
	);
};

export default App;
