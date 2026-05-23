// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	type FC,
	type ReactElement,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import type { CommitInfo } from "./types.ts";

interface GitGraphProps {
	commits: CommitInfo[];
	baseSha: string;
	localSha: string;
	remoteSha: string;
	selectedSha: string;
	onSelect: (sha: string) => void;
}

interface LaneState {
	sha: string;
	colorIdx: number;
}

interface GraphRow {
	commit: CommitInfo;
	lane: number;
	colorIdx: number;
	topLanes: (LaneState | null)[];
	botLanes: (LaneState | null)[];
	convergingLanes: number[];
	hiddenMergeParentCount: number;
}

interface GraphLayout {
	rows: GraphRow[];
	maxLanes: number;
	earlierHistoryLanes: HistoryLane[];
}

interface HistoryLane extends LaneState {
	lane: number;
}

type ParsedRef =
	| { kind: "headBranch"; name: string }
	| { kind: "head" }
	| { kind: "tag"; name: string }
	| { kind: "remote"; name: string }
	| { kind: "branch"; name: string };

const ROW_H = 28;
const LANE_W = 18;
const DOT_R = 6;
const DOT_R_SELECTED = 8;
const LINE_W = 2.5;
const HALF_ROW_H = ROW_H / 2;
const HALF_LANE_W = LANE_W / 2;
const COLORS = [
	"var(--vscode-charts-blue)",
	"var(--vscode-charts-purple)",
	"var(--vscode-charts-green)",
	"var(--vscode-charts-yellow)",
	"var(--vscode-charts-orange)",
];

function cloneLanes(lanes: (LaneState | null)[]): (LaneState | null)[] {
	return lanes.map((lane) => (lane ? { ...lane } : null));
}

function compactTrailingEmptyLanes(lanes: (LaneState | null)[]): void {
	while (lanes.length > 0 && lanes.at(-1) === null) {
		lanes.pop();
	}
}

function claimLane(
	activeLanes: (LaneState | null)[],
	state: LaneState,
): number {
	const openLane = activeLanes.indexOf(null);
	if (openLane !== -1) {
		activeLanes[openLane] = state;
		return openLane;
	}
	activeLanes.push(state);
	return activeLanes.length - 1;
}

function graphRowForCommit(
	commit: CommitInfo,
	activeLanes: (LaneState | null)[],
	visibleShas: Set<string>,
	nextColorIdx: number,
): { row: GraphRow; nextColorIdx: number } {
	let colorCursor = nextColorIdx;
	let lane = activeLanes.findIndex(
		(candidate) => candidate?.sha === commit.hash,
	);
	let laneState: LaneState;
	let hasNewerVisibleChild = true;
	if (lane === -1) {
		laneState = { sha: commit.hash, colorIdx: colorCursor };
		colorCursor++;
		lane = claimLane(activeLanes, laneState);
		hasNewerVisibleChild = false;
	} else {
		const existing = activeLanes[lane];
		if (!existing) {
			throw new Error(`Graph lane ${lane} disappeared.`);
		}
		laneState = existing;
	}
	const convergingLanes = activeLanes
		.map((candidate, candidateLane) =>
			candidateLane !== lane && candidate?.sha === commit.hash
				? candidateLane
				: -1,
		)
		.filter((candidateLane) => candidateLane !== -1);
	const topLanes = cloneLanes(activeLanes);
	if (!hasNewerVisibleChild) {
		topLanes[lane] = null;
	}
	const primaryParent =
		commit.parents[0] && visibleShas.has(commit.parents[0])
			? commit.parents[0]
			: null;
	activeLanes[lane] = primaryParent
		? { sha: primaryParent, colorIdx: laneState.colorIdx }
		: null;
	for (const convergingLane of convergingLanes) {
		activeLanes[convergingLane] = null;
	}
	let hiddenMergeParentCount = 0;
	for (const mergeParent of commit.parents.slice(1)) {
		if (!visibleShas.has(mergeParent)) {
			hiddenMergeParentCount++;
		} else if (
			!activeLanes.some((candidate) => candidate?.sha === mergeParent)
		) {
			claimLane(activeLanes, {
				sha: mergeParent,
				colorIdx: colorCursor,
			});
			colorCursor++;
		}
	}
	compactTrailingEmptyLanes(activeLanes);
	const botLanes = cloneLanes(activeLanes);
	return {
		row: {
			commit,
			lane,
			colorIdx: laneState.colorIdx,
			topLanes,
			botLanes,
			convergingLanes,
			hiddenMergeParentCount,
		},
		nextColorIdx: colorCursor,
	};
}

