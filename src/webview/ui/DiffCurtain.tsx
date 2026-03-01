import * as React from "react";
import type { DiffChunk } from "./types";
import type { editor } from "monaco-editor";

interface DiffCurtainProps {
	diffs: DiffChunk[] | undefined;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	renderTrigger: number; // For triggering re-renders on scroll
}

export const DiffCurtain: React.FC<DiffCurtainProps> = ({
	diffs,
	leftEditor,
	rightEditor,
	renderTrigger: _renderTrigger,
}) => {
	if (!diffs || !leftEditor || !rightEditor) {
		return null;
	}

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
	}, [leftEditor, _renderTrigger]);

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
				}}
			>
				<title>Diff Connections</title>
				{diffs.map((chunk) => {
					if (chunk.tag === "equal") return null;

					const leftStartLine = Math.max(1, chunk.start_a + 1);
					const leftEndLine = Math.max(1, chunk.end_a + 1);
					const rightStartLine = Math.max(1, chunk.start_b + 1);
					const rightEndLine = Math.max(1, chunk.end_b + 1);

					const y1Top =
						leftEditor.getTopForLineNumber(leftStartLine) -
						leftEditor.getScrollTop() + headerOffset;
					let y1Bottom =
						leftEditor.getTopForLineNumber(leftEndLine) -
						leftEditor.getScrollTop() + headerOffset;
					if (chunk.start_a === chunk.end_a) y1Bottom = y1Top;

					const y2Top =
						rightEditor.getTopForLineNumber(rightStartLine) -
						rightEditor.getScrollTop() + headerOffset;
					let y2Bottom =
						rightEditor.getTopForLineNumber(rightEndLine) -
						rightEditor.getScrollTop() + headerOffset;
					if (chunk.start_b === chunk.end_b) y2Bottom = y2Top;

					const path = `M 0,${y1Top} C ${curveOffset},${y1Top} ${width - curveOffset},${y2Top} ${width},${y2Top} L ${width},${y2Bottom} C ${width - curveOffset},${y2Bottom} ${curveOffset},${y1Bottom} 0,${y1Bottom} Z`;

					const color =
						chunk.tag === "replace"
							? "rgba(0, 100, 255, 0.2)"
							: chunk.tag === "insert"
								? "rgba(0, 200, 0, 0.2)"
								: "rgba(255, 0, 0, 0.2)";

					const strokeColor =
						chunk.tag === "replace"
							? "rgba(0, 100, 255, 0.5)"
							: chunk.tag === "insert"
								? "rgba(0, 200, 0, 0.5)"
								: "rgba(255, 0, 0, 0.5)";

					return (
						<path
							key={`${chunk.start_a}-${chunk.end_a}-${chunk.start_b}-${chunk.end_b}`}
							d={path}
							fill={color}
							stroke={strokeColor}
							strokeWidth="1"
						/>
					);
				})}
			</svg>
		</div>
	);
};
