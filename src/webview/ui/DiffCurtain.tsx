// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import type { editor } from "monaco-editor";
import { type FC, useEffect, useMemo, useRef, useState } from "react";
import { DIFF_WIDTH, type DiffChunk } from "./types.ts";

interface DiffCurtainProps {
	diffs: DiffChunk[] | undefined;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	renderTrigger: number;
	reversed: boolean;
	fadeOutLeft?: boolean | undefined;
	fadeOutRight?: boolean | undefined;
	onApplyChunk?: ((chunk: DiffChunk) => void) | undefined;
	onDeleteChunk?: ((chunk: DiffChunk) => void) | undefined;
	onCopyUpChunk?: ((chunk: DiffChunk) => void) | undefined;
	onCopyDownChunk?: ((chunk: DiffChunk) => void) | undefined;
}

const CURVE_OFFSET = 15;
const BTN_SIZE = 16;
const BTN_MARGIN = 3;
const TITLE_TEXT = "Diff Connections";
const DELETE_ICON = "\u00D7";

interface ColorTheme {
	readonly replace: string;
	readonly conflict: string;
	readonly delete: string;
	readonly insert: string;
}

const FILL: ColorTheme = {
	replace:
		"var(--vscode-meldMerge-diffCurtainReplaceFill, rgba(0, 100, 255, 0.2))",
	conflict:
		"var(--vscode-meldMerge-diffCurtainConflictFill, rgba(255, 0, 0, 0.2))",
	delete: "var(--vscode-meldMerge-diffCurtainDeleteFill, rgba(0, 200, 0, 0.2))",
	insert: "var(--vscode-meldMerge-diffCurtainInsertFill, rgba(0, 200, 0, 0.2))",
};

const STROKE: ColorTheme = {
	replace:
		"var(--vscode-meldMerge-diffCurtainReplaceStroke, rgba(0, 100, 255, 0.5))",
	conflict:
		"var(--vscode-meldMerge-diffCurtainConflictStroke, rgba(255, 0, 0, 0.5))",
	delete: "var(--vscode-meldMerge-diffCurtainDeleteStroke, rgba(0, 200, 0, 0.5))",
	insert: "var(--vscode-meldMerge-diffCurtainInsertStroke, rgba(0, 200, 0, 0.5))",
};

function getFill(tag: string): string {
	if (tag === "replace") {
		return FILL.replace;
	}
	if (tag === "conflict") {
		return FILL.conflict;
	}
	if (tag === "delete") {
		return FILL.delete;
	}
	return FILL.insert;
}

function getStroke(tag: string): string {
	if (tag === "replace") {
		return STROKE.replace;
	}
	if (tag === "conflict") {
		return STROKE.conflict;
	}
	if (tag === "delete") {
		return STROKE.delete;
	}
	return STROKE.insert;
}

interface ChunkActionsProps {
	chunk: DiffChunk;
	isReplace: boolean;
	canApply: boolean;
	canDelete: boolean;
	applySide: "left" | "right";
	coords: {
		xApp: number;
		xDel: number;
		yUp: number;
		yRep: number;
		yDwn: number;
		yDel: number;
	};
	onApp: ((chunk: DiffChunk) => void) | undefined;
	onDel: ((chunk: DiffChunk) => void) | undefined;
	onUp: ((chunk: DiffChunk) => void) | undefined;
	onDwn: ((chunk: DiffChunk) => void) | undefined;
}

const ChunkActions: FC<ChunkActionsProps> = (p) => {
	const iconApply = p.applySide === "left" ? "➔" : "⬅";
	const iconUp = p.applySide === "left" ? "↱" : "↰";
	const iconDown = p.applySide === "left" ? "↳" : "↲";

	return (
		<>
			{p.canApply && p.onUp && p.isReplace && (
				<foreignObject
					x={p.coords.xApp}
					y={p.coords.yUp}
					width="16"
					height="16"
					className="diff-btn-container"
				>
					<button
						type="button"
						className="diff-btn"
						onClick={() => p.onUp?.(p.chunk)}
						title="Copy up"
					>
						{iconUp}
					</button>
				</foreignObject>
			)}
			{p.canApply && p.onApp && (
				<foreignObject
					x={p.coords.xApp}
					y={p.coords.yRep}
					width="16"
					height="16"
					className="diff-btn-container"
				>
					<button
						type="button"
						className="diff-btn"
						onClick={() => p.onApp?.(p.chunk)}
						title="Push"
					>
						{iconApply}
					</button>
				</foreignObject>
			)}
			{p.canApply && p.onDwn && p.isReplace && (
				<foreignObject
					x={p.coords.xApp}
					y={p.coords.yDwn}
					width="16"
					height="16"
					className="diff-btn-container"
				>
					<button
						type="button"
						className="diff-btn"
						onClick={() => p.onDwn?.(p.chunk)}
						title="Copy down"
					>
						{iconDown}
					</button>
				</foreignObject>
			)}
			{p.canDelete && p.onDel && (
				<foreignObject
					x={p.coords.xDel}
					y={p.coords.yDel}
					width="16"
					height="16"
					className="diff-btn-container"
				>
					<button
						type="button"
						className="diff-btn diff-cross-icon"
						onClick={() => p.onDel?.(p.chunk)}
						title="Delete"
					>
						{DELETE_ICON}
					</button>
				</foreignObject>
			)}
		</>
	);
};

