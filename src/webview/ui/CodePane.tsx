import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as React from "react";
import type { FileState } from "./types";

interface CodePaneProps {
	file: FileState;
	index: number;
	onMount: (editor: editor.IStandaloneCodeEditor, index: number) => void;
	onChange: (value: string | undefined, index: number) => void;
	isMiddle: boolean;
	highlights?: { start: number; end: number; tag: string }[];
	onCompleteMerge?: () => void;
	onCopyHash?: (hash: string) => void;
	externalSyncId?: number;
	onShowDiff?: () => void;
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

	const handleTitleClick = () => {
		if (onShowDiff) {
			onShowDiff();
		}
	};

	const decorationsRef = React.useRef<string[]>([]);

	React.useEffect(() => {
		if (!editorInstance || !highlights) return;

		const newDecorations = highlights
			.filter((h) => h.start <= h.end)
			.map((h) => ({
				range: {
					startLineNumber: h.start,
					startColumn: 1,
					endLineNumber: h.end,
					endColumn: 1,
				},
				options: {
					isWholeLine: true,
					className: `diff-${h.tag}`,
				},
			}));

		decorationsRef.current = editorInstance.deltaDecorations(
			decorationsRef.current,
			newDecorations,
		);
	}, [editorInstance, highlights]);

	const handleMount = (editor: editor.IStandaloneCodeEditor) => {
		setEditorInstance(editor);
		onMount(editor, index);
	};

	React.useEffect(() => {
		if (
			editorInstance &&
			file.content &&
			externalSyncId !== undefined &&
			externalSyncId !== lastSyncId
		) {
			setLastSyncId(externalSyncId);
			if (file.content !== editorInstance.getValue()) {
				const pos = editorInstance.getPosition();
				const model = editorInstance.getModel();
				if (model) {
					isApplyingExternalSync.current = true;
					try {
						editorInstance.executeEdits("external-sync", [
							{
								range: model.getFullModelRange(),
								text: file.content,
								forceMoveMarkers: true,
							},
						]);
					} finally {
						isApplyingExternalSync.current = false;
					}
					if (pos) editorInstance.setPosition(pos);
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
								onClick={(e) => e.stopPropagation()}
								// Re-applying enter/leave so the card doesn't close while hovered
								// This needs to be native since the wrapper button will close it if we mouse over the popup
								onMouseEnter={handleMouseEnter}
								onMouseLeave={handleMouseLeave}
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
					defaultLanguage="typescript"
					defaultValue={file.content}
					theme="vs-dark"
					options={{
						minimap: { enabled: false },
						readOnly: !isMiddle,
						scrollBeyondLastLine: false,
						wordWrap: "off",
						renderWhitespace: "all",
					}}
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