function assignGraphRows(commits: CommitInfo[]): GraphLayout {
	// Git owns commit order and parent topology. The renderer walks that fixed
	// stream newest-to-oldest only to assign x-coordinates needed by SVG; it
	// must not sort, de-duplicate, or otherwise reinterpret Git's history.
	const visibleShas = new Set(commits.map((commit) => commit.hash));
	const activeLanes: (LaneState | null)[] = [];
	const rows: GraphRow[] = [];
	let nextColorIdx = 0;
	let maxLanes = 1;

	for (let index = commits.length - 1; index >= 0; index--) {
		const commit = commits[index];
		if (!commit) {
			throw new Error(`Missing commit at graph index ${index}.`);
		}
		const result = graphRowForCommit(
			commit,
			activeLanes,
			visibleShas,
			nextColorIdx,
		);
		nextColorIdx = result.nextColorIdx;
		rows.push(result.row);
		maxLanes = Math.max(
			maxLanes,
			result.row.lane + 1,
			result.row.topLanes.length,
			result.row.botLanes.length,
			result.row.hiddenMergeParentCount > 0 ? result.row.lane + 2 : 1,
		);
	}

	const earlierHistoryLanes: HistoryLane[] = [];
	const seenHistoryLanes = new Set<number>();
	for (const row of rows) {
		if (
			row.commit.parents.some((parent) => !visibleShas.has(parent)) &&
			!seenHistoryLanes.has(row.lane)
		) {
			seenHistoryLanes.add(row.lane);
			earlierHistoryLanes.push({
				sha: row.commit.hash,
				colorIdx: row.colorIdx,
				lane: row.lane,
			});
		}
	}
	return { rows, maxLanes, earlierHistoryLanes };
}

function laneX(lane: number): number {
	return lane * LANE_W + HALF_LANE_W;
}

function laneColor(colorIdx: number): string {
	const color = COLORS[colorIdx % COLORS.length];
	if (!color) {
		throw new Error(`Missing graph lane color for index ${colorIdx}.`);
	}
	return color;
}