interface ChunkRendererProps {
	chunk: DiffChunk;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	leftMax: number;
	rightMax: number;
	leftOffset: number;
	rightOffset: number;
	reversed: boolean;
	fadeL?: boolean | undefined;
	fadeR?: boolean | undefined;
	onApp: ((chunk: DiffChunk) => void) | undefined;
	onDel: ((chunk: DiffChunk) => void) | undefined;
	onUp: ((chunk: DiffChunk) => void) | undefined;
	onDwn: ((chunk: DiffChunk) => void) | undefined;
}

const getY = (ed: editor.IStandaloneCodeEditor, line: number, off: number) =>
	ed.getTopForLineNumber(line) - ed.getScrollTop() + off;

function computePaths(y1T: number, y1B: number, y2T: number, y2B: number) {
	const w = DIFF_WIDTH;
	const c = CURVE_OFFSET;
	const main = `M 0,${y1T} C ${c},${y1T} ${w - c},${y2T} ${w},${y2T} L ${w},${y2B} C ${w - c},${y2B} ${c},${y1B} 0,${y1B} Z`;
	const top = `M 0,${y1T} C ${c},${y1T} ${w - c},${y2T} ${w},${y2T}`;
	const bot = `M ${w},${y2B} C ${w - c},${y2B} ${c},${y1B} 0,${y1B}`;
	return { main, top, bot };
}

function getBounds(p: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
	lMax: number;
	rMax: number;
	reversed: boolean;
}) {
	const lS = Math.min(
		p.lMax,
		Math.max(1, (p.reversed ? p.startB : p.startA) + 1),
	);
	const lE = Math.min(
		p.lMax,
		Math.max(1, (p.reversed ? p.endB : p.endA) + 1),
	);
	const rS = Math.min(
		p.rMax,
		Math.max(1, (p.reversed ? p.startA : p.startB) + 1),
	);
	const rE = Math.min(
		p.rMax,
		Math.max(1, (p.reversed ? p.endA : p.endB) + 1),
	);
	const lEmp = p.reversed ? p.startB === p.endB : p.startA === p.endA;
	const rEmp = p.reversed ? p.startA === p.endA : p.startB === p.endB;
	return { lS, lE, rS, rE, lEmp, rEmp };
}

const ChunkRenderer: FC<ChunkRendererProps> = (p) => {
	if (p.chunk.tag === "equal") {
		return null;
	}

	const { lS, lE, rS, rE, lEmp, rEmp } = getBounds({
		startA: p.chunk.startA,
		endA: p.chunk.endA,
		startB: p.chunk.startB,
		endB: p.chunk.endB,
		lMax: p.leftMax,
		rMax: p.rightMax,
		reversed: p.reversed,
	});
	const y1T = getY(p.leftEditor, lS, p.leftOffset);
	const y1B = lEmp ? y1T : getY(p.leftEditor, lE, p.leftOffset);
	const y2T = getY(p.rightEditor, rS, p.rightOffset);
	const y2B = rEmp ? y2T : getY(p.rightEditor, rE, p.rightOffset);

	const { main, top, bot } = computePaths(y1T, y1B, y2T, y2B);
	const sAp = p.reversed ? "left" : "right";
	const sDl = p.reversed ? "right" : "left";
	const xAp =
		sAp === "left" ? BTN_MARGIN : DIFF_WIDTH - BTN_SIZE - BTN_MARGIN;
	const xDl =
		sDl === "left" ? BTN_MARGIN : DIFF_WIDTH - BTN_SIZE - BTN_MARGIN;
	const yBa = (sAp === "left" ? y1T : y2T) + BTN_MARGIN;

	let maskId: string | undefined;
	if (p.fadeL && p.fadeR) {
		maskId = "url(#both)";
	} else if (p.fadeL) {
		maskId = "url(#left)";
	} else if (p.fadeR) {
		maskId = "url(#right)";
	}

	return (
		<g className="diff-container" mask={maskId}>
			<path d={main} fill={getFill(p.chunk.tag)} stroke="none" />
			<path
				d={top}
				fill="none"
				stroke={getStroke(p.chunk.tag)}
				strokeWidth="1"
			/>
			<path
				d={bot}
				fill="none"
				stroke={getStroke(p.chunk.tag)}
				strokeWidth="1"
			/>
			<ChunkActions
				chunk={p.chunk}
				isReplace={p.chunk.tag === "replace"}
				canApply={
					p.chunk.tag === "replace" || p.chunk.startB < p.chunk.endB
				}
				canDelete={
					p.chunk.tag === "replace" || p.chunk.startA < p.chunk.endA
				}
				applySide={sAp}
				onApp={p.onApp}
				onDel={p.onDel}
				onUp={p.onUp}
				onDwn={p.onDwn}
				coords={{
					xApp: xAp,
					xDel: xDl,
					yRep: yBa,
					yUp: yBa - BTN_SIZE - 2,
					yDwn: yBa + BTN_SIZE + 2,
					yDel: (sDl === "left" ? y1T : y2T) + BTN_MARGIN,
				}}
			/>
		</g>
	);
};

