// Copyright (C) 2002-2006 Stephen Kennedy <stevek@gnome.org>
// Copyright (C) 2009-2019 Kai Willadsen <kai.willadsen@gmail.com>
// Copyright (C) 2026 Pyarelal Knowles
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation; either version 2 of the License, or (at
// your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import debounce from "lodash.debounce";
import type { editor } from "monaco-editor";
import {
	type FC,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getBounds } from "./diffCurtainUtils.ts";
import { DIFF_WIDTH, type DiffChunk } from "./types.ts";

const CURVE_OFFSET = 15;

interface DiffCurtainProps {
	diffs: DiffChunk[] | null;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	leftModel: editor.ITextModel;
	rightModel: editor.ITextModel;
	renderTrigger: number;
	reversed?: boolean | undefined;
	fadeOutLeft?: boolean | undefined;
	fadeOutRight?: boolean | undefined;
	onApplyChunk?: ((chunk: DiffChunk) => void) | undefined;
	onDeleteChunk?: ((chunk: DiffChunk) => void) | undefined;
	onCopyUpChunk?: ((chunk: DiffChunk) => void) | undefined;
	onCopyDownChunk?: ((chunk: DiffChunk) => void) | undefined;
}

const getY = (
	ed: editor.IStandaloneCodeEditor,
	line: number,
	offset: number,
	scrollOffset: number,
	isBottom = false,
) => {
	const top = isBottom
		? ed.getBottomForLineNumber(line)
		: ed.getTopForLineNumber(line);
	return top + offset - scrollOffset;
};

// getBounds is now imported from diffCurtainUtils.ts

const ActionButton: FC<{
	y: number;
	side: "left" | "right";
	icon: string;
	title: string;
	onClick: () => void;
}> = ({ y, side, icon, title, onClick }) => (
	<foreignObject
		x={side === "left" ? 2 : undefined}
		y={y - 8}
		width="16"
		height="16"
		{...(side === "right"
			? { style: { transform: `translateX(${DIFF_WIDTH - 18}px)` } }
			: {})}
	>
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			title={title}
			className="action-button"
		>
			{icon}
		</button>
	</foreignObject>
);

interface ChunkActionsProps {
	chunk: DiffChunk;
	isReplace: boolean;
	applySide: "left" | "right";
	onApp?: ((c: DiffChunk) => void) | undefined;
	onDel?: ((c: DiffChunk) => void) | undefined;
	onUp?: ((c: DiffChunk) => void) | undefined;
	onDwn?: ((c: DiffChunk) => void) | undefined;
	y1T: number;
	y2T: number;
	lEmp: boolean;
	rEmp: boolean;
}

const ChunkActions: FC<ChunkActionsProps> = (p) => {
	const iconApply = p.applySide === "left" ? "➔" : "⬅";
	const iconUp = p.applySide === "left" ? "↱" : "↰";
	const iconDown = p.applySide === "left" ? "↳" : "↲";
	const sideApp = p.applySide;
	const sideDel = p.applySide === "left" ? "right" : "left";
	const yBase = p.applySide === "left" ? p.y1T : p.y2T;
	const yDel = p.applySide === "left" ? p.y2T : p.y1T;

	const sourceEmp = p.applySide === "left" ? p.lEmp : p.rEmp;
	const destEmp = p.applySide === "left" ? p.rEmp : p.lEmp;

	return (
		<g className="diff-actions">
			{p.onApp && !sourceEmp && (
				<ActionButton
					y={yBase + 8}
					side={sideApp}
					icon={iconApply}
					title="Push"
					onClick={() => p.onApp?.(p.chunk)}
				/>
			)}
			{p.onUp && p.isReplace && !sourceEmp && (
				<ActionButton
					y={yBase - 8}
					side={sideApp}
					icon={iconUp}
					title="Copy Up"
					onClick={() => p.onUp?.(p.chunk)}
				/>
			)}
			{p.onDwn && p.isReplace && !sourceEmp && (
				<ActionButton
					y={yBase + 24}
					side={sideApp}
					icon={iconDown}
					title="Copy Down"
					onClick={() => p.onDwn?.(p.chunk)}
				/>
			)}
			{p.onDel && !destEmp && (
				<ActionButton
					y={yDel + 8}
					side={sideDel}
					icon="×"
					title="Delete"
					onClick={() => p.onDel?.(p.chunk)}
				/>
			)}
		</g>
	);
};

const ChunkRenderer: FC<{
	chunk: DiffChunk;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	reversed: boolean;
	fadeL: boolean;
	fadeR: boolean;
	onApp?: ((c: DiffChunk) => void) | undefined;
	onDel?: ((c: DiffChunk) => void) | undefined;
	onUp?: ((c: DiffChunk) => void) | undefined;
	onDwn?: ((c: DiffChunk) => void) | undefined;
	leftOffset: number;
	rightOffset: number;
	activeTops: { left: number; right: number };
	maskId?: string | undefined;
	lMax: number;
	rMax: number;
}> = (p) => {
	const b = getBounds({
		startA: p.chunk.startA,
		endA: p.chunk.endA,
		startB: p.chunk.startB,
		endB: p.chunk.endB,
		lMax: p.lMax,
		rMax: p.rMax,
		reversed: p.reversed,
	});
	const y1T = getY(p.leftEditor, b.lS, p.leftOffset, p.activeTops.left);
	const y2T = getY(p.rightEditor, b.rS, p.rightOffset, p.activeTops.right);
	const y1B = b.lEmp
		? y1T
		: getY(p.leftEditor, b.lE - 1, p.leftOffset, p.activeTops.left, true);
	const y2B = b.rEmp
		? y2T
		: getY(
				p.rightEditor,
				b.rE - 1,
				p.rightOffset,
				p.activeTops.right,
				true,
			);
	const w = DIFF_WIDTH;
	const c = CURVE_OFFSET;
	const main = `M 0,${y1T} C ${c},${y1T} ${w - c},${y2T} ${w},${y2T} L ${w},${y2B} C ${w - c},${y2B} ${c},${y1B} 0,${y1B} Z`;
	const top = `M 0,${y1T} C ${c},${y1T} ${w - c},${y2T} ${w},${y2T}`;
	const bot = `M 0,${y1B} C ${c},${y1B} ${w - c},${y2B} ${w},${y2B}`;
	return (
		<g
			className={`diff-container tag-${p.chunk.tag}`}
			mask={p.maskId}
			style={{ pointerEvents: "auto" }}
		>
			<path className={`diff-path-${p.chunk.tag}`} d={main} />
			<path className={`diff-edge-${p.chunk.tag}`} d={top} fill="none" />
			<path className={`diff-edge-${p.chunk.tag}`} d={bot} fill="none" />
			{(p.onApp || p.onDel || p.onUp || p.onDwn) && (
				<ChunkActions
					chunk={p.chunk}
					isReplace={p.chunk.tag === "replace"}
					applySide={p.reversed ? "left" : "right"}
					y1T={y1T}
					y2T={y2T}
					lEmp={b.lEmp}
					rEmp={b.rEmp}
					onApp={p.onApp}
					onDel={p.onDel}
					onUp={p.onUp}
					onDwn={p.onDwn}
				/>
			)}
		</g>
	);
};

const SVGMasks: FC<{
	prefix: string;
}> = ({ prefix }) => {
	const gl = `${prefix}-gl`;
	const gr = `${prefix}-gr`;
	const gb = `${prefix}-gb`;
	return (
		<defs>
			<linearGradient id={gl} x1="0" y1="0" x2="1" y2="0">
				<stop offset="0%" stopColor="black" />
				<stop offset="80%" stopColor="white" />
				<stop offset="100%" stopColor="white" />
			</linearGradient>
			<linearGradient id={gr} x1="0" y1="0" x2="1" y2="0">
				<stop offset="0%" stopColor="white" />
				<stop offset="20%" stopColor="white" />
				<stop offset="100%" stopColor="black" />
			</linearGradient>
			<linearGradient id={gb} x1="0" y1="0" x2="1" y2="0">
				<stop offset="0%" stopColor="black" />
				<stop offset="20%" stopColor="white" />
				<stop offset="80%" stopColor="white" />
				<stop offset="100%" stopColor="black" />
			</linearGradient>
			<mask id={`${prefix}-left`}>
				<rect width="100%" height="100%" fill={`url(#${gl})`} />
			</mask>
			<mask id={`${prefix}-right`}>
				<rect width="100%" height="100%" fill={`url(#${gr})`} />
			</mask>
			<mask id={`${prefix}-both`}>
				<rect width="100%" height="100%" fill={`url(#${gb})`} />
			</mask>
		</defs>
	);
};

const isChunkInView = (
	b: ReturnType<typeof getBounds>,
	leftEditor: editor.IStandaloneCodeEditor,
	rightEditor: editor.IStandaloneCodeEditor,
	p: {
		leftOffset: number;
		rightOffset: number;
		activeTops: { left: number; right: number };
		curtainHeight: number;
	},
): boolean => {
	const m = 200;
	const y1 = getY(leftEditor, b.lS, p.leftOffset, p.activeTops.left);
	const y2 = getY(rightEditor, b.rS, p.rightOffset, p.activeTops.right);
	if (Math.min(y1, y2) > p.curtainHeight + m) {
		return false;
	}
	const y1B = b.lEmp
		? y1
		: getY(leftEditor, b.lE - 1, p.leftOffset, p.activeTops.left, true);
	const y2B = b.rEmp
		? y2
		: getY(rightEditor, b.rE - 1, p.rightOffset, p.activeTops.right, true);
	return Math.max(y1B, y2B) >= -m;
};

const useFilteredDiffs = (p: {
	diffs: DiffChunk[] | null;
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	leftModel: editor.ITextModel;
	rightModel: editor.ITextModel;
	reversed: boolean;
	curtainHeight: number;
	leftOffset: number;
	rightOffset: number;
	activeTops: { left: number; right: number };
	lMax: number;
	rMax: number;
	renderTrigger: number;
}) =>
	// biome-ignore lint/correctness/useExhaustiveDependencies: p.renderTrigger is required for scroll-reactive filtering
	useMemo(() => {
		const { diffs, leftEditor, rightEditor } = p;
		if (!diffs) {
			return [];
		}
		// Predicate: is this chunk referencing lines beyond current model bounds?
		// This happens transiently between a content update and the next diff recompute.
		const isStale = (c: DiffChunk) => {
			const lEnd = p.reversed ? c.endB : c.endA;
			const rEnd = p.reversed ? c.endA : c.endB;
			return lEnd > p.lMax || rEnd > p.rMax;
		};
		if (p.curtainHeight === 0) {
			return diffs
				.filter((c) => c.tag !== "equal" && !isStale(c))
				.slice(0, 100);
		}
		return diffs.filter((c) => {
			if (c.tag === "equal" || isStale(c)) {
				return false;
			}
			const b = getBounds({
				startA: c.startA,
				endA: c.endA,
				startB: c.startB,
				endB: c.endB,
				lMax: p.lMax,
				rMax: p.rMax,
				reversed: p.reversed,
			});
			return isChunkInView(b, leftEditor, rightEditor, p);
		});
	}, [
		p.diffs,
		p.lMax,
		p.rMax,
		p.leftEditor,
		p.rightEditor,
		p.reversed,
		p.curtainHeight,
		p.leftOffset,
		p.rightOffset,
		p.activeTops,
		p.renderTrigger,
	]);

const useCurtainLayout = (
	ref: React.RefObject<HTMLDivElement | null>,
	leftEditor: editor.IStandaloneCodeEditor,
	rightEditor: editor.IStandaloneCodeEditor,
) => {
	const [height, setHeight] = useState(0);
	const [top, setTop] = useState(0);
	const [leftOffset, setLeftOffset] = useState(0);
	const [rightOffset, setRightOffset] = useState(0);

	useLayoutEffect(() => {
		if (!ref.current) {
			return;
		}
		const updateLayout = () => {
			const rect = ref.current?.getBoundingClientRect();
			if (!rect) {
				return;
			}
			setHeight(rect.height);
			setTop(rect.top);

			const lNode = leftEditor.getContainerDomNode();
			const rNode = rightEditor.getContainerDomNode();

			if (lNode) {
				const lRect = lNode.getBoundingClientRect();
				setLeftOffset(Math.max(0, lRect.top - rect.top));
			}
			if (rNode) {
				const rRect = rNode.getBoundingClientRect();
				setRightOffset(Math.max(0, rRect.top - rect.top));
			}
		};

		const obs = new ResizeObserver(updateLayout);
		obs.observe(ref.current);

		const lDom = leftEditor.getContainerDomNode();
		const rDom = rightEditor.getContainerDomNode();
		if (lDom) {
			obs.observe(lDom);
		}
		if (rDom) {
			obs.observe(rDom);
		}

		window.addEventListener("resize", updateLayout);
		updateLayout();

		return () => {
			obs.disconnect();
			window.removeEventListener("resize", updateLayout);
		};
	}, [ref, leftEditor, rightEditor]);

	return { height, top, leftOffset, rightOffset };
};

const useCurtainScroll = (
	leftEditor: editor.IStandaloneCodeEditor,
	rightEditor: editor.IStandaloneCodeEditor,
) => {
	const [activeTops, setActiveTops] = useState({
		left: leftEditor?.getScrollTop() || 0,
		right: rightEditor?.getScrollTop() || 0,
	});
	const [liveTops, setLiveTops] = useState({
		left: leftEditor?.getScrollTop() || 0,
		right: rightEditor?.getScrollTop() || 0,
	});

	const debouncedUpdate = useMemo(
		() =>
			debounce(
				(left: number, right: number) => {
					setActiveTops({ left, right });
				},
				60,
				{ leading: true },
			),
		[],
	);

	useEffect(() => {
		const handleScroll = () => {
			const l = leftEditor.getScrollTop();
			const r = rightEditor.getScrollTop();
			setLiveTops({ left: l, right: r });
			debouncedUpdate(l, r);
		};
		const lD = leftEditor.onDidScrollChange(handleScroll);
		const rD = rightEditor.onDidScrollChange(handleScroll);
		handleScroll();
		return () => {
			lD.dispose();
			rD.dispose();
			debouncedUpdate.cancel();
		};
	}, [leftEditor, rightEditor, debouncedUpdate]);

	return { activeTops, liveTops };
};

export const DiffCurtain: FC<DiffCurtainProps> = (p) => {
	const curtainRef = useRef<HTMLDivElement>(null);
	const {
		height: curtainH,
		leftOffset,
		rightOffset,
	} = useCurtainLayout(curtainRef, p.leftEditor, p.rightEditor);
	const { activeTops, liveTops } = useCurtainScroll(
		p.leftEditor,
		p.rightEditor,
	);
	const id = useId();

	const lMax = p.leftModel.getLineCount();
	const rMax = p.rightModel.getLineCount();

	const filtered = useFilteredDiffs({
		diffs: p.diffs,
		leftEditor: p.leftEditor,
		rightEditor: p.rightEditor,
		leftModel: p.leftModel,
		rightModel: p.rightModel,
		reversed: Boolean(p.reversed),
		curtainHeight: curtainH,
		leftOffset,
		rightOffset,
		activeTops,
		lMax,
		rMax,
		renderTrigger: p.renderTrigger,
	});

	const maskId =
		p.fadeOutLeft && p.fadeOutRight
			? `url(#${id}-both)`
			: p.fadeOutLeft
				? `url(#${id}-left)`
				: p.fadeOutRight
					? `url(#${id}-right)`
					: undefined;

	return (
		<div
			ref={curtainRef}
			style={{
				width: `${DIFF_WIDTH}px`,
				height: "100%",
				position: "relative",
				flexShrink: 0,
				background: "var(--vscode-editor-background)",
				borderLeft: "1px solid var(--vscode-editorGroup-border, #333)",
				borderRight: "1px solid var(--vscode-editorGroup-border, #333)",
				zIndex: 10,
			}}
		>
			<svg
				width="100%"
				height="100%"
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					overflow: "visible",
					pointerEvents: "auto",
				}}
				role="img"
			>
				<title>Diff Connections</title>
				<SVGMasks prefix={id} />
				<g
					className="diff-view"
					style={{
						transform: `translateY(${activeTops.left - liveTops.left}px)`,
					}}
				>
					{/* biome-ignore lint/performance/useSolidForComponent: React project false positive */}
					{filtered.map((c) => (
						<ChunkRenderer
							key={`${c.startA}-${c.startB}-${c.endA}-${c.endB}`}
							chunk={c}
							leftEditor={
								p.leftEditor as editor.IStandaloneCodeEditor
							}
							rightEditor={
								p.rightEditor as editor.IStandaloneCodeEditor
							}
							reversed={Boolean(p.reversed)}
							fadeL={Boolean(p.fadeOutLeft)}
							fadeR={Boolean(p.fadeOutRight)}
							onApp={p.onApplyChunk}
							onDel={p.onDeleteChunk}
							onUp={p.onCopyUpChunk}
							onDwn={p.onCopyDownChunk}
							leftOffset={leftOffset}
							rightOffset={rightOffset}
							activeTops={activeTops}
							maskId={maskId}
							lMax={lMax}
							rMax={rMax}
						/>
					))}
				</g>
			</svg>
		</div>
	);
};
