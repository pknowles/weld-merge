import { type FC, Fragment } from "react";
import { AnimatedColumn } from "./animatedColumn.tsx";
import { CodePane } from "./CodePane.tsx";
import { DiffCurtain } from "./DiffCurtain.tsx";
import {
	INITIAL_SYNC_DELAY,
	type MeldPaneProps,
	type MeldUIActions,
	type MeldUIState,
} from "./meldPaneTypes.ts";
import type { DiffChunk, FileState } from "./types.ts";

const getCurtainHandlers = (actions: MeldUIActions, idx: number) => {
	if (idx !== 1 && idx !== 2) {
		return {};
	}
	const targetIdx = idx === 1 ? 1 : 3;
	return {
		onApplyChunk: (c: DiffChunk) => actions.handleApplyChunk(targetIdx, c),
		onDeleteChunk: (c: DiffChunk) => actions.handleDeleteChunk(idx, c),
		onCopyUpChunk: (c: DiffChunk) =>
			actions.handleCopyUpChunk(targetIdx, c),
		onCopyDownChunk: (c: DiffChunk) =>
			actions.handleCopyDownChunk(targetIdx, c),
	};
};

const PaneAndCurtain: FC<
	MeldPaneProps & {
		active: FileState;
		dFC: DiffChunk[] | null;
		lEIdx: number;
		rEIdx: number;
		fOL: boolean;
		fOR: boolean;
	}
> = (props) => {
	const { idx, ui, actions, active, dFC, lEIdx, rEIdx, fOL, fOR } = props;
	const isBaseActive = Boolean(ui.files[idx === 1 ? 0 : 4]);
	const baseSide = idx === 1 ? "left" : idx === 3 ? "right" : undefined;
	const onToggleBase =
		idx === 1
			? () => actions.toggleBaseDiff("left")
			: idx === 3
				? () => actions.toggleBaseDiff("right")
				: undefined;

	const lEd = ui.editorRefArray.current[lEIdx];
	const rEd = ui.editorRefArray.current[rEIdx];
	const curtain = dFC && lEd && rEd && lEd.getModel() && rEd.getModel() && (
		<DiffCurtain
			diffs={dFC}
			leftEditor={lEd}
			rightEditor={rEd}
			renderTrigger={ui.renderTrigger}
			reversed={idx === 1}
			fadeOutLeft={fOL}
			fadeOutRight={fOR}
			{...getCurtainHandlers(actions, idx)}
		/>
	);

	return (
		<>
			<CodePane
				file={active}
				index={idx}
				ui={ui}
				actions={actions}
				isMiddle={idx === 2}
				highlights={actions.getHighlights(idx)}
				onToggleBase={onToggleBase}
				baseSide={baseSide}
				isBaseActive={isBaseActive}
				onMount={(ed, i) => {
					ui.editorRefArray.current[i] = ed;
					actions.attachScrollListener(ed, i);
					const delay = i === 0 || i === 4 ? INITIAL_SYNC_DELAY : 0;
					if (delay > 0) {
						setTimeout(() => {
							actions.forceSyncToPane(i === 0 ? 1 : 3, i);
						}, delay);
					}
				}}
			/>
			{curtain}
		</>
	);
};

interface DiffState {
	dFC: DiffChunk[] | null;
	lEIdx: number;
	rEIdx: number;
	fOL: boolean;
	fOR: boolean;
}

const getDiffStateForBase = (
	idx: number,
	ui: MeldUIState,
	isLBC: boolean,
	isRBC: boolean,
): DiffState => {
	if (idx === 0) {
		return {
			dFC: ui.diffs[0] || ui.prevBaseLeftDiffs,
			lEIdx: 0,
			rEIdx: 1,
			fOL: false,
			fOR: !isLBC,
		};
	}
	return {
		dFC: ui.diffs[3] || ui.prevBaseRightDiffs,
		lEIdx: 3,
		rEIdx: 4,
		fOL: !isRBC,
		fOR: false,
	};
};

const getDiffStateInternal = (idx: number, ui: MeldUIState): DiffState => {
	const isLBC = ui.baseCompareHighlighting && Boolean(ui.files[0]);
	const isRBC = ui.baseCompareHighlighting && Boolean(ui.files[4]);
	if (idx === 0 || idx === 3) {
		return getDiffStateForBase(idx, ui, isLBC, isRBC);
	}
	if (idx === 1) {
		return { dFC: ui.diffs[1], lEIdx: 1, rEIdx: 2, fOL: isLBC, fOR: false };
	}
	return { dFC: ui.diffs[2], lEIdx: 2, rEIdx: 3, fOL: false, fOR: isRBC };
};

export const MeldPane: FC<MeldPaneProps> = (p) => {
	const { idx, ui } = p;
	const active =
		ui.files[idx] ||
		(idx === 0 ? ui.prevBaseLeft : idx === 4 ? ui.prevBaseRight : null);
	if (!active) {
		return null;
	}

	const content = (
		<PaneAndCurtain
			{...p}
			active={active}
			{...getDiffStateInternal(idx, ui)}
		/>
	);

	if (idx === 0 || idx === 4) {
		const side = idx === 0 ? "left" : "right";
		return (
			<AnimatedColumn
				key={idx}
				isOpen={Boolean(ui.files[idx])}
				side={side}
				textColumns={3}
				textColumnsAfterAnimation={3}
				id={`col-base-${side}`}
			>
				{content}
			</AnimatedColumn>
		);
	}
	return <Fragment key={idx}>{content}</Fragment>;
};
