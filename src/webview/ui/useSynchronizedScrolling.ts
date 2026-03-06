import { editor } from "monaco-editor";
import * as React from "react";
import { mapLineAcrossPanes } from "./scrollMapping";
import type { DiffChunk } from "./types";

export const useSynchronizedScrolling = (
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
	diffsRef: React.MutableRefObject<(DiffChunk[] | null)[]>,
	setRenderTrigger: React.Dispatch<React.SetStateAction<number>>,
	smoothScrolling: boolean,
) => {
	// Replacing `syncingFrom` with a scroll lock that discards re-entrant events entirely.
	const scrollLockRef = React.useRef<boolean>(false);

	const syncEditors = React.useCallback(
		(
			sourceEd: editor.IStandaloneCodeEditor,
			sourceIndex: number,
			scrollTop: number,
			scrollLeft: number | undefined,
			targetIndices?: number[],
		) => {
			if (scrollLockRef.current) return;
			scrollLockRef.current = true;

			try {
				if (scrollTop !== undefined) {
					// 1. Calculate the syncpoint
					const pageSize = sourceEd.getLayoutInfo().height;
					const scrollHeight = sourceEd.getContentHeight();

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

					const syncY = scrollTop + pageSize * syncpoint;
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
					const sourceHeight =
						nextSourcePx - baseSourcePx || fallbackLineHeight;

					const fraction = (syncY - baseSourcePx) / sourceHeight;
					const sourceLineDecimal = intSourceLine - 1 + fraction;

					const paneCounts = [0, 1, 2, 3, 4].map((idx) => {
						const m = editorRefs.current[idx]?.getModel();
						return m ? m.getLineCount() : 1;
					});

					editorRefs.current.forEach((otherEditor, targetIdx) => {
						if (targetIdx !== sourceIndex && otherEditor) {
							if (targetIndices && !targetIndices.includes(targetIdx)) return;

							const targetLineDecimal = mapLineAcrossPanes(
								sourceLineDecimal,
								sourceIndex,
								targetIdx,
								diffsRef.current,
								paneCounts,
								smoothScrolling,
							);

							const intTargetLine = Math.floor(targetLineDecimal) + 1;
							const targetFraction =
								targetLineDecimal - Math.floor(targetLineDecimal);

							const targetMax = paneCounts[targetIdx];

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
									targetBasePx + targetFraction * (targetNextPx - targetBasePx);
							}

							const targetScrollTop =
								targetSyncY - otherEditor.getLayoutInfo().height * syncpoint;

							if (Math.abs(otherEditor.getScrollTop() - targetScrollTop) > 2) {
								otherEditor.setScrollTop(targetScrollTop);
							}
						}
					});
				}

				if (scrollLeft !== undefined) {
					editorRefs.current.forEach((otherEditor, targetIdx) => {
						if (targetIdx !== sourceIndex && otherEditor) {
							if (targetIndices && !targetIndices.includes(targetIdx)) return;
							if (Math.abs(otherEditor.getScrollLeft() - scrollLeft) > 2) {
								otherEditor.setScrollLeft(scrollLeft);
							}
						}
					});
				}
			} finally {
				requestAnimationFrame(() => {
					scrollLockRef.current = false;
				});
			}
		},
		[diffsRef, editorRefs, smoothScrolling],
	);

	const attachScrollListener = React.useCallback(
		(ed: editor.IStandaloneCodeEditor, edIndex: number) => {
			return ed.onDidScrollChange((e: import("monaco-editor").IScrollEvent) => {
				if (scrollLockRef.current) return;

				// Only trigger react renders if it wasn't a locked event
				setRenderTrigger((prev) => prev + 1);

				if (e.scrollTopChanged || e.scrollLeftChanged) {
					syncEditors(
						ed,
						edIndex,
						e.scrollTopChanged ? e.scrollTop : ed.getScrollTop(),
						e.scrollLeftChanged ? e.scrollLeft : ed.getScrollLeft(),
					);
				}
			});
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
