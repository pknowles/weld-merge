import React, { type FC, Fragment } from "react";
import { AnimatedColumn } from "./animatedColumn.tsx";
import { CodePane } from "./CodePane.tsx";
import { DiffCurtain } from "./DiffCurtain.tsx";
import type {
	MeldPaneProps,
	MeldUIActions,
	MeldUIState,
} from "./meldPaneTypes.ts";
import { INITIAL_SYNC_DELAY } from "./meldPaneTypes.ts";
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
interface DiffState {
	dFC: DiffChunk[] | null;
	lEIdx: number;
	rEIdx: number;
	fOL: boolean;
	fOR: boolean;
}

const getBridge01 = (ui: MeldUIState): DiffState | null => {
	if (!(ui.files[0] || ui.renderBaseLeft)) {
		return null;
	}
	const fade = !ui.files[0];
	return {
		dFC: ui.diffs[0] || ui.prevBaseLeftDiffs,
		lEIdx: 0,
		rEIdx: 1,
		fOL: fade,
		fOR: false,
	};
};

const getBridge34 = (ui: MeldUIState): DiffState | null => {
	if (!(ui.files[4] || ui.renderBaseRight)) {
		return null;
	}
	const fade = !ui.files[4];
	return {
		dFC: ui.diffs[3] || ui.prevBaseRightDiffs,
		lEIdx: 3,
		rEIdx: 4,
		fOL: false,
		fOR: fade,
	};
};

const getDiffStateInternal = (idx: number, ui: MeldUIState): DiffState => {
	// Base Compare highlighting state
	const isLBC = ui.baseCompareHighlighting && Boolean(ui.files[0]);
	const isRBC = ui.baseCompareHighlighting && Boolean(ui.files[4]);

	if (idx === 0) {
		const b = getBridge01(ui);
		if (b) {
			return b;
		}
	}
	if (idx === 1 && ui.files[2]) {
		return { dFC: ui.diffs[1], lEIdx: 1, rEIdx: 2, fOL: isLBC, fOR: false };
	}
	if (idx === 2 && ui.files[3]) {
		return { dFC: ui.diffs[2], lEIdx: 2, rEIdx: 3, fOL: false, fOR: isRBC };
	}
	if (idx === 3) {
		const b = getBridge34(ui);
		if (b) {
			return b;
		}
	}
	return { dFC: null, lEIdx: 0, rEIdx: 0, fOL: false, fOR: false };
};

const renderMeldCodePane = (
	idx: number,
	active: FileState,
	ui: MeldUIState,
	actions: MeldUIActions,
) => (
	<CodePane
		file={active}
		index={idx}
		ui={ui}
		actions={actions}
		isMiddle={idx === 2}
		highlights={actions.getHighlights(idx)}
		onToggleBase={
			idx === 1
				? () => actions.toggleBaseDiff("left")
				: idx === 3
					? () => actions.toggleBaseDiff("right")
					: undefined
		}
		baseSide={idx === 1 ? "left" : idx === 3 ? "right" : undefined}
		isBaseActive={Boolean(ui.files[idx === 1 ? 0 : 4])}
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
);

const getPeerCount = (idx: number, ui: MeldUIState) =>
	[0, 1, 2, 3, 4]
		.filter((i) => i !== idx)
		.filter((i) => {
			if (i === 1 || i === 2 || i === 3) {
				return Boolean(ui.files[i]);
			}
			if (i === 0) {
				return Boolean(ui.files[0] || ui.renderBaseLeft);
			}
			if (i === 4) {
				return Boolean(ui.files[4] || ui.renderBaseRight);
			}
			return false;
		}).length;

const renderCurtain = (
	idx: number,
	ui: MeldUIState,
	actions: MeldUIActions,
	diffState: DiffState,
) => {
	const { dFC, lEIdx, rEIdx, fOL, fOR } = diffState;
	const lEd = ui.editorRefArray.current[lEIdx];
	const rEd = ui.editorRefArray.current[rEIdx];
	return (
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
};

const renderBasePane = (args: {
	idx: number;
	ui: MeldUIState;
	peerCount: number;
	codePane: React.ReactNode;
	curtain: React.ReactNode;
}) => {
	const { idx, ui, peerCount, codePane, curtain } = args;
	const side = idx === 0 ? "left" : "right";
	const isOpen = Boolean(ui.files[idx]);
	return (
		<Fragment key={idx}>
			<AnimatedColumn
				isOpen={isOpen}
				side={side}
				textColumns={peerCount}
				textColumnsAfterAnimation={peerCount}
				id={`col-base-${side}`}
			>
				{codePane}
			</AnimatedColumn>
			{idx === 0 && (ui.files[0] || ui.renderBaseLeft) && curtain}
		</Fragment>
	);
};

export const MeldPane: FC<MeldPaneProps> = (p) => {
	const { idx, ui } = p;

	const active =
		ui.files[idx] ||
		(idx === 0 ? ui.prevBaseLeft : idx === 4 ? ui.prevBaseRight : null);

	if (!active) {
		return null;
	}

	const diffState = getDiffStateInternal(p.idx, p.ui);
	const curtain = renderCurtain(idx, ui, p.actions, diffState);

	const peerCount = getPeerCount(idx, ui);
	const codePane = renderMeldCodePane(p.idx, active, p.ui, p.actions);

	if (p.idx === 0 || p.idx === 4) {
		const isVisible =
			p.idx === 0
				? p.ui.files[0] || p.ui.renderBaseLeft
				: p.ui.files[4] || p.ui.renderBaseRight;

		if (!isVisible) {
			return null;
		}

		return renderBasePane({
			idx,
			ui,
			peerCount,
			codePane,
			curtain,
		});
	}

	return (
		<Fragment key={p.idx}>
			{codePane}
			{(p.idx !== 3 || ui.files[4] || ui.renderBaseRight) && curtain}
		</Fragment>
	);
};
