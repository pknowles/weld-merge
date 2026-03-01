import debounce from "lodash.debounce";
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

				// Reconstruct the Differ in the webview so we can use
				// change_sequence when the user edits the middle column.
				// This matches how real Meld maintains the Differ alongside
				// the text buffers.
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

				// Trigger an initial render to draw SVGs once editors mount
				setTimeout(() => setRenderTrigger((prev) => prev + 1), 500);
			} else if (message.command === "updateContent") {
				setExternalSyncId((id) => id + 1);
				commitModelUpdate(message.text);
			}
		};
		window.addEventListener("message", handleMessage);

		if (vscodeApi) {
			vscodeApi.postMessage({ command: "ready" });
		}

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const attachScrollListener = (
		ed: editor.IStandaloneCodeEditor,
		edIndex: number,
	) => {
		return ed.onDidScrollChange((e: any) => {
			setRenderTrigger((prev) => prev + 1);

			// If another editor is currently driving sync, we're a passenger — skip.
			if (syncingFrom.current !== null && syncingFrom.current !== edIndex)
				return;

			const dRef = diffsRef.current;

			// Differ convention: a=Merged(pane1), b=Outer(pane0 or pane2)
			// mapLine maps a source line to the corresponding target line using a diff.
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

			// Differ: diffs[0] a=Merged b=Local, diffs[1] a=Merged b=Incoming
			const mapLine = (sLine: number, sIdx: number, tIdx: number): number => {
				// pane0(Local) ↔ pane1(Merged): diffs[0], b=Local a=Merged
				if (sIdx === 0 && tIdx === 1)
					return mapLineWithDiff(sLine, dRef[0], false); // src=b(Local) → tgt=a(Merged)
				if (sIdx === 1 && tIdx === 0)
					return mapLineWithDiff(sLine, dRef[0], true); // src=a(Merged) → tgt=b(Local)
				// pane1(Merged) ↔ pane2(Incoming): diffs[1], a=Merged b=Incoming
				if (sIdx === 1 && tIdx === 2)
					return mapLineWithDiff(sLine, dRef[1], true); // src=a(Merged) → tgt=b(Incoming)
				if (sIdx === 2 && tIdx === 1)
					return mapLineWithDiff(sLine, dRef[1], false); // src=b(Incoming) → tgt=a(Merged)
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

	const commitModelUpdate = (value: string) => {
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
	};

	const handleEditorChange = debounce(
		(value: string | undefined, index: number) => {
			if (value === undefined || index !== 1 || files.length !== 3) return;

			commitModelUpdate(value);

			// Notify the extension so it can apply a WorkspaceEdit and drive
			// VS Code's dirty state (tab dot, Ctrl+S, overwrite-conflict dialog).
			vscodeApi?.postMessage({ command: "contentChanged", text: value });
		},
		150,
	);

	// Differ convention: a=Merged(pane1), b=Outer(pane0 or pane2)
	const getHighlights = (paneIndex: number) => {
		const highlights: { start: number; end: number; tag: string }[] = [];
		if (paneIndex === 0 && diffs[0]) {
			// pane0 = Local = b side of diffs[0]
			diffs[0].forEach((d) => {
				if (d.tag !== "equal") {
					highlights.push({ start: d.start_b + 1, end: d.end_b, tag: d.tag });
				}
			});
		} else if (paneIndex === 1) {
			// pane1 = Merged = a side of both diffs
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
			// pane2 = Incoming = b side of diffs[1]
			diffs[1].forEach((d) => {
				if (d.tag !== "equal") {
					highlights.push({ start: d.start_b + 1, end: d.end_b, tag: d.tag });
				}
			});
		}
		return highlights;
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
						{/* SVG Canvas Gap */}
						{index < files.length - 1 && (
							<DiffCurtain
								diffs={diffs[index]}
								leftEditor={editorRefs.current[index]}
								rightEditor={editorRefs.current[index + 1]}
								renderTrigger={renderTrigger}
								reversed={index === 0}
							/>
						)}
					</React.Fragment>
				))
			)}
		</div>
	);
};

export default App;
