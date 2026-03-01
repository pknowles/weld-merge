import * as React from "react";
import { useState, useEffect, useRef } from "react";
import type { FileState, DiffChunk } from "./types";
import { CodePane } from "./CodePane";
import { DiffCurtain } from "./DiffCurtain";
import type { editor } from "monaco-editor";
import { MyersSequenceMatcher } from "../../matchers/myers";
import debounce from "lodash.debounce";

const App: React.FC = () => {
	const [files, setFiles] = useState<FileState[]>([]);
	const [diffs, setDiffs] = useState<DiffChunk[][]>([]);
	const [renderTrigger, setRenderTrigger] = useState(0);
	const editorRefs = useRef<editor.IStandaloneCodeEditor[]>([]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.command === "loadDiff") {
				setFiles(message.data.files);
				setDiffs(message.data.diffs);
				// Trigger an initial render to draw SVGs once editors mount
				setTimeout(() => setRenderTrigger((prev) => prev + 1), 500);
			}
		};
		window.addEventListener("message", handleMessage);

		// Signal the extension host that we are ready to receive the payload
		// Use acquireVsCodeApi if available (it is in the Webview environment)
		try {
			const vscode = (
				window as unknown as { acquireVsCodeApi: () => unknown }
			).acquireVsCodeApi() as { postMessage: (msg: unknown) => void };
			vscode.postMessage({ command: "ready" });
		} catch (_e) {
			console.error("VS Code API not available");
		}

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const handleEditorMount = (
		editor: editor.IStandaloneCodeEditor,
		index: number,
	) => {
		editorRefs.current[index] = editor;

		// Trigger SVG redraw and proportional scroll sync
		editor.onDidScrollChange((e: any) => {
			setRenderTrigger((prev) => prev + 1);
			
			if (!e.scrollTopChanged) return;

			const layoutInfo = editor.getLayoutInfo();
			const sourceScrollHeight = editor.getScrollHeight() - layoutInfo.height;
			if (sourceScrollHeight <= 0) return;

			const scrollPercentage = e.scrollTop / sourceScrollHeight;

			editorRefs.current.forEach((otherEditor, i) => {
				if (i !== index && otherEditor) {
					const targetLayoutInfo = otherEditor.getLayoutInfo();
					const targetScrollHeight =
						otherEditor.getScrollHeight() - targetLayoutInfo.height;
					const targetScrollTop = scrollPercentage * targetScrollHeight;

					if (Math.abs(otherEditor.getScrollTop() - targetScrollTop) > 2) {
						otherEditor.setScrollTop(targetScrollTop);
					}
				}
			});
		});
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
					midLines,
					leftLines,
				).get_difference_opcodes();
				const rightDiffs = new MyersSequenceMatcher(
					null,
					midLines,
					rightLines,
				).get_difference_opcodes();

				setDiffs([leftDiffs, rightDiffs]);
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
		try {
			const vscode = (
				window as unknown as { acquireVsCodeApi: () => unknown }
			).acquireVsCodeApi() as { postMessage: (msg: unknown) => void };
			vscode.postMessage({ command: "showCommit", hash });
		} catch (_e) {
			console.error("VS Code API not available");
		}
	};

	const handleSave = (value: string) => {
		try {
			const vscode = (
				window as unknown as { acquireVsCodeApi: () => unknown }
			).acquireVsCodeApi() as { postMessage: (msg: unknown) => void };
			vscode.postMessage({ command: "save", text: value });
		} catch (_e) {
			console.error("VS Code API not available");
		}
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
				.diff-replace { background-color: rgba(0, 100, 255, 0.15) !important; }
				.diff-delete { background-color: rgba(255, 0, 0, 0.15) !important; }
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
