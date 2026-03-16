import { type FC, Fragment } from "react";
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
const getDiffStateInternal = (idx: number, ui: MeldUIState): DiffState => {
	const isLBC = ui.baseCompareHighlighting && Boolean(ui.files[0]);
	const isRBC = ui.baseCompareHighlighting && Boolean(ui.files[4]);

	if (idx === 0 && ui.files[1]) {
		return {
			dFC: ui.diffs[0] || ui.prevBaseLeftDiffs,
			lEIdx: 0,
			rEIdx: 1,
			fOL: false,
			fOR: !isLBC,
		};
	}
	if (idx === 1 && ui.files[2]) {
		return { dFC: ui.diffs[1], lEIdx: 1, rEIdx: 2, fOL: isLBC, fOR: false };
	}
	if (idx === 2 && ui.files[3]) {
		return { dFC: ui.diffs[2], lEIdx: 2, rEIdx: 3, fOL: false, fOR: isRBC };
	}
	if (idx === 3 && (ui.files[4] || ui.renderBaseRight)) {
		return {
			dFC: ui.diffs[3] || ui.prevBaseRightDiffs,
			lEIdx: 3,
			rEIdx: 4,
			fOL: !isRBC,
			fOR: false,
		};
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

export const MeldPane: FC<MeldPaneProps> = (p) => {
	const { idx, ui } = p;
	const active =
		ui.files[idx] ||
		(idx === 0 ? ui.prevBaseLeft : idx === 4 ? ui.prevBaseRight : null);
	if (!active) {
		return null;
	}

	const diffState = getDiffStateInternal(p.idx, p.ui);
	const { dFC, lEIdx, rEIdx, fOL, fOR } = diffState;

	const lEd = p.ui.editorRefArray.current[lEIdx];
	const rEd = p.ui.editorRefArray.current[rEIdx];
	const curtain = dFC && lEd && rEd && lEd.getModel() && rEd.getModel() && (
		<DiffCurtain
			diffs={dFC}
			leftEditor={lEd}
			rightEditor={rEd}
			renderTrigger={p.ui.renderTrigger}
			reversed={p.idx === 1}
			fadeOutLeft={fOL}
			fadeOutRight={fOR}
			{...getCurtainHandlers(p.actions, p.idx)}
		/>
	);

	const peerCount = [0, 1, 2, 3, 4]
		.filter((i) => i !== idx)
		.filter((i) => {
			if (i === 1 || i === 2 || i === 3) {
				return Boolean(ui.files[i]);
			}
			if (i === 0) {
				return ui.renderBaseLeft;
			}
			if (i === 4) {
				return ui.renderBaseRight;
			}
			return false;
		}).length;

	const totalPanes = peerCount + 1;

	const codePane = renderMeldCodePane(p.idx, active, p.ui, p.actions);

	if (p.idx === 0 || p.idx === 4) {
		const side = p.idx === 0 ? "left" : "right";
		const isOpen = Boolean(p.ui.files[p.idx]);
		return (
			<Fragment key={p.idx}>
				<AnimatedColumn
					isOpen={isOpen}
					side={side}
					textColumns={totalPanes}
					textColumnsAfterAnimation={totalPanes}
					id={`col-base-${side}`}
				>
					{codePane}
				</AnimatedColumn>
				{p.idx === 0
					? (p.ui.files[0] || p.ui.renderBaseLeft) && curtain
					: curtain}
			</Fragment>
		);
	}

	return (
		<Fragment key={p.idx}>
			{codePane}
			{curtain}
		</Fragment>
	);
};
