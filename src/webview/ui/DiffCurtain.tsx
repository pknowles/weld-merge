// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import * as React from "react";
import type { DiffChunk } from "./types";
import type { editor } from "monaco-editor";

interface DiffCurtainProps {
	diffs: DiffChunk[] | undefined;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	renderTrigger: number; // For triggering re-renders on scroll
	// When true, the diff's a/b sides are reversed relative to left/right editors.
	// diffs[0] has a=Merged(right) b=Local(left), so reversed=true swaps them.
	reversed: boolean;
	onApplyChunk?: (chunk: DiffChunk) => void;
	onDeleteChunk?: (chunk: DiffChunk) => void;
	onCopyUpChunk?: (chunk: DiffChunk) => void;
	onCopyDownChunk?: (chunk: DiffChunk) => void;
}

export const DiffCurtain: React.FC<DiffCurtainProps> = ({
	diffs,
	leftEditor,
	rightEditor,
	renderTrigger: _renderTrigger,
	reversed,
	onApplyChunk,
	onDeleteChunk,
	onCopyUpChunk,
	onCopyDownChunk,
}) => {
	const width = 40;
	const curveOffset = 15;

	const [headerOffset, setHeaderOffset] = React.useState(0);
	const curtainRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		const calculateOffset = () => {
			if (!curtainRef.current || !leftEditor) return;
			const curtainRect = curtainRef.current.getBoundingClientRect();
			const editorNode = leftEditor.getContainerDomNode();
			if (editorNode) {
				const editorRect = editorNode.getBoundingClientRect();
				// The Y-offset difference between the top of the SVG canvas (curtain)
				// and the top of the actual Monaco text area.
				setHeaderOffset(Math.max(0, editorRect.top - curtainRect.top));
			}
		};

		// Calculate initially
		calculateOffset();

		// Recalculate if window resizes (which might wrap flex items)
		window.addEventListener("resize", calculateOffset);
		return () => window.removeEventListener("resize", calculateOffset);
	}, [leftEditor]);

	if (!diffs || !leftEditor || !rightEditor) {
		return null;
	}

	return (
		<div
			ref={curtainRef}
			style={{
				width: `${width}px`,
				backgroundColor: "#1e1e1e",
				position: "relative",
				borderLeft: "1px solid #333",
				borderRight: "1px solid #333",
				zIndex: 10,
			}}
		>
			<svg
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					overflow: "visible"
				}}
			>
				<title>Diff Connections</title>
				<style>{`
					.diff-btn-container { opacity: 0; transition: opacity 0.1s; overflow: visible; }
					.diff-container:hover .diff-btn-container { opacity: 1; }
					.diff-btn {
						width: 12px; height: 12px;
						border: 1px solid rgba(255,255,255,0.2);
						background: rgba(0,0,0,0.5);
						border-radius: 3px;
						color: white;
						font-size: 10px;
						display: flex;
						align-items: center;
						justify-content: center;
						padding: 0;
						cursor: pointer;
						box-sizing: border-box;
						line-height: 1;
					}
					.diff-btn:hover { background: rgba(100,100,100,0.9); border-color: rgba(255,255,255,0.6); }
					.diff-cross-icon { font-size: 14px; font-weight: bold; margin-top: -2px; }
				`}</style>
				{diffs.map((chunk) => {
					if (chunk.tag === "equal") return null;

					const leftModel = leftEditor.getModel();
					const rightModel = rightEditor.getModel();
					const leftMax = leftModel ? leftModel.getLineCount() : 1;
					const rightMax = rightModel ? rightModel.getLineCount() : 1;

					// When reversed, a=right and b=left; otherwise a=left and b=right
					const leftStartLine = Math.min(leftMax, Math.max(1, (reversed ? chunk.start_b : chunk.start_a) + 1));
					const leftEndLine = Math.min(leftMax, Math.max(1, (reversed ? chunk.end_b : chunk.end_a) + 1));
					const rightStartLine = Math.min(rightMax, Math.max(1, (reversed ? chunk.start_a : chunk.start_b) + 1));
					const rightEndLine = Math.min(rightMax, Math.max(1, (reversed ? chunk.end_a : chunk.end_b) + 1));

					const leftEmpty = reversed ? chunk.start_b === chunk.end_b : chunk.start_a === chunk.end_a;
					const rightEmpty = reversed ? chunk.start_a === chunk.end_a : chunk.start_b === chunk.end_b;

					const y1Top =
						leftEditor.getTopForLineNumber(leftStartLine) -
						leftEditor.getScrollTop() + headerOffset;
					let y1Bottom =
						leftEditor.getTopForLineNumber(leftEndLine) -
						leftEditor.getScrollTop() + headerOffset;
					if (leftEmpty) y1Bottom = y1Top;

					const y2Top =
						rightEditor.getTopForLineNumber(rightStartLine) -
						rightEditor.getScrollTop() + headerOffset;
					let y2Bottom =
						rightEditor.getTopForLineNumber(rightEndLine) -
						rightEditor.getScrollTop() + headerOffset;
					if (rightEmpty) y2Bottom = y2Top;

					const path = `M 0,${y1Top} C ${curveOffset},${y1Top} ${width - curveOffset},${y2Top} ${width},${y2Top} L ${width},${y2Bottom} C ${width - curveOffset},${y2Bottom} ${curveOffset},${y1Bottom} 0,${y1Bottom} Z`;

					const color =
						chunk.tag === "replace"
							? "rgba(0, 100, 255, 0.2)"
							: chunk.tag === "conflict"
								? "rgba(255, 0, 0, 0.2)"
								: "rgba(0, 200, 0, 0.2)";

					const strokeColor =
						chunk.tag === "replace"
							? "rgba(0, 100, 255, 0.5)"
							: chunk.tag === "conflict"
								? "rgba(255, 0, 0, 0.5)"
								: "rgba(0, 200, 0, 0.5)";

					const isReplace = chunk.tag === "replace";
					const canApply = isReplace || chunk.start_b < chunk.end_b;
					const canDelete = isReplace || chunk.start_a < chunk.end_a;
					
					const applySide = reversed ? "left" : "right";
					const deleteSide = reversed ? "right" : "left";

					const applyX = applySide === "left" ? 4 : width - 16;
					const deleteX = deleteSide === "left" ? 4 : width - 16;
					
					const baseApplyY = (applySide === "left" ? y1Top : y2Top) + 4;
					const upY = baseApplyY;
					const repY = isReplace ? baseApplyY + 14 : baseApplyY;
					const downY = isReplace ? baseApplyY + 28 : baseApplyY;
					const deleteY = (deleteSide === "left" ? y1Top : y2Top) + 4;

					return (
						<g key={`${chunk.start_a}-${chunk.end_a}-${chunk.start_b}-${chunk.end_b}`} className="diff-container">
							<path
								d={path}
								fill={color}
								stroke={strokeColor}
								strokeWidth="1"
							/>
							{canApply && onCopyUpChunk && isReplace && (
								<foreignObject x={applyX} y={upY} width="12" height="12" className="diff-btn-container">
									<button
										type="button"
										className="diff-btn"
										onClick={() => onCopyUpChunk(chunk)}
										title="Copy chunk up"
									>
										{applySide === "left" ? "↱" : "↰"}
									</button>
								</foreignObject>
							)}
							{canApply && onApplyChunk && (
								<foreignObject x={applyX} y={repY} width="12" height="12" className="diff-btn-container">
									<button
										type="button"
										className="diff-btn"
										onClick={() => onApplyChunk(chunk)}
										title="Push chunk to Merged"
									>
										{applySide === "left" ? "➔" : "⬅"}
									</button>
								</foreignObject>
							)}
							{canApply && onCopyDownChunk && isReplace && (
								<foreignObject x={applyX} y={downY} width="12" height="12" className="diff-btn-container">
									<button
										type="button"
										className="diff-btn"
										onClick={() => onCopyDownChunk(chunk)}
										title="Copy chunk down"
									>
										{applySide === "left" ? "↳" : "↲"}
									</button>
								</foreignObject>
							)}
							{canDelete && onDeleteChunk && (
								<foreignObject x={deleteX} y={deleteY} width="12" height="12" className="diff-btn-container">
									<button
										type="button"
										className="diff-btn diff-cross-icon"
										onClick={() => onDeleteChunk(chunk)}
										title="Delete chunk from Merged"
									>
										×
									</button>
								</foreignObject>
							)}
						</g>
					);
				})}
			</svg>
		</div>
	);
};
