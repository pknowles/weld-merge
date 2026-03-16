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
import { editor, KeyCode, KeyMod, Selection } from "monaco-editor";
import {
	type CSSProperties,
	type FC,
	type FocusEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { computeMinimalEdits } from "./editorUtil.ts";
import type { FileState, Highlight } from "./types.ts";

const NEWLINE_REGEX = /\r?\n/;

interface CodePaneProps {
	file: FileState;
	index: number;
	onMount: (editor: editor.IStandaloneCodeEditor, index: number) => void;
	onChange: (value: string | undefined, index: number) => void;
	isMiddle: boolean;
	highlights?: Highlight[] | undefined;
	onCompleteMerge?: (() => void) | undefined;
	onCopyHash?: ((hash: string) => void) | undefined;
	externalSyncId?: number | undefined;
	onShowDiff?: (() => void) | undefined;
	requestClipboardText?: (() => Promise<string>) | undefined;
	writeClipboardText?: ((text: string) => void) | undefined;
	syntaxHighlighting?: boolean | undefined;
	onToggleBase?: (() => void) | undefined;
	baseSide?: "left" | "right" | undefined;
	isBaseActive?: boolean | undefined;
	style?: CSSProperties | undefined;
	onPrevDiff?: (() => void) | undefined;
	onNextDiff?: (() => void) | undefined;
	onPrevConflict?: (() => void) | undefined;
	onNextConflict?: (() => void) | undefined;
	autoFocusConflict?: boolean | undefined;
}

export const CodePane: FC<CodePaneProps> = ({
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
	onToggleBase,
	baseSide,
	isBaseActive = false,
	style,
	onPrevDiff,
	onNextDiff,
	onPrevConflict,
	onNextConflict,
	autoFocusConflict,
}) => {
	const [editorInstance, setEditorInstance] =
		useState<editor.IStandaloneCodeEditor | null>(null);
	const [lastSyncId, setLastSyncId] = useState(externalSyncId);

	const isApplyingExternalSync = useRef(false);
	const [showHover, setShowHover] = useState(false);
	const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
	const hoverRef = useRef<HTMLDivElement>(null);
	const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

	const handleMouseEnter = (
		e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>,
	) => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
		}
		const rect = e.currentTarget.getBoundingClientRect();
		// Compute safe coordinates to prevent clipping
		const cardWidth = 350;
		const cardHeight = 250; // approximate

		const maxX = Math.max(8, window.innerWidth - cardWidth - 20);
		const x = Math.min(Math.max(8, rect.left - 20), maxX);

		const maxY = Math.max(8, window.innerHeight - cardHeight - 20);
		let y = rect.bottom + 4;
		const isTooLow = y > maxY;
		const hasSpaceAbove = rect.top - cardHeight - 4 > 8;
		if (isTooLow && hasSpaceAbove) {
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

	const handleCopyHash = (e: MouseEvent) => {
		e.stopPropagation();
		if (file.commit && onCopyHash) {
			onCopyHash(file.commit.hash);
		}
	};

	const handleTitleClick = (e: MouseEvent) => {
		if (hoverRef.current?.contains(e.target as Node)) {
			return; // Ignore clicks inside the hover card
		}
		if (onShowDiff) {
			onShowDiff();
		}
	};

	const decorationsRef = useRef<string[]>([]);

	useEffect(() => {
		if (!(editorInstance && highlights)) {
			return;
		}

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
					className: h.isWholeLine ? `diff-${h.tag}` : null,
					inlineClassName: h.isWholeLine
						? null
						: `diff-${h.tag}-inline`,
					linesDecorationsClassName: h.isWholeLine
						? `diff-${h.tag}-margin`
						: null,
					marginClassName: h.isWholeLine
						? `diff-${h.tag}-margin`
						: null,
				},
			}));

		decorationsRef.current = editorInstance.deltaDecorations(
			decorationsRef.current,
			newDecorations,
		);
	}, [editorInstance, highlights]);

	const handleMountLogic = (monacoEditor: editor.IStandaloneCodeEditor) => {
		setEditorInstance(monacoEditor);
		onMount(monacoEditor, index);

		if (writeClipboardText) {
			monacoEditor.onDidBlurEditorText(() => {
				writeClipboardText(monacoEditor.getValue());
			});

			monacoEditor.addAction({
				id: "custom-copy",
				label: "Copy",
				keybindings: [KeyMod.CtrlCmd | KeyCode.KeyC],
				contextMenuGroupId: "9_cutcopypaste",
				contextMenuOrder: 2,
				run: (ed) => {
					const model = ed.getModel();
					const selection = ed.getSelection();
					if (!(model && selection)) {
						return;
					}

					let text = "";
					if (selection.isEmpty()) {
						const line = selection.startLineNumber;
						text = `${model.getLineContent(line)}\n`;
					} else {
						text = model.getValueInRange(selection);
					}
					if (text) {
						writeClipboardText(text);
					}
				},
			});

			monacoEditor.addAction({
				id: "custom-cut",
				label: "Cut",
				keybindings: [KeyMod.CtrlCmd | KeyCode.KeyX],
				contextMenuGroupId: "9_cutcopypaste",
				contextMenuOrder: 1,
				precondition: "!editorReadonly",
				run: (ed) => {
					const model = ed.getModel();
					const selection = ed.getSelection();
					if (
						!(model && selection) ||
						ed.getOption(editor.EditorOption.readOnly)
					) {
						return;
					}

					let text = "";
					let rangeToDelete = selection;
					if (selection.isEmpty()) {
						const line = selection.startLineNumber;
						text = `${model.getLineContent(line)}\n`;
						rangeToDelete = new Selection(line, 1, line + 1, 1);
					} else {
						text = model.getValueInRange(selection);
					}

					if (text) {
						writeClipboardText(text);
						ed.executeEdits("cut", [
							{ range: rangeToDelete, text: "" },
						]);
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
				keybindings: [KeyMod.CtrlCmd | KeyCode.KeyV],
				contextMenuGroupId: "9_cutcopypaste",
				contextMenuOrder: 3,
				run: (ed) => {
					requestClipboardText().then((text) => {
						ed.trigger("keyboard", "paste", { text });
					});
				},
			});
		}

		if (index === 2) {
			monacoEditor.addAction({
				id: "prev-diff",
				label: "Previous Diff",
				keybindings: [KeyMod.Alt | KeyCode.UpArrow],
				run: () => onPrevDiff?.(),
			});
			monacoEditor.addAction({
				id: "next-diff",
				label: "Next Diff",
				keybindings: [KeyMod.Alt | KeyCode.DownArrow],
				run: () => onNextDiff?.(),
			});
			monacoEditor.addAction({
				id: "prev-conflict",
				label: "Previous Conflict",
				keybindings: [KeyMod.CtrlCmd | KeyCode.KeyJ],
				run: () => onPrevConflict?.(),
			});
			monacoEditor.addAction({
				id: "next-conflict",
				label: "Next Conflict",
				keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK],
				run: () => onNextConflict?.(),
			});

			if (autoFocusConflict) {
				setTimeout(() => {
					onNextConflict?.();
				}, 500);
			}
		}
	};

	const handleMount = useCallback(handleMountLogic, [
		index,
		onMount,
		writeClipboardText,
		requestClipboardText,
		onPrevDiff,
		onNextDiff,
		onPrevConflict,
		onNextConflict,
		autoFocusConflict,
	]);

	useEffect(() => {
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

	const [isFlashing, setIsFlashing] = useState(false);
	const flashTimerRef = useRef<NodeJS.Timeout | null>(null);

	const triggerFlash = () => {
		setIsFlashing(true);
		if (flashTimerRef.current) {
			clearTimeout(flashTimerRef.current);
		}
		flashTimerRef.current = setTimeout(() => setIsFlashing(false), 1000);
	};

	return (
		<div
			style={{
				flex: 1,
				display: "flex",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				...style,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: "#2d2d2d",
					color: "#cccccc",
					padding: "0 8px",
					height: "35px",
					boxSizing: "border-box",
					fontFamily: "sans-serif",
					fontSize: "12px",
					borderBottom: "1px solid #444",
					minWidth: 0,
				}}
			>
				<style>{`
					.nav-btn {
						background: none;
						border: none;
						color: inherit;
						cursor: pointer;
						display: flex;
						alignItems: center;
						padding: 4px;
						opacity: 0.6;
						transition: opacity 0.2s, background-color 0.2s;
						border-radius: 4px;
					}
					.nav-btn:hover {
						opacity: 1;
						background-color: rgba(255, 255, 255, 0.1);
					}
					.nav-btn-conflict {
						color: var(--vscode-errorForeground, #f48771);
					}
					@keyframes flash-red {
						0% { background-color: #2ea043; }
						20% { background-color: #f48771; box-shadow: 0 0 10px #f48771; }
						100% { background-color: #2ea043; }
					}
					.button-flash {
						animation: flash-red 1s ease-out;
					}
				`}</style>
				{onToggleBase && baseSide === "left" && (
					<button
						type="button"
						data-testid="toggle-base-left"
						onClick={onToggleBase}
						title="Toggle compare with Base"
						style={{
							background: "none",
							border: "none",
							color: isBaseActive
								? "var(--vscode-textLink-foreground, #3794ff)"
								: "inherit",
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							padding: "4px",
							marginRight: "8px",
							opacity: isBaseActive ? 1 : 0.6,
						}}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							xmlns="http://www.w3.org/2000/svg"
							fill="currentColor"
						>
							<title>Compare with Base</title>
							<path
								fillRule="evenodd"
								clipRule="evenodd"
								d="M2 2h12v12H2V2zm-1 0a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm3 1v10h3V3H4z"
							/>
						</svg>
					</button>
				)}
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
									fontFamily:
										"var(--vscode-font-family, sans-serif)",
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
								<div
									style={{
										opacity: 0.8,
										marginBottom: "4px",
									}}
								>
									<strong>{file.commit.authorName}</strong>{" "}
									&lt;
									{file.commit.authorEmail}&gt;
								</div>
								<div
									style={{
										opacity: 0.8,
										marginBottom: "12px",
									}}
								>
									{new Date(
										file.commit.date,
									).toLocaleString()}
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
											fontFamily:
												"var(--vscode-editor-font-family, monospace)",
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
											fontFamily:
												"var(--vscode-editor-font-family, monospace)",
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
				<div style={{ flex: 1 }} />
				{index === 2 && (
					<div
						style={{
							display: "flex",
							gap: "2px",
							alignItems: "center",
							marginRight: "8px",
						}}
					>
						<button
							type="button"
							className="nav-btn"
							onClick={onPrevDiff}
							title="Previous Diff (Alt+Up)"
						>
							<svg width="16" height="16" viewBox="0 0 16 16">
								<title>Previous Diff</title>
								<path
									fill="currentColor"
									d="M7.414 7L10 9.586L9.586 10L6 6.414L9.586 3L10 3.414L7.414 6H14v1H7.414z"
									transform="rotate(90 8 8)"
								/>
							</svg>
						</button>
						<button
							type="button"
							className="nav-btn"
							onClick={onNextDiff}
							title="Next Diff (Alt+Down)"
						>
							<svg width="16" height="16" viewBox="0 0 16 16">
								<title>Next Diff</title>
								<path
									fill="currentColor"
									d="M7.414 7L10 9.586L9.586 10L6 6.414L9.586 3L10 3.414L7.414 6H14v1H7.414z"
									transform="rotate(-90 8 8)"
								/>
							</svg>
						</button>
						<div
							style={{
								width: "1px",
								height: "16px",
								backgroundColor: "#444",
								margin: "0 4px",
							}}
						/>
						<button
							type="button"
							className="nav-btn nav-btn-conflict"
							onClick={onPrevConflict}
							title="Previous Conflict (Ctrl+J)"
						>
							<svg width="16" height="16" viewBox="0 0 16 16">
								<title>Previous Conflict</title>
								<path
									fill="currentColor"
									d="M8 3.5l-4 4h3V12h2V7.5h3z"
								/>
								<path
									fill="currentColor"
									opacity="0.5"
									d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7-6a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"
								/>
							</svg>
						</button>
						<button
							type="button"
							className="nav-btn nav-btn-conflict"
							onClick={onNextConflict}
							title="Next Conflict (Ctrl+K)"
						>
							<svg width="16" height="16" viewBox="0 0 16 16">
								<title>Next Conflict</title>
								<path
									fill="currentColor"
									d="M8 12.5l4-4h-3V4H7v4.5H4z"
								/>
								<path
									fill="currentColor"
									opacity="0.5"
									d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7-6a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"
								/>
							</svg>
						</button>
					</div>
				)}
				<div style={{ flex: 1 }} />
				{onToggleBase && baseSide === "right" && (
					<button
						type="button"
						data-testid="toggle-base-right"
						onClick={onToggleBase}
						title="Toggle compare with Base"
						style={{
							background: "none",
							border: "none",
							color: isBaseActive
								? "var(--vscode-textLink-foreground, #3794ff)"
								: "inherit",
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							padding: "4px",
							marginLeft: "8px",
							opacity: isBaseActive ? 1 : 0.6,
						}}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							xmlns="http://www.w3.org/2000/svg"
							fill="currentColor"
						>
							<title>Compare with Base</title>
							<path
								fillRule="evenodd"
								clipRule="evenodd"
								d="M14 2H2v12h12V2zM1 2a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm11 1v10H9V3h3z"
							/>
						</svg>
					</button>
				)}
			</div>
			<div style={{ flex: 1, position: "relative", minHeight: 0 }}>
				<Editor
					language={syntaxHighlighting ? "typescript" : "plaintext"}
					defaultValue={file.content}
					theme="vs-dark"
					options={useMemo(
						() => ({
							minimap: { enabled: false },
							readOnly: !isMiddle,
							scrollBeyondLastLine: false,
							wordWrap: "off" as const,
							renderWhitespace: "all" as const,
						}),
						[isMiddle],
					)}
					onMount={handleMount}
					onChange={(value) => {
						if (isApplyingExternalSync.current) {
							return;
						}
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
						className={isFlashing ? "button-flash" : ""}
						onClick={() => {
							if (editorInstance && onCompleteMerge) {
								const text = editorInstance.getValue();
								const lines = text.split(NEWLINE_REGEX);
								const conflictMarkers = [
									"<<<<<<<",
									"=======",
									">>>>>>>",
									"|||||||",
								];
								const firstUnresolvedLineIdx = lines.findIndex(
									(line) =>
										conflictMarkers.some((m) =>
											line.startsWith(m),
										) || line.startsWith("(??)"),
								);

								if (firstUnresolvedLineIdx !== -1) {
									triggerFlash();
									const lineNumber =
										firstUnresolvedLineIdx + 1;
									editorInstance.revealLineInCenter(
										lineNumber,
									);
									editorInstance.setPosition({
										lineNumber,
										column: 1,
									});
									editorInstance.focus();
								}
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
