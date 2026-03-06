// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import type { editor } from "monaco-editor";
import * as React from "react";
import type { DiffChunk } from "./types";
import { DIFF_WIDTH } from "./types";

interface DiffCurtainProps {
	diffs: DiffChunk[] | undefined;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	renderTrigger: number; // For triggering re-renders on scroll
	// When true, the diff's a/b sides are reversed relative to left/right editors.
	// diffs[0] has a=Merged(right) b=Local(left), so reversed=true swaps them.
	reversed: boolean;
	fadeOutLeft?: boolean;
	fadeOutRight?: boolean;
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
	fadeOutLeft,
	fadeOutRight,
	onApplyChunk,
	onDeleteChunk,
	onCopyUpChunk,
	onCopyDownChunk,
}) => {
	const width = DIFF_WIDTH;
	const curveOffset = 15;

	const [leftHeaderOffset, setLeftHeaderOffset] = React.useState(0);
	const [rightHeaderOffset, setRightHeaderOffset] = React.useState(0);
	const curtainRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		const calculateOffset = () => {
			if (!curtainRef.current) return;
			const curtainRect = curtainRef.current.getBoundingClientRect();

			if (leftEditor) {
				const leftNode = leftEditor.getContainerDomNode();
				if (leftNode) {
					const leftRect = leftNode.getBoundingClientRect();
					setLeftHeaderOffset(Math.max(0, leftRect.top - curtainRect.top));
				}
			}

			if (rightEditor) {
				const rightNode = rightEditor.getContainerDomNode();
				if (rightNode) {
					const rightRect = rightNode.getBoundingClientRect();
					setRightHeaderOffset(Math.max(0, rightRect.top - curtainRect.top));
				}
			}
		};

		// Calculate initially
		calculateOffset();

		// Recalculate if window resizes or container resizes
		window.addEventListener("resize", calculateOffset);

		const observer = new ResizeObserver(() => {
			calculateOffset();
		});

		const leftNode = leftEditor?.getContainerDomNode();
		if (leftNode) observer.observe(leftNode);

		const rightNode = rightEditor?.getContainerDomNode();
		if (rightNode) observer.observe(rightNode);

		if (curtainRef.current) observer.observe(curtainRef.current);

		return () => {
			window.removeEventListener("resize", calculateOffset);
			observer.disconnect();
		};
	}, [leftEditor, rightEditor]);

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
					overflow: "visible",
				}}
			>
				<title>Diff Connections</title>
				<defs>
					<mask id="fadeLeft">
						<linearGradient id="gradLeft">
							<stop offset="0%" stopColor="black" />
							<stop offset="80%" stopColor="white" />
							<stop offset="100%" stopColor="white" />
						</linearGradient>
						<rect width="100%" height="100%" fill="url(#gradLeft)" />
					</mask>
					<mask id="fadeRight">
						<linearGradient id="gradRight">
							<stop offset="0%" stopColor="white" />
							<stop offset="20%" stopColor="white" />
							<stop offset="100%" stopColor="black" />
						</linearGradient>
						<rect width="100%" height="100%" fill="url(#gradRight)" />
					</mask>
					<mask id="fadeBoth">
						<linearGradient id="gradBoth">
							<stop offset="0%" stopColor="black" />
							<stop offset="20%" stopColor="white" />
							<stop offset="80%" stopColor="white" />
							<stop offset="100%" stopColor="black" />
						</linearGradient>
						<rect width="100%" height="100%" fill="url(#gradBoth)" />
					</mask>
				</defs>
				<style>{`
					.diff-btn-container { opacity: 0; transition: opacity 0.1s; overflow: visible; }
					.diff-container:hover .diff-btn-container { opacity: 1; }
					.diff-btn {
						width: 16px; height: 16px;
						border: 1px solid rgba(255,255,255,0.2);
						background: rgba(0,0,0,0.5);
						border-radius: 3px;
						color: white;
						font-size: 13px;
						display: flex;
						align-items: center;
						justify-content: center;
						padding: 0;
						cursor: pointer;
						box-sizing: border-box;
						line-height: 1;
					}
					.diff-btn:hover { background: rgba(100,100,100,0.9); border-color: rgba(255,255,255,0.6); }
					.diff-cross-icon { font-size: 16px; font-weight: bold; margin-top: -2px; }
				`}</style>
				{diffs.map((chunk) => {
					if (chunk.tag === "equal") return null;

					const leftModel = leftEditor.getModel();
					const rightModel = rightEditor.getModel();
					const leftMax = leftModel ? leftModel.getLineCount() : 1;
					const rightMax = rightModel ? rightModel.getLineCount() : 1;

					// When reversed, a=right and b=left; otherwise a=left and b=right
					const leftStartLine = Math.min(
						leftMax,
						Math.max(1, (reversed ? chunk.start_b : chunk.start_a) + 1),
					);
					const leftEndLine = Math.min(
						leftMax,
						Math.max(1, (reversed ? chunk.end_b : chunk.end_a) + 1),
					);
					const rightStartLine = Math.min(
						rightMax,
						Math.max(1, (reversed ? chunk.start_a : chunk.start_b) + 1),
					);
					const rightEndLine = Math.min(
						rightMax,
						Math.max(1, (reversed ? chunk.end_a : chunk.end_b) + 1),
					);

					const leftEmpty = reversed
						? chunk.start_b === chunk.end_b
						: chunk.start_a === chunk.end_a;
					const rightEmpty = reversed
						? chunk.start_a === chunk.end_a
						: chunk.start_b === chunk.end_b;

					const y1Top =
						leftEditor.getTopForLineNumber(leftStartLine) -
						leftEditor.getScrollTop() +
						leftHeaderOffset;
					let y1Bottom =
						leftEditor.getTopForLineNumber(leftEndLine) -
						leftEditor.getScrollTop() +
						leftHeaderOffset;
					if (leftEmpty) y1Bottom = y1Top;

					const y2Top =
						rightEditor.getTopForLineNumber(rightStartLine) -
						rightEditor.getScrollTop() +
						rightHeaderOffset;
					let y2Bottom =
						rightEditor.getTopForLineNumber(rightEndLine) -
						rightEditor.getScrollTop() +
						rightHeaderOffset;
					if (rightEmpty) y2Bottom = y2Top;

					const basePath = `M 0,${y1Top} C ${curveOffset},${y1Top} ${width - curveOffset},${y2Top} ${width},${y2Top} L ${width},${y2Bottom} C ${width - curveOffset},${y2Bottom} ${curveOffset},${y1Bottom} 0,${y1Bottom} Z`;
					const topEdgePath = `M 0,${y1Top} C ${curveOffset},${y1Top} ${width - curveOffset},${y2Top} ${width},${y2Top}`;
					const bottomEdgePath = `M ${width},${y2Bottom} C ${width - curveOffset},${y2Bottom} ${curveOffset},${y1Bottom} 0,${y1Bottom}`;

					const color =
						chunk.tag === "replace"
							? "var(--vscode-meldMerge-diffCurtainReplaceFill, rgba(0, 100, 255, 0.2))"
							: chunk.tag === "conflict"
								? "var(--vscode-meldMerge-diffCurtainConflictFill, rgba(255, 0, 0, 0.2))"
								: chunk.tag === "delete"
									? "var(--vscode-meldMerge-diffCurtainDeleteFill, rgba(0, 200, 0, 0.2))"
									: "var(--vscode-meldMerge-diffCurtainInsertFill, rgba(0, 200, 0, 0.2))";

					const strokeColor =
						chunk.tag === "replace"
							? "var(--vscode-meldMerge-diffCurtainReplaceStroke, rgba(0, 100, 255, 0.5))"
							: chunk.tag === "conflict"
								? "var(--vscode-meldMerge-diffCurtainConflictStroke, rgba(255, 0, 0, 0.5))"
								: chunk.tag === "delete"
									? "var(--vscode-meldMerge-diffCurtainDeleteStroke, rgba(0, 200, 0, 0.5))"
									: "var(--vscode-meldMerge-diffCurtainInsertStroke, rgba(0, 200, 0, 0.5))";

					const isReplace = chunk.tag === "replace";
					const canApply = isReplace || chunk.start_b < chunk.end_b;
					const canDelete = isReplace || chunk.start_a < chunk.end_a;

					const applySide = reversed ? "left" : "right";
					const deleteSide = reversed ? "right" : "left";

					const btnSize = 16;
					const btnMargin = 3;
					const applyX =
						applySide === "left" ? btnMargin : width - btnSize - btnMargin;
					const deleteX =
						deleteSide === "left" ? btnMargin : width - btnSize - btnMargin;

					const baseApplyY = applySide === "left" ? y1Top : y2Top;
					const baseDeleteY = deleteSide === "left" ? y1Top : y2Top;

					const repY = baseApplyY + btnMargin;
					const upY = repY - btnSize - 2;
					const downY = repY + btnSize + 2;
					const deleteY = baseDeleteY + btnMargin;

					const diffMask =
						fadeOutLeft && fadeOutRight
							? "url(#fadeBoth)"
							: fadeOutLeft
								? "url(#fadeLeft)"
								: fadeOutRight
									? "url(#fadeRight)"
									: undefined;

					return (
						<g
							key={`${chunk.start_a}-${chunk.end_a}-${chunk.start_b}-${chunk.end_b}`}
							className="diff-container"
							mask={diffMask}
						>
							<path d={basePath} fill={color} stroke="none" />
							<path
								d={topEdgePath}
								fill="none"
								stroke={strokeColor}
								strokeWidth="1"
							/>
							<path
								d={bottomEdgePath}
								fill="none"
								stroke={strokeColor}
								strokeWidth="1"
							/>
							{canApply && onCopyUpChunk && isReplace && (
								<foreignObject
									x={applyX}
									y={upY}
									width="16"
									height="16"
									className="diff-btn-container"
								>
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
								<foreignObject
									x={applyX}
									y={repY}
									width="16"
									height="16"
									className="diff-btn-container"
								>
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
								<foreignObject
									x={applyX}
									y={downY}
									width="16"
									height="16"
									className="diff-btn-container"
								>
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
								<foreignObject
									x={deleteX}
									y={deleteY}
									width="16"
									height="16"
									className="diff-btn-container"
								>
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
