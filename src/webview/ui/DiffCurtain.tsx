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

import type { editor } from "monaco-editor";
import { type FC, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffChunk } from "./types.ts";

interface DiffCurtainProps {
	diffs: DiffChunk[];
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
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
	activeTop: number,
) => {
	const top = ed.getTopForLineNumber(line);
	return top + offset - activeTop;
};

const getBounds = (p: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
	reversed: boolean;
}) => {
	const lS = p.reversed ? p.startB : p.startA;
	const lE = p.reversed ? p.endB : p.endA;
	const rS = p.reversed ? p.startA : p.startB;
	const rE = p.reversed ? p.endA : p.endB;
	return { lS, lE, rS, rE, lEmp: lS === lE, rEmp: rS === rE };
};

const ActionButton: FC<{
	y: number;
	side: "left" | "right";
	icon: string;
	title: string;
	onClick: () => void;
}> = ({ y, side, icon, title, onClick }) => (
	<foreignObject
		x={side === "left" ? 4 : undefined}
		y={y - 8}
		width="16"
		height="16"
		{...(side === "right"
			? { style: { transform: "translateX(calc(100% - 20px))" } }
			: {})}
	>
		<button
			type="button"
			onClick={onClick}
			title={title}
			className="action-button"
		>
			{icon}
		</button>
	</foreignObject>
);

interface ChunkActionsProps {
	chunk: DiffChunk;
	reversed: boolean;
	y1T: number;
	y2T: number;
	onApp?: ((c: DiffChunk) => void) | undefined;
	onDel?: ((c: DiffChunk) => void) | undefined;
	onUp?: ((c: DiffChunk) => void) | undefined;
	onDwn?: ((c: DiffChunk) => void) | undefined;
}

const ChunkActions: FC<ChunkActionsProps> = (p) => (
	<g className="diff-actions">
		{p.onApp && !p.reversed && (
			<ActionButton
				y={p.y1T + 8}
				side="left"
				icon="➞"
				title="Apply"
				onClick={() => p.onApp?.(p.chunk)}
			/>
		)}
		{p.onUp && !p.reversed && (
			<ActionButton
				y={p.y1T - 8}
				side="left"
				icon="⤤"
				title="Add Above"
				onClick={() => p.onUp?.(p.chunk)}
			/>
		)}
		{p.onDwn && !p.reversed && (
			<ActionButton
				y={p.y1T + 24}
				side="left"
				icon="⤥"
				title="Add Below"
				onClick={() => p.onDwn?.(p.chunk)}
			/>
		)}
		{p.onDel && (
			<ActionButton
				y={p.y1T + 8}
				side="left"
				icon="⨉"
				title="Delete"
				onClick={() => p.onDel?.(p.chunk)}
			/>
		)}
		{p.onApp && p.reversed && (
			<ActionButton
				y={p.y2T + 8}
				side="right"
				icon="⬅"
				title="Apply"
				onClick={() => p.onApp?.(p.chunk)}
			/>
		)}
		{p.onUp && p.reversed && (
			<ActionButton
				y={p.y2T - 8}
				side="right"
				icon="⤣"
				title="Add Above"
				onClick={() => p.onUp?.(p.chunk)}
			/>
		)}
		{p.onDwn && p.reversed && (
			<ActionButton
				y={p.y2T + 24}
				side="right"
				icon="⤦"
				title="Add Below"
				onClick={() => p.onDwn?.(p.chunk)}
			/>
		)}
	</g>
);

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
}> = (p) => {
	const b = getBounds({
		startA: p.chunk.startA,
		endA: p.chunk.endA,
		startB: p.chunk.startB,
		endB: p.chunk.endB,
		reversed: p.reversed,
	});
	const y1T = getY(p.leftEditor, b.lS, p.leftOffset, p.activeTops.left);
	const y2T = getY(p.rightEditor, b.rS, p.rightOffset, p.activeTops.right);
	const y1B = getY(
		p.leftEditor,
		b.lEmp ? b.lS : b.lE,
		p.leftOffset,
		p.activeTops.left,
	);
	const y2B = getY(
		p.rightEditor,
		b.rEmp ? b.rS : b.rE,
		p.rightOffset,
		p.activeTops.right,
	);
	const main = `M 0 ${y1T} C 15 ${y1T}, 85 ${y2T}, 100 ${y2T} L 100 ${y2B} C 85 ${y2B}, 15 ${y1B}, 0 ${y1B} Z`;
	const maskId =
		p.fadeL && p.fadeR
			? "url(#both)"
			: p.fadeL
				? "url(#left)"
				: p.fadeR
					? "url(#right)"
					: undefined;
	return (
		<g className="diff-container" mask={maskId}>
			<path className={`diff-path-${p.chunk.tag}`} d={main} />
			<path
				className={`diff-edge-${p.chunk.tag}`}
				d={`M 0 ${y1T} C 15 ${y1T}, 85 ${y2T}, 100 ${y2T}`}
				fill="none"
			/>
			<path
				className={`diff-edge-${p.chunk.tag}`}
				d={`M 0 ${y1B} C 15 ${y1B}, 85 ${y2B}, 100 ${y2B}`}
				fill="none"
			/>
			{(p.onApp || p.onDel || p.onUp || p.onDwn) && (
				<ChunkActions
					chunk={p.chunk}
					reversed={p.reversed}
					y1T={y1T}
					y2T={y2T}
					onApp={p.onApp}
					onDel={p.onDel}
					onUp={p.onUp}
					onDwn={p.onDwn}
				/>
			)}
		</g>
	);
};

