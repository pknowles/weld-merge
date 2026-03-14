import { editor } from "monaco-editor";
import React from "react";
import { mapLineAcrossPanes } from "./scrollMapping.ts";
import type { DiffChunk } from "./types.ts";

interface SyncOptions {
	otherEditor: editor.IStandaloneCodeEditor;
	targetIdx: number;
	sourceIndex: number;
	sourceLineDecimal: number;
	paneCounts: [number, number, number, number, number];
	syncpoint: number;
	targetIndices?: number[] | undefined;
	diffs: (DiffChunk[] | null)[];
	diffsAreReversed: boolean[];
	smoothScrolling: boolean;
}

function getSyncPointY(
	scrollTop: number,
	pageSize: number,
	scrollHeight: number,
) {
	const halfPage = pageSize / 2;
	let syncpoint = 0.0;
	const firstScale = Math.min(1, Math.max(0, scrollTop / halfPage));
	syncpoint += 0.5 * firstScale;
	const bottomVal = Math.max(0, scrollHeight - 1.5 * pageSize);
	const lastScale = Math.min(
		1,
		Math.max(0, (scrollTop - bottomVal) / halfPage),
	);
	syncpoint += 0.5 * lastScale;
	return { syncpoint, syncY: scrollTop + pageSize * syncpoint };
}