export const DiffCurtain: FC<DiffCurtainProps> = (p) => {
	const [leftOffset, setLeftOffset] = useState(0);
	const [rightOffset, setRightOffset] = useState(0);
	const curtainRef = useRef<HTMLDivElement>(null);
	const lModel = useMemo(() => p.leftEditor?.getModel(), [p.leftEditor]);
	const rModel = useMemo(() => p.rightEditor?.getModel(), [p.rightEditor]);

	useEffect(() => {
		const calc = () => {
			const cNode = curtainRef.current;
			if (!cNode) {
				return;
			}
			const rect = cNode.getBoundingClientRect();
			const lNode = p.leftEditor?.getContainerDomNode();
			const rNode = p.rightEditor?.getContainerDomNode();
			if (lNode) {
				const lRect = lNode.getBoundingClientRect();
				setLeftOffset(Math.max(0, lRect.top - rect.top));
			}
			if (rNode) {
				const rRect = rNode.getBoundingClientRect();
				setRightOffset(Math.max(0, rRect.top - rect.top));
			}
		};
		calc();
		window.addEventListener("resize", calc);
		const obs = new ResizeObserver(calc);
		const lDom = p.leftEditor?.getContainerDomNode();
		const rDom = p.rightEditor?.getContainerDomNode();
		const cDom = curtainRef.current;
		if (lDom) {
			obs.observe(lDom);
		}
		if (rDom) {
			obs.observe(rDom);
		}
		if (cDom) {
			obs.observe(cDom);
		}
		return () => {
			window.removeEventListener("resize", calc);
			obs.disconnect();
		};
	}, [p.leftEditor, p.rightEditor]);

	if (!p.diffs) {
		return null;
	}
	if (!p.leftEditor) {
		return null;
	}
	if (!p.rightEditor) {
		return null;
	}
	if (!lModel) {
		return null;
	}
	if (!rModel) {
		return null;
	}
	const lMax = lModel.getLineCount();
	const rMax = rModel.getLineCount();

	return (
		<div
			ref={curtainRef}
			style={{
				width: `${DIFF_WIDTH}px`,
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
				<title>{TITLE_TEXT}</title>
				<defs>
					<mask id="left">
						<linearGradient id="gl">
							<stop offset="0%" stopColor="black" />
							<stop offset="80%" stopColor="white" />
							<stop offset="100%" stopColor="white" />
						</linearGradient>
						<rect width="100%" height="100%" fill="url(#gl)" />
					</mask>
					<mask id="right">
						<linearGradient id="gr">
							<stop offset="0%" stopColor="white" />
							<stop offset="20%" stopColor="white" />
							<stop offset="100%" stopColor="black" />
						</linearGradient>
						<rect width="100%" height="100%" fill="url(#gr)" />
					</mask>
					<mask id="both">
						<linearGradient id="gb">
							<stop offset="0%" stopColor="black" />
							<stop offset="20%" stopColor="white" />
							<stop offset="80%" stopColor="white" />
							<stop offset="100%" stopColor="black" />
						</linearGradient>
						<rect width="100%" height="100%" fill="url(#gb)" />
					</mask>
				</defs>
				<style>{`
					.diff-btn-container { opacity: 0; transition: opacity 0.1s; overflow: visible; }
					.diff-container:hover .diff-btn-container { opacity: 1; }
					.diff-btn { width: 16px; height: 16px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.5); border-radius: 3px; color: white; font-size: 13px; display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; box-sizing: border-box; line-height: 1; }
					.diff-btn:hover { background: rgba(100,100,100,0.9); border-color: rgba(255,255,255,0.6); }
					.diff-cross-icon { font-size: 16px; font-weight: bold; margin-top: -2px; }
				`}</style>
				{/* biome-ignore lint/performance/useSolidForComponent: False positive in React project */}
				{p.diffs.map((c) => (
					<ChunkRenderer
						key={`${c.startA}-${c.endA}-${c.startB}-${c.endB}`}
						chunk={c}
						leftEditor={p.leftEditor}
						rightEditor={p.rightEditor}
						leftMax={lMax}
						rightMax={rMax}
						leftOffset={leftOffset}
						rightOffset={rightOffset}
						reversed={p.reversed}
						fadeL={p.fadeOutLeft}
						fadeR={p.fadeOutRight}
						onApp={p.onApplyChunk}
						onDel={p.onDeleteChunk}
						onUp={p.onCopyUpChunk}
						onDwn={p.onCopyDownChunk}
					/>
				))}
			</svg>
		</div>
	);
};