const SVGMasks = () => (
	<defs>
		<linearGradient id="fadeLeft" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stopColor="black" stopOpacity="0" />
			<stop offset="0.4" stopColor="black" stopOpacity="1" />
		</linearGradient>
		<linearGradient id="fadeRight" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0.6" stopColor="black" stopOpacity="1" />
			<stop offset="1" stopColor="black" stopOpacity="0" />
		</linearGradient>
		<mask id="left">
			<rect width="100%" height="100%" fill="url(#fadeLeft)" />
		</mask>
		<mask id="right">
			<rect width="100%" height="100%" fill="url(#fadeRight)" />
		</mask>
		<mask id="both">
			<rect width="100%" height="100%" fill="white" />
			<rect width="100%" height="100%" fill="url(#fadeLeft)" />
			<rect width="100%" height="100%" fill="url(#fadeRight)" />
		</mask>
	</defs>
);

const useFilteredDiffs = (p: {
	diffs: DiffChunk[];
	leftEditor: editor.IStandaloneCodeEditor;
	rightEditor: editor.IStandaloneCodeEditor;
	reversed: boolean;
	curtainHeight: number;
	leftOffset: number;
	rightOffset: number;
	activeTops: { left: number; right: number };
}) =>
	useMemo(() => {
		if (p.curtainHeight === 0) {
			return p.diffs;
		}
		const m = 200;
		return p.diffs.filter((c) => {
			if (c.tag === "equal") {
				return false;
			}
			const b = getBounds({
				startA: c.startA,
				endA: c.endA,
				startB: c.startB,
				endB: c.endB,
				reversed: p.reversed,
			});
			const y1 = getY(
				p.leftEditor,
				b.lS,
				p.leftOffset,
				p.activeTops.left,
			);
			const y2 = getY(
				p.rightEditor,
				b.rS,
				p.rightOffset,
				p.activeTops.right,
			);
			if (Math.min(y1, y2) > p.curtainHeight + m) {
				return false;
			}
			const y1B = getY(
				p.leftEditor,
				b.lEmp ? b.lS : b.lE,
				p.leftOffset,
				p.activeTops.left,
			);
			const y2B = getY(
				p.rightEditor,
				b.rEmp ? b.rS : b.rE,
				p.rightOffset,
				p.activeTops.right,
			);
			return Math.max(y1B, y2B) >= -m;
		});
	}, [
		p.diffs,
		p.leftEditor,
		p.rightEditor,
		p.reversed,
		p.curtainHeight,
		p.leftOffset,
		p.rightOffset,
		p.activeTops,
	]);

export const DiffCurtain: FC<DiffCurtainProps> = (p) => {
	const curtainRef = useRef<HTMLDivElement>(null);
	const [curtainH, setCurtainH] = useState(0);
	const [activeTops, setActiveTops] = useState({ left: 0, right: 0 });

	useLayoutEffect(() => {
		if (!curtainRef.current) {
			return;
		}
		const obs = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setCurtainH(entry.contentRect.height);
			}
		});
		obs.observe(curtainRef.current);
		return () => obs.disconnect();
	}, []);

	useLayoutEffect(() => {
		const lH = () =>
			setActiveTops((prev) => ({
				...prev,
				left: p.leftEditor.getScrollTop(),
			}));
		const rH = () =>
			setActiveTops((prev) => ({
				...prev,
				right: p.rightEditor.getScrollTop(),
			}));
		const lD = p.leftEditor.onDidScrollChange(lH);
		const rD = p.rightEditor.onDidScrollChange(rH);
		lH();
		rH();
		return () => {
			lD.dispose();
			rD.dispose();
		};
	}, [p.leftEditor, p.rightEditor]);

	const leftDom = p.leftEditor.getDomNode();
	const leftOffset = leftDom ? leftDom.getBoundingClientRect().top : 0;
	const rightDom = p.rightEditor.getDomNode();
	const rightOffset = rightDom ? rightDom.getBoundingClientRect().top : 0;

	const filtered = useFilteredDiffs({
		diffs: p.diffs,
		leftEditor: p.leftEditor,
		rightEditor: p.rightEditor,
		reversed: Boolean(p.reversed),
		curtainHeight: curtainH,
		leftOffset,
		rightOffset,
		activeTops,
	});

	return (
		<div
			ref={curtainRef}
			style={{
				width: "30px",
				height: "100%",
				position: "relative",
				overflow: "hidden",
				flexShrink: 0,
			}}
		>
			<svg
				width="100%"
				height="100%"
				preserveAspectRatio="none"
				viewBox="0 0 100 100"
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					pointerEvents: "none",
					overflow: "visible",
				}}
				role="img"
			>
				<title>Diff connectors</title>
				<SVGMasks />
				<g
					className="diff-view"
					style={{ transform: `translateY(${-leftOffset}px)` }}
				>
					{/* biome-ignore lint/performance/useSolidForComponent: React project false positive */}
					{filtered.map((c) => (
						<ChunkRenderer
							key={`${c.startA}-${c.startB}`}
							chunk={c}
							leftEditor={p.leftEditor}
							rightEditor={p.rightEditor}
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
						/>
					))}
				</g>
			</svg>
		</div>
	);
};