function getSourceLineDecimal(
	sourceEd: editor.IStandaloneCodeEditor,
	syncY: number,
) {
	const sourceModel = sourceEd.getModel();
	const sourceLineCount = sourceModel ? sourceModel.getLineCount() : 1;
	let intSourceLine = 1;
	let low = 1;
	let high = sourceLineCount;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const midTop = sourceEd.getTopForLineNumber(mid);
		if (midTop <= syncY) {
			intSourceLine = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	const fallbackLineHeight = sourceEd.getOption(
		editor.EditorOption.lineHeight,
	);
	const baseSourcePx = sourceEd.getTopForLineNumber(intSourceLine);
	const nextSourcePx =
		intSourceLine < sourceLineCount
			? sourceEd.getTopForLineNumber(intSourceLine + 1)
			: baseSourcePx + fallbackLineHeight;
	const sourceHeight = nextSourcePx - baseSourcePx || fallbackLineHeight;
	return intSourceLine - 1 + (syncY - baseSourcePx) / sourceHeight;
}

function syncHorizontalScroll(
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
	sourceIndex: number,
	scrollLeft: number,
	targetIndices?: number[],
) {
	editorRefs.current.forEach((otherEditor, targetIdx) => {
		if (targetIdx !== sourceIndex && otherEditor) {
			if (targetIndices && !targetIndices.includes(targetIdx)) {
				return;
			}
			if (Math.abs(otherEditor.getScrollLeft() - scrollLeft) > 2) {
				otherEditor.setScrollLeft(scrollLeft);
			}
		}
	});
}

function syncScrollToTarget(opts: SyncOptions) {
	const {
		otherEditor,
		targetIdx,
		sourceIndex,
		sourceLineDecimal,
		paneCounts,
		syncpoint,
		targetIndices,
		diffs,
		diffsAreReversed,
		smoothScrolling,
	} = opts;
	if (targetIdx === sourceIndex || targetIdx >= 5) {
		return;
	}
	if (targetIndices && !targetIndices.includes(targetIdx)) {
		return;
	}

	const targetLineDecimal = mapLineAcrossPanes(
		sourceLineDecimal,
		sourceIndex,
		targetIdx,
		{
			diffs,
			paneLineCounts: paneCounts,
			smooth: smoothScrolling,
			diffIsReversed: diffsAreReversed,
		},
	);

	const intTargetLine = Math.floor(targetLineDecimal) + 1;
	const targetFraction = targetLineDecimal - Math.floor(targetLineDecimal);
	const targetMax = paneCounts[targetIdx as 0 | 1 | 2 | 3 | 4];

	let targetSyncY: number;
	if (intTargetLine >= targetMax) {
		const lastTop = otherEditor.getTopForLineNumber(targetMax);
		const targetHeight = otherEditor.getOption(
			editor.EditorOption.lineHeight,
		);
		targetSyncY = lastTop + targetFraction * targetHeight;
	} else {
		const targetBasePx = otherEditor.getTopForLineNumber(intTargetLine);
		const targetNextPx = otherEditor.getTopForLineNumber(intTargetLine + 1);
		targetSyncY =
			targetBasePx + targetFraction * (targetNextPx - targetBasePx);
	}

	const layoutInfo = otherEditor.getLayoutInfo();
	const targetScrollTop = targetSyncY - layoutInfo.height * syncpoint;
	if (Math.abs(otherEditor.getScrollTop() - targetScrollTop) > 2) {
		otherEditor.setScrollTop(targetScrollTop);
	}
}

const getPaneCounts = (
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
): [number, number, number, number, number] | null => {
	const counts: number[] = [];
	for (let i = 0; i < 5; i++) {
		const model = editorRefs.current[i]?.getModel();
		if (!model) {
			if (i === 1 || i === 2 || i === 3) {
				return null;
			}
			counts.push(0);
			continue;
		}
		counts.push(model.getLineCount());
	}
	return counts as [number, number, number, number, number];
};

interface VerticalSyncContext {
	sourceEd: editor.IStandaloneCodeEditor;
	sourceIndex: number;
	scrollTop: number;
	paneCounts: [number, number, number, number, number];
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>;
	diffsRef: React.MutableRefObject<(DiffChunk[] | null)[]>;
	diffsAreReversedRef: React.MutableRefObject<boolean[]>;
	smoothScrolling: boolean;
	targetIndices?: number[] | undefined;
}

function syncVerticalScroll(ctx: VerticalSyncContext) {
	const {
		sourceEd,
		sourceIndex,
		scrollTop,
		paneCounts,
		editorRefs,
		diffsRef,
		diffsAreReversedRef,
		smoothScrolling,
		targetIndices,
	} = ctx;
	const { height } = sourceEd.getLayoutInfo();
	const { syncpoint, syncY } = getSyncPointY(
		scrollTop,
		height,
		sourceEd.getContentHeight(),
	);
	const sourceLineDec = getSourceLineDecimal(sourceEd, syncY);

	for (let tIdx = 0; tIdx < editorRefs.current.length; tIdx++) {
		const ed = editorRefs.current[tIdx];
		if (ed) {
			syncScrollToTarget({
				otherEditor: ed,
				targetIdx: tIdx,
				sourceIndex,
				sourceLineDecimal: sourceLineDec,
				paneCounts,
				syncpoint,
				targetIndices,
				diffs: diffsRef.current,
				diffsAreReversed: diffsAreReversedRef.current,
				smoothScrolling,
			});
		}
	}
}

const useSynchronizedScrolling = (
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
	diffsRef: React.MutableRefObject<(DiffChunk[] | null)[]>,
	diffsAreReversedRef: React.MutableRefObject<boolean[]>,
	setRenderTrigger: React.Dispatch<React.SetStateAction<number>>,
	smoothScrolling: boolean,
) => {
	const scrollLockRef = React.useRef<boolean>(false);
	const requestFrameRef = React.useRef<number | null>(null);

	const syncEditors = React.useCallback(
		(
			sourceEd: editor.IStandaloneCodeEditor,
			sourceIndex: number,
			scrollTop: number,
			scrollLeft: number | undefined,
			targetIndices?: number[],
		) => {
			if (scrollLockRef.current) {
				return;
			}
			scrollLockRef.current = true;
			try {
				if (scrollTop !== undefined) {
					const paneCounts = getPaneCounts(editorRefs);
					if (paneCounts) {
						syncVerticalScroll({
							sourceEd,
							sourceIndex,
							scrollTop,
							paneCounts,
							editorRefs,
							diffsRef,
							diffsAreReversedRef,
							smoothScrolling,
							targetIndices,
						});
					}
				}
				if (scrollLeft !== undefined) {
					syncHorizontalScroll(
						editorRefs,
						sourceIndex,
						scrollLeft,
						targetIndices,
					);
				}
			} finally {
				if (requestFrameRef.current !== null) {
					cancelAnimationFrame(requestFrameRef.current);
				}
				requestFrameRef.current = requestAnimationFrame(() => {
					scrollLockRef.current = false;
					requestFrameRef.current = null;
				});
			}
		},
		[editorRefs, diffsRef, diffsAreReversedRef, smoothScrolling],
	);

	const attachScrollListener = React.useCallback(
		(ed: editor.IStandaloneCodeEditor, edIndex: number) =>
			ed.onDidScrollChange((e) => {
				if (scrollLockRef.current) {
					return;
				}
				setRenderTrigger((prev) => prev + 1);
				if (e.scrollTopChanged || e.scrollLeftChanged) {
					syncEditors(
						ed,
						edIndex,
						e.scrollTopChanged ? e.scrollTop : ed.getScrollTop(),
						e.scrollLeftChanged ? e.scrollLeft : ed.getScrollLeft(),
					);
				}
			}),
		[setRenderTrigger, syncEditors],
	);

	const forceSyncToPane = React.useCallback(
		(sourceIndex: number, targetIndex: number) => {
			const sourceEd = editorRefs.current[sourceIndex];
			if (sourceEd && editorRefs.current[targetIndex]) {
				syncEditors(
					sourceEd,
					sourceIndex,
					sourceEd.getScrollTop(),
					sourceEd.getScrollLeft(),
					[targetIndex],
				);
			}
		},
		[editorRefs, syncEditors],
	);

	return { attachScrollListener, forceSyncToPane };
};

export { useSynchronizedScrolling };
