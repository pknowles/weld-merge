import * as React from "react";
import { useState, useEffect, useRef } from "react";
import type { FileState, DiffChunk } from "./types";
import { CodePane } from "./CodePane";
import { DiffCurtain } from "./DiffCurtain";
import type { editor } from "monaco-editor";
import { MyersSequenceMatcher } from "../../matchers/myers";
import debounce from "lodash.debounce";

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
	const [renderTrigger, setRenderTrigger] = useState(0);
	const editorRefs = useRef<editor.IStandaloneCodeEditor[]>([]);
	// Index of the editor that initiated the current scroll sync.
	// While set, other editors' scroll handlers skip to avoid feedback loops.
	const syncingFrom = useRef<number | null>(null);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.command === "loadDiff") {
				setFiles(message.data.files);
				setDiffs(message.data.diffs);
				diffsRef.current = message.data.diffs;
				// Trigger an initial render to draw SVGs once editors mount
				setTimeout(() => setRenderTrigger((prev) => prev + 1), 500);
			}
		};
		window.addEventListener("message", handleMessage);

		if (vscodeApi) {
			vscodeApi.postMessage({ command: "ready" });
		}

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const attachScrollListener = (ed: editor.IStandaloneCodeEditor, edIndex: number) => {
		return ed.onDidScrollChange((e: any) => {
			setRenderTrigger((prev) => prev + 1);

			// If another editor is currently driving sync, we're a passenger — skip.
			if (syncingFrom.current !== null && syncingFrom.current !== edIndex) return;

			const dRef = diffsRef.current;

			const mapLineWithDiff = (sLine: number, diff: DiffChunk[], sourceIsA: boolean): number => {
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
						} else {
							const sLen = sEnd - sStart;
							const tLen = tEnd - tStart;
							const ratio = sLen > 0 ? (sLine - sStart) / sLen : 0;
							return tStart + ratio * tLen;
						}
					}
					lastChunk = chunk;
				}
				const sEnd = sourceIsA ? lastChunk.end_a : lastChunk.end_b;
				const tEnd = sourceIsA ? lastChunk.end_b : lastChunk.end_a;
				return tEnd + (sLine - sEnd);
			};

			const mapLine = (sLine: number, sIdx: number, tIdx: number): number => {
				if (sIdx === 0 && tIdx === 1) return mapLineWithDiff(sLine, dRef[0], true);
				if (sIdx === 1 && tIdx === 0) return mapLineWithDiff(sLine, dRef[0], false);
				if (sIdx === 1 && tIdx === 2) return mapLineWithDiff(sLine, dRef[1], true);
				if (sIdx === 2 && tIdx === 1) return mapLineWithDiff(sLine, dRef[1], false);
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
						if (edIndex === 0 && i === 1) targetLine = mapLine(sourceLine, 0, 1);
						else if (edIndex === 0 && i === 2) targetLine = mapLine(mapLine(sourceLine, 0, 1), 1, 2);
						else if (edIndex === 1 && i === 0) targetLine = mapLine(sourceLine, 1, 0);
						else if (edIndex === 1 && i === 2) targetLine = mapLine(sourceLine, 1, 2);
						else if (edIndex === 2 && i === 1) targetLine = mapLine(sourceLine, 2, 1);
						else if (edIndex === 2 && i === 0) targetLine = mapLine(mapLine(sourceLine, 2, 1), 1, 0);

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

	const handleEditorChange = debounce(
		(value: string | undefined, index: number) => {
			if (value === undefined || index !== 1 || files.length !== 3) return;

			setFiles((prev) => {
				const newFiles = [...prev];
				newFiles[1] = { ...newFiles[1], content: value };

				// Recalculate diffs locally
				const leftLines = newFiles[0].content.split("\n");
				const midLines = newFiles[1].content.split("\n");
				const rightLines = newFiles[2].content.split("\n");

				const leftDiffs = new MyersSequenceMatcher(
					null,
					leftLines,
					midLines,
				).get_difference_opcodes();
				const rDiffs = new MyersSequenceMatcher(
					null,
					midLines,
					rightLines,
				).get_difference_opcodes();

				setDiffs([leftDiffs, rDiffs]);
				diffsRef.current = [leftDiffs, rDiffs];
				setRenderTrigger((p) => p + 1);
				return newFiles;
			});
		},
		150,
	);

	const getHighlights = (paneIndex: number) => {
		const highlights: { start: number; end: number; tag: string }[] = [];
		if (paneIndex === 0 && diffs[0]) {
			diffs[0].forEach((d) => {
				if (d.tag !== "equal") {
					highlights.push({ start: d.start_a + 1, end: d.end_a, tag: d.tag });
				}
			});
		} else if (paneIndex === 1) {
			if (diffs[0]) {
				diffs[0].forEach((d) => {
					if (d.tag !== "equal") {
						highlights.push({ start: d.start_b + 1, end: d.end_b, tag: d.tag });
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

	const handleShowCommit = (hash: string) => {
		vscodeApi?.postMessage({ command: "showCommit", hash });
	};

	const handleSave = (value: string) => {
		vscodeApi?.postMessage({ command: "save", text: value });
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
							onSave={index === 1 ? handleSave : undefined}
							onShowCommit={handleShowCommit}
							onCompleteMerge={index === 1 ? handleCompleteMerge : undefined}
						/>
						{/* SVG Canvas Gap */}
						{index < files.length - 1 && (
							<DiffCurtain
								diffs={diffs[index]}
								leftEditor={editorRefs.current[index]}
								rightEditor={editorRefs.current[index + 1]}
								renderTrigger={renderTrigger}
							/>
						)}
					</React.Fragment>
				))
			)}
		</div>
	);
};

export default App;