function curvePath(x1: number, y1: number, x2: number, y2: number): string {
	const midY = (y1 + y2) / 2;
	return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function linePath(x1: number, y1: number, x2: number, y2: number): string {
	return `M ${x1} ${y1} L ${x2} ${y2}`;
}

function pathElement(key: string, d: string, colorIdx: number): ReactElement {
	return <path key={key} d={d} stroke={laneColor(colorIdx)} />;
}

function renderCommitLanePaths(
	row: GraphRow,
	top: LaneState | null,
	bot: LaneState | null,
	nodeRadius: number,
): ReactElement[] {
	const paths: ReactElement[] = [];
	const x = laneX(row.lane);
	if (top) {
		const endY = bot ? HALF_ROW_H : HALF_ROW_H - nodeRadius;
		paths.push(
			pathElement(
				`${row.lane}:top`,
				linePath(x, 0, x, endY),
				top.colorIdx,
			),
		);
	}
	if (bot) {
		const startY = top ? HALF_ROW_H : HALF_ROW_H + nodeRadius;
		paths.push(
			pathElement(
				`${row.lane}:bot`,
				linePath(x, startY, x, ROW_H),
				bot.colorIdx,
			),
		);
	}
	return paths;
}

function renderSideLanePath(
	row: GraphRow,
	lane: number,
	top: LaneState | null,
	bot: LaneState | null,
): ReactElement | null {
	const x = laneX(lane);
	const commitX = laneX(row.lane);
	if (row.convergingLanes.includes(lane) && top) {
		return pathElement(
			`${lane}:converge`,
			curvePath(x, 0, commitX, HALF_ROW_H),
			top.colorIdx,
		);
	}
	if (!top && bot) {
		return pathElement(
			`${lane}:start`,
			curvePath(commitX, HALF_ROW_H, x, ROW_H),
			bot.colorIdx,
		);
	}
	if (top && !bot) {
		return pathElement(
			`${lane}:end`,
			linePath(x, 0, x, HALF_ROW_H),
			top.colorIdx,
		);
	}
	if (top && bot) {
		return pathElement(
			`${lane}:through`,
			linePath(x, 0, x, ROW_H),
			top.colorIdx,
		);
	}
	return null;
}

function renderLanePaths(row: GraphRow, nodeRadius: number): ReactElement[] {
	const maxLane = Math.max(
		row.topLanes.length,
		row.botLanes.length,
		row.lane + 1,
	);
	const paths: ReactElement[] = [];
	for (let lane = 0; lane < maxLane; lane++) {
		const top = row.topLanes[lane] ?? null;
		const bot = row.botLanes[lane] ?? null;
		if (lane === row.lane) {
			paths.push(...renderCommitLanePaths(row, top, bot, nodeRadius));
		} else {
			const sidePath = renderSideLanePath(row, lane, top, bot);
			if (sidePath) {
				paths.push(sidePath);
			}
		}
	}
	return paths;
}

function renderHiddenMergeParentPaths(row: GraphRow): ReactElement[] {
	if (row.hiddenMergeParentCount === 0) {
		return [];
	}
	const x = laneX(row.lane);
	const hiddenLaneX = x + LANE_W;
	return [
		<path
			key="hidden-merge-parent"
			d={curvePath(x, HALF_ROW_H, hiddenLaneX, ROW_H)}
			stroke={laneColor(row.colorIdx)}
			strokeDasharray="3 4"
			opacity="0.65"
		/>,
	];
}

function parseRef(raw: string): ParsedRef {
	if (raw.startsWith("HEAD -> ")) {
		return { kind: "headBranch", name: raw.slice(8) };
	}
	if (raw === "HEAD") {
		return { kind: "head" };
	}
	if (raw.startsWith("tag: ")) {
		return { kind: "tag", name: raw.slice(5) };
	}
	if (raw.includes("/")) {
		return { kind: "remote", name: raw };
	}
	return { kind: "branch", name: raw };
}

function badgeForRef(rawRef: string): ReactElement[] {
	const parsed = parseRef(rawRef);
	switch (parsed.kind) {
		case "headBranch":
			return [
				<span
					key={`${rawRef}:head`}
					className="commit-badge commit-badge--head"
				>
					HEAD
				</span>,
				<span
					key={`${rawRef}:branch`}
					className="commit-badge commit-badge--branch"
				>
					{parsed.name}
				</span>,
			];
		case "head":
			return [
				<span key={rawRef} className="commit-badge commit-badge--head">
					HEAD
				</span>,
			];
		case "tag":
			return [
				<span key={rawRef} className="commit-badge commit-badge--tag">
					{parsed.name}
				</span>,
			];
		case "remote":
			return [
				<span
					key={rawRef}
					className="commit-badge commit-badge--remote"
				>
					{parsed.name}
				</span>,
			];
		case "branch":
			return [
				<span
					key={rawRef}
					className="commit-badge commit-badge--branch"
				>
					{parsed.name}
				</span>,
			];
		default:
			throw new Error(`Unhandled Git ref decoration: ${rawRef}`);
	}
}

function refBadges(commit: CommitInfo): ReactElement[] {
	return commit.refs.flatMap((rawRef) => badgeForRef(rawRef));
}

function roleBadges(commit: CommitInfo, props: GitGraphProps): ReactElement[] {
	const badges: ReactElement[] = [];
	if (commit.hash === props.baseSha) {
		badges.push(
			<span key="base" className="commit-badge commit-badge--role">
				Base
			</span>,
		);
	}
	if (commit.hash === props.localSha) {
		badges.push(
			<span key="local" className="commit-badge commit-badge--role">
				Local
			</span>,
		);
	}
	if (commit.hash === props.remoteSha) {
		badges.push(
			<span key="remote" className="commit-badge commit-badge--role">
				Remote
			</span>,
		);
	}
	return badges;
}

const GraphRowView: FC<{
	row: GraphRow;
	props: GitGraphProps;
	svgWidth: number;
}> = ({ row, props, svgWidth }): ReactElement => {
	const selected = row.commit.hash === props.selectedSha;
	const nodeRadius = selected ? DOT_R_SELECTED : DOT_R;
	return (
		<button
			type="button"
			className={`commit-row${selected ? " commit-row--selected" : ""}`}
			data-sha={row.commit.hash}
			onClick={() => props.onSelect(row.commit.hash)}
		>
			<svg
				className="commit-row__graph"
				width={svgWidth}
				height={ROW_H}
				viewBox={`0 0 ${svgWidth} ${ROW_H}`}
				aria-hidden="true"
				overflow="visible"
			>
				<g
					fill="none"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={LINE_W}
				>
					{renderLanePaths(row, nodeRadius)}
					{renderHiddenMergeParentPaths(row)}
				</g>
				<circle
					cx={laneX(row.lane)}
					cy={HALF_ROW_H}
					r={nodeRadius}
					fill={laneColor(row.colorIdx)}
					stroke={
						selected ? "var(--vscode-focusBorder)" : "transparent"
					}
					strokeWidth={selected ? 2 : 0}
				/>
			</svg>
			<span className="commit-row__content">
				<span className="commit-row__summary">
					<span className="commit-row__hash">
						{row.commit.shortHash}
					</span>
					<span className="commit-row__subject">
						{row.commit.subject}
					</span>
				</span>
				<span className="commit-row__refs">
					{refBadges(row.commit)}
				</span>
				<span className="commit-row__roles">
					{roleBadges(row.commit, props)}
				</span>
			</span>
		</button>
	);
};

const EarlierHistoryRow: FC<{
	lanes: HistoryLane[];
	svgWidth: number;
}> = ({ lanes, svgWidth }): ReactElement => (
	<div className="commit-row commit-row--sentinel">
		<svg
			className="commit-row__graph"
			width={svgWidth}
			height={ROW_H}
			viewBox={`0 0 ${svgWidth} ${ROW_H}`}
			aria-hidden="true"
		>
			<g
				fill="none"
				strokeDasharray="3 4"
				strokeLinecap="round"
				strokeWidth={LINE_W}
			>
				{lanes.map((lane) => (
					<path
						key={lane.sha}
						d={linePath(
							laneX(lane.lane),
							0,
							laneX(lane.lane),
							ROW_H,
						)}
						stroke={laneColor(lane.colorIdx)}
						opacity="0.5"
					/>
				))}
			</g>
		</svg>
		<span className="commit-row__content muted">Earlier history...</span>
	</div>
);

export const GitGraph: FC<GitGraphProps> = (props): ReactElement => {
	const containerRef = useRef<HTMLDivElement>(null);
	const layout = useMemo(
		() => assignGraphRows(props.commits),
		[props.commits],
	);
	const svgWidth = layout.maxLanes * LANE_W + HALF_LANE_W;
	useLayoutEffect(() => {
		const selectedRow = containerRef.current?.querySelector(
			`[data-sha="${props.selectedSha}"]`,
		);
		selectedRow?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [props.selectedSha]);
	if (props.commits.length === 0) {
		return <div className="submodule-empty">No history available.</div>;
	}
	return (
		<div className="submodule-graph" ref={containerRef}>
			<div className="commit-list">
				{layout.rows.map((row) => (
					<GraphRowView
						key={row.commit.hash}
						row={row}
						props={props}
						svgWidth={svgWidth}
					/>
				))}
				{layout.earlierHistoryLanes.length > 0 ? (
					<EarlierHistoryRow
						lanes={layout.earlierHistoryLanes}
						svgWidth={svgWidth}
					/>
				) : null}
			</div>
		</div>
	);
};
