// Copyright (C) 2009 Vincent Legoll <vincent.legoll@gmail.com>
// Copyright (C) 2010-2011, 2013-2019 Kai Willadsen <kai.willadsen@gmail.com>
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

import Editor from "@monaco-editor/react";
import { diffLines } from "diff";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import * as React from "react";
import type { FileState, Highlight } from "./types";

const computeMinimalEdits = (
	model: editor.ITextModel,
	newText: string,
): editor.IIdentifiedSingleEditOperation[] => {
	const originalText = model.getValue();
	if (originalText === newText) return [];

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
interface CodePaneProps {
	file: FileState;
	index: number;
	onMount: (editor: editor.IStandaloneCodeEditor, index: number) => void;
	onChange: (value: string | undefined, index: number) => void;
	isMiddle: boolean;
	highlights?: Highlight[];
	onCompleteMerge?: () => void;
	onCopyHash?: (hash: string) => void;
	externalSyncId?: number;
	onShowDiff?: () => void;
	requestClipboardText?: () => Promise<string>;
	writeClipboardText?: (text: string) => void;
	syntaxHighlighting?: boolean;
}

export const CodePane: React.FC<CodePaneProps> = ({
	file,
	index,
	onMount,
	onChange,
	isMiddle,
	highlights,
	onCompleteMerge,
	onCopyHash,
	externalSyncId,
	onShowDiff,
	requestClipboardText,
	writeClipboardText,
	syntaxHighlighting = true,
}) => {
	const [editorInstance, setEditorInstance] =
		React.useState<editor.IStandaloneCodeEditor | null>(null);
	const [lastSyncId, setLastSyncId] = React.useState(externalSyncId);

	const isApplyingExternalSync = React.useRef(false);

	const [showHover, setShowHover] = React.useState(false);
	const [hoverPos, setHoverPos] = React.useState({ x: 0, y: 0 });
	const hoverRef = React.useRef<HTMLDivElement>(null);

	const hoverTimerRef = React.useRef<NodeJS.Timeout | null>(null);

	const handleMouseEnter = (
		e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>,
	) => {
		if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		const rect = e.currentTarget.getBoundingClientRect();
		// Compute safe coordinates to prevent clipping
		const cardWidth = 350;
		const cardHeight = 250; // approximate

		const maxX = Math.max(8, window.innerWidth - cardWidth - 20);
		const x = Math.min(Math.max(8, rect.left - 20), maxX);

		const maxY = Math.max(8, window.innerHeight - cardHeight - 20);
		let y = rect.bottom + 4;
		if (y > maxY && rect.top - cardHeight - 4 > 8) {
			y = rect.top - cardHeight - 4; // flip to above if it flows off bottom
		}

		setHoverPos({ x, y });
		setShowHover(true);
	};

	const handleMouseLeave = () => {
		hoverTimerRef.current = setTimeout(() => {
			setShowHover(false);
		}, 300); // 300ms delay before closing
	};

	const handleCopyHash = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (file.commit && onCopyHash) {
			onCopyHash(file.commit.hash);
		}
	};

	const handleTitleClick = (e: React.MouseEvent) => {
		if (hoverRef.current?.contains(e.target as Node)) {
			return; // Ignore clicks inside the hover card
		}
		if (onShowDiff) {
			onShowDiff();
		}
	};

	const decorationsRef = React.useRef<string[]>([]);

	React.useEffect(() => {
		if (!editorInstance || !highlights) return;

		const newDecorations = highlights
			.filter((h) => h.startLine <= h.endLine)
			.map((h) => ({
				range: {
					startLineNumber: h.startLine,
					startColumn: h.startColumn,
					endLineNumber: h.endLine,
					endColumn: h.endColumn,
				},
				options: {
					isWholeLine: h.isWholeLine,
					className: h.isWholeLine ? `diff-${h.tag}` : undefined,
					inlineClassName: !h.isWholeLine ? `diff-${h.tag}-inline` : undefined,
				},
			}));

		decorationsRef.current = editorInstance.deltaDecorations(
			decorationsRef.current,
			newDecorations,
		);
	}, [editorInstance, highlights]);

	const handleMount = (monacoEditor: editor.IStandaloneCodeEditor) => {
		setEditorInstance(monacoEditor);
		onMount(monacoEditor, index);

		if (writeClipboardText) {
			monacoEditor.addAction({
				id: "custom-copy",
				label: "Copy",
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
				contextMenuGroupId: "9_cutcopypaste",
				contextMenuOrder: 2,
				run: (ed) => {
					const model = ed.getModel();
					const selection = ed.getSelection();
					if (!model || !selection) return;

					let text = "";
					if (!selection.isEmpty()) {
						text = model.getValueInRange(selection);
					} else {
						const line = selection.startLineNumber;
						text = `${model.getLineContent(line)}\n`;
					}
					if (text) writeClipboardText(text);
				},
			});

			monacoEditor.addAction({
				id: "custom-cut",
				label: "Cut",
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX],
				contextMenuGroupId: "9_cutcopypaste",
				contextMenuOrder: 1,
				precondition: "!editorReadonly",
				run: (ed) => {
					const model = ed.getModel();
					const selection = ed.getSelection();
					if (!model || !selection || ed.getOption(monaco.editor.EditorOption.readOnly)) return;

					let text = "";
					let rangeToDelete = selection;
					if (!selection.isEmpty()) {
						text = model.getValueInRange(selection);
					} else {
						const line = selection.startLineNumber;
						text = `${model.getLineContent(line)}\n`;
						rangeToDelete = new monaco.Selection(line, 1, line + 1, 1);
					}
					
					if (text) {
						writeClipboardText(text);
						ed.executeEdits("cut", [{ range: rangeToDelete, text: "" }]);
					}
				},
			});
		}

		if (requestClipboardText) {
			// Override the action so it appears in context menu AND handles Ctrl+V intelligently
			// Note: this might show two "Paste" options in context menu, but one will work
			monacoEditor.addAction({
				id: "custom-paste",
				label: "Paste",
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
				contextMenuGroupId: "9_cutcopypaste",
				contextMenuOrder: 3,
				run: (ed) => {
					requestClipboardText().then((text) => {
						ed.trigger("keyboard", "paste", { text });
					});
				},
			});
		}
	};

	React.useEffect(() => {
		if (
			editorInstance &&
			file.content !== null &&
			file.content !== undefined &&
			externalSyncId !== undefined &&
			externalSyncId !== lastSyncId
		) {
			setLastSyncId(externalSyncId);
			if (file.content !== editorInstance.getValue()) {
				const model = editorInstance.getModel();
				if (model) {
					isApplyingExternalSync.current = true;
					try {
						const edits = computeMinimalEdits(model, file.content);
						if (edits.length > 0) {
							model.pushEditOperations(
								editorInstance.getSelections() || [],
								edits,
								() => editorInstance.getSelections() || [],
							);
						}
					} finally {
						isApplyingExternalSync.current = false;
					}
				}
			}
		}
	}, [editorInstance, file.content, externalSyncId, lastSyncId]);

	return (
		<div
			style={{
				flex: 1,
				display: "flex",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: "#2d2d2d",
					color: "#cccccc",
					padding: "8px",
					fontFamily: "sans-serif",
					fontSize: "12px",
					borderBottom: "1px solid #444",
					minWidth: 0,
				}}
			>
				<span style={{ flexShrink: 0 }}>{file.label}</span>
				{file.commit && (
					<button
						type="button"
						style={{
							position: "relative",
							background: "none",
							border: "none",
							padding: 0,
							margin: 0,
							color: "inherit",
							font: "inherit",
							display: "inline-block",
							cursor: "pointer",
						}}
						onClick={handleTitleClick}
						onMouseEnter={handleMouseEnter}
						onMouseLeave={handleMouseLeave}
						onFocus={handleMouseEnter}
						onBlur={handleMouseLeave}
						aria-label="Commit Information"
					>
						<span
							style={{
								marginLeft: "8px",
								opacity: 0.7,
								textDecoration: "underline",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							[{file.commit.title}]
						</span>
						{showHover && (
							<div
								ref={hoverRef}
								style={{
									position: "fixed",
									top: hoverPos.y,
									left: hoverPos.x,
									zIndex: 1000,
									backgroundColor:
										"var(--vscode-editorWidget-background, #252526)",
									border: "1px solid var(--vscode-widget-border, #454545)",
									borderRadius: "6px",
									padding: "16px",
									width: "350px",
									boxShadow: "0 4px 10px rgba(0, 0, 0, 0.2)",
									color: "var(--vscode-editor-foreground, #cccccc)",
									fontSize: "13px",
									fontFamily: "var(--vscode-font-family, sans-serif)",
									pointerEvents: "auto",
									textAlign: "left",
									lineHeight: 1.4,
									userSelect: "text",
									cursor: "auto",
								}}
							>
								<div
									style={{
										fontWeight: 600,
										marginBottom: "8px",
										fontSize: "14px",
									}}
								>
									{file.commit.title}
								</div>
								<div style={{ opacity: 0.8, marginBottom: "4px" }}>
									<strong>{file.commit.authorName}</strong> &lt;
									{file.commit.authorEmail}&gt;
								</div>
								<div style={{ opacity: 0.8, marginBottom: "12px" }}>
									{new Date(file.commit.date).toLocaleString()}
								</div>

								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										backgroundColor:
											"var(--vscode-textCodeBlock-background, #1e1e1e)",
										padding: "4px 8px",
										borderRadius: "4px",
										marginBottom: "12px",
									}}
								>
									<span
										style={{
											fontFamily: "var(--vscode-editor-font-family, monospace)",
										}}
									>
										{file.commit.hash.substring(0, 8)}
									</span>
									<button
										type="button"
										onClick={handleCopyHash}
										title="Copy Hash"
										style={{
											background: "none",
											border: "none",
											color: "var(--vscode-textLink-foreground, #3794ff)",
											cursor: "pointer",
											marginLeft: "auto",
											padding: "4px",
											display: "flex",
											alignItems: "center",
											justifyContent: "center",
										}}
									>
										<svg
											width="14"
											height="14"
											viewBox="0 0 16 16"
											xmlns="http://www.w3.org/2000/svg"
											fill="currentColor"
										>
											<title>Copy Hash</title>
											<path
												fillRule="evenodd"
												clipRule="evenodd"
												d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H6v10h6V7z"
											/>
											<path
												fillRule="evenodd"
												clipRule="evenodd"
												d="M3 1L2 2v10h2V3h6V1H3z"
											/>
										</svg>
									</button>
								</div>

								{file.commit.body && (
									<pre
										style={{
											marginTop: "0",
											borderTop:
												"1px solid var(--vscode-widget-border, #454545)",
											paddingTop: "12px",
											whiteSpace: "pre-wrap",
											fontFamily: "var(--vscode-editor-font-family, monospace)",
											margin: 0,
										}}
									>
										{file.commit.body}
									</pre>
								)}
							</div>
						)}
					</button>
				)}
			</div>
			<div style={{ flex: 1, position: "relative", minHeight: 0 }}>
				<Editor
					language={syntaxHighlighting ? "typescript" : "plaintext"}
					defaultValue={file.content}
					theme="vs-dark"
					options={React.useMemo(() => ({
						minimap: { enabled: false },
						readOnly: !isMiddle,
						scrollBeyondLastLine: false,
						wordWrap: "off" as const,
						renderWhitespace: "all" as const,
					}), [isMiddle])}
					onMount={handleMount}
					onChange={(value) => {
						if (isApplyingExternalSync.current) return;
						onChange(value, index);
					}}
				/>
			</div>
			{isMiddle && (
				<div
					style={{
						backgroundColor: "#252526",
						padding: "8px 12px",
						borderTop: "1px solid #444",
						display: "flex",
						justifyContent: "flex-start",
						alignItems: "center",
						fontFamily: "sans-serif",
						fontSize: "13px",
					}}
				>
					<button
						type="button"
						onClick={() => {
							if (editorInstance && onCompleteMerge) {
								onCompleteMerge();
							}
						}}
						style={{
							padding: "4px 12px",
							backgroundColor: "#2ea043",
							color: "white",
							border: "none",
							cursor: "pointer",
							borderRadius: "2px",
						}}
					>
						Save & Complete Merge
					</button>
				</div>
			)}
		</div>
	);
};
