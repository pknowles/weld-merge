import { editor } from "monaco-editor";
import React from "react";
import { mapLineAcrossPanes } from "./scrollMapping.ts";
import type { DiffChunk } from "./types.ts";

export const useSynchronizedScrolling = (
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
	diffsRef: React.MutableRefObject<(DiffChunk[] | null)[]>,
	diffsAreReversedRef: React.MutableRefObject<boolean[]>,
	setRenderTrigger: React.Dispatch<React.SetStateAction<number>>,
	smoothScrolling: boolean,
) => {
	// Replacing `syncingFrom` with a scroll lock that discards re-entrant events entirely.
	const scrollLockRef = React.useRef<boolean>(false);
	const requestFrameRef = React.useRef<number | null>(null);

	const getSyncPointY = React.useCallback(
		(scrollTop: number, pageSize: number, scrollHeight: number) => {
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
		},
		[],
	);

	const getSourceLineDecimal = React.useCallback(
		(sourceEd: editor.IStandaloneCodeEditor, syncY: number) => {
			const sourceModel = sourceEd.getModel();
			const sourceLineCount = sourceModel
				? sourceModel.getLineCount()
				: 1;

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
			const sourceHeight =
				nextSourcePx - baseSourcePx || fallbackLineHeight;

			const fraction = (syncY - baseSourcePx) / sourceHeight;
			return intSourceLine - 1 + fraction;
		},
		[],
	);

	const getPaneCounts = React.useCallback(
		(): [number, number, number, number, number] => [
			editorRefs.current[0]?.getModel()?.getLineCount() ?? 1,
			editorRefs.current[1]?.getModel()?.getLineCount() ?? 1,
			editorRefs.current[2]?.getModel()?.getLineCount() ?? 1,
			editorRefs.current[3]?.getModel()?.getLineCount() ?? 1,
			editorRefs.current[4]?.getModel()?.getLineCount() ?? 1,
		],
		[editorRefs],
	);

	const syncHorizontalScroll = React.useCallback(
		(sourceIndex: number, scrollLeft: number, targetIndices?: number[]) => {
			editorRefs.current.forEach((otherEditor, targetIdx) => {
				if (targetIdx !== sourceIndex && otherEditor) {
					if (targetIndices && !targetIndices.includes(targetIdx)) {
						return;
					}
					if (
						Math.abs(otherEditor.getScrollLeft() - scrollLeft) > 2
					) {
						otherEditor.setScrollLeft(scrollLeft);
					}
				}
			});
		},
		[editorRefs],
	);

	const syncScrollToTarget = React.useCallback(
		(
			otherEditor: editor.IStandaloneCodeEditor,
			targetIdx: number,
			sourceIndex: number,
			sourceLineDecimal: number,
			paneCounts: [number, number, number, number, number],
			syncpoint: number,
			targetIndices?: number[],
		) => {
			if (targetIdx === sourceIndex) {
				return;
			}
			if (targetIndices && !targetIndices.includes(targetIdx)) {
				return;
			}
			if (targetIdx >= 5) {
				return; // Tuple bounds check
			}

			const targetLineDecimal = mapLineAcrossPanes(
				sourceLineDecimal,
				sourceIndex,
				targetIdx,
				diffsRef.current,
				paneCounts,
				smoothScrolling,
				diffsAreReversedRef.current,
			);

			const intTargetLine = Math.floor(targetLineDecimal) + 1;
			const targetFraction =
				targetLineDecimal - Math.floor(targetLineDecimal);
			const targetMax = paneCounts[targetIdx as 0 | 1 | 2 | 3 | 4];

			let targetSyncY: number;
			if (intTargetLine >= targetMax) {
				const lastTop = otherEditor.getTopForLineNumber(targetMax);
				const targetHeight = otherEditor.getOption(
					editor.EditorOption.lineHeight,
				);
				targetSyncY = lastTop + targetFraction * targetHeight;
			} else {
				const targetBasePx =
					otherEditor.getTopForLineNumber(intTargetLine);
				const targetNextPx = otherEditor.getTopForLineNumber(
					intTargetLine + 1,
				);
				targetSyncY =
					targetBasePx +
					targetFraction * (targetNextPx - targetBasePx);
			}

			const layoutInfo = otherEditor.getLayoutInfo();
			const targetScrollTop = targetSyncY - layoutInfo.height * syncpoint;

			if (Math.abs(otherEditor.getScrollTop() - targetScrollTop) > 2) {
				otherEditor.setScrollTop(targetScrollTop);
			}
		},
		[diffsRef, diffsAreReversedRef, smoothScrolling],
	);

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
					const { height: pageSize } = sourceEd.getLayoutInfo();
					const scrollHeight = sourceEd.getContentHeight();

					const { syncpoint, syncY } = getSyncPointY(
						scrollTop,
						pageSize,
						scrollHeight,
					);
					const sourceLineDecimal = getSourceLineDecimal(
						sourceEd,
						syncY,
					);

					const paneCounts = getPaneCounts();

					editorRefs.current.forEach((otherEditor, targetIdx) => {
						if (otherEditor) {
							syncScrollToTarget(
								otherEditor,
								targetIdx,
								sourceIndex,
								sourceLineDecimal,
								paneCounts,
								syncpoint,
								targetIndices,
							);
						}
					});
				}

				if (scrollLeft !== undefined) {
					syncHorizontalScroll(
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
		[
			editorRefs,
			getSyncPointY,
			getSourceLineDecimal,
			syncScrollToTarget,
			getPaneCounts,
			syncHorizontalScroll,
		],
	);

	const attachScrollListener = React.useCallback(
		(ed: editor.IStandaloneCodeEditor, edIndex: number) => {
			return ed.onDidScrollChange(
				(e: import("monaco-editor").IScrollEvent) => {
					if (scrollLockRef.current) {
						return;
					}

					// Only trigger react renders if it wasn't a locked event
					setRenderTrigger((prev) => prev + 1);

					if (e.scrollTopChanged || e.scrollLeftChanged) {
						syncEditors(
							ed,
							edIndex,
							e.scrollTopChanged
								? e.scrollTop
								: ed.getScrollTop(),
							e.scrollLeftChanged
								? e.scrollLeft
								: ed.getScrollLeft(),
						);
					}
				},
			);
		},
		[setRenderTrigger, syncEditors],
	);

	const forceSyncToPane = React.useCallback(
		(sourceIndex: number, targetIndex: number) => {
			const sourceEd = editorRefs.current[sourceIndex];
			const targetEd = editorRefs.current[targetIndex];
			if (sourceEd && targetEd) {
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
