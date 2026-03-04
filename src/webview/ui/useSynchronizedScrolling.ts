import type { editor } from "monaco-editor";
import * as React from "react";
import type { DiffChunk } from "./types";

export function useSynchronizedScrolling(
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
	diffsRef: React.MutableRefObject<DiffChunk[][]>,
	setRenderTrigger: React.Dispatch<React.SetStateAction<number>>,
) {
	const syncingFrom = React.useRef<number | null>(null);

	const attachScrollListener = React.useCallback(
		(ed: editor.IStandaloneCodeEditor, edIndex: number) => {
			return ed.onDidScrollChange((e: import("monaco-editor").IScrollEvent) => {
				setRenderTrigger((prev) => prev + 1);

				if (syncingFrom.current !== null && syncingFrom.current !== edIndex)
					return;

				const dRef = diffsRef.current;

				const mapLineWithDiff = (
					sLine: number,
					diff: DiffChunk[],
					sourceIsA: boolean,
					tIndex: number,
				): number => {
					const maxLines =
						editorRefs.current[tIndex]?.getModel()?.getLineCount() || 1;

					if (!diff || diff.length === 0) return Math.min(sLine, maxLines);
					let lastChunk = diff[0];
					for (const chunk of diff) {
						const sStart = sourceIsA ? chunk.start_a : chunk.start_b;
						const sEnd = sourceIsA ? chunk.end_a : chunk.end_b;
						const tStart = sourceIsA ? chunk.start_b : chunk.start_a;
						const tEnd = sourceIsA ? chunk.end_b : chunk.end_a;

						if (sLine >= sStart && sLine < sEnd) {
							if (chunk.tag === "equal") {
								return Math.min(tStart + (sLine - sStart), maxLines);
							}
							const sLen = sEnd - sStart;
							const tLen = tEnd - tStart;
							const ratio = sLen > 0 ? (sLine - sStart) / sLen : 0;
							return Math.min(tStart + ratio * tLen, maxLines);
						}
						lastChunk = chunk;
					}
					const sEnd = sourceIsA ? lastChunk.end_a : lastChunk.end_b;
					const tEnd = sourceIsA ? lastChunk.end_b : lastChunk.end_a;
					return Math.min(tEnd + (sLine - sEnd), maxLines);
				};

				const mapLine = (sLine: number, sIdx: number, tIdx: number): number => {
					if (sIdx === 0 && tIdx === 1)
						return mapLineWithDiff(sLine, dRef[0], false, 1);
					if (sIdx === 1 && tIdx === 0)
						return mapLineWithDiff(sLine, dRef[0], true, 0);
					if (sIdx === 1 && tIdx === 2)
						return mapLineWithDiff(sLine, dRef[1], true, 2);
					if (sIdx === 2 && tIdx === 1)
						return mapLineWithDiff(sLine, dRef[1], false, 1);
					return sLine;
				};

				if (e.scrollTopChanged) {
					let lineHeight =
						ed.getTopForLineNumber(2) - ed.getTopForLineNumber(1);
					if (lineHeight <= 0) lineHeight = 19;
					const sourceLine = Math.max(0, e.scrollTop) / lineHeight;

					syncingFrom.current = edIndex;
					editorRefs.current.forEach((otherEditor, i) => {
						if (i !== edIndex && otherEditor) {
							let targetLine = sourceLine;
							if (edIndex === 0 && i === 1)
								targetLine = mapLine(sourceLine, 0, 1);
							else if (edIndex === 0 && i === 2)
								targetLine = mapLine(mapLine(sourceLine, 0, 1), 1, 2);
							else if (edIndex === 1 && i === 0)
								targetLine = mapLine(sourceLine, 1, 0);
							else if (edIndex === 1 && i === 2)
								targetLine = mapLine(sourceLine, 1, 2);
							else if (edIndex === 2 && i === 1)
								targetLine = mapLine(sourceLine, 2, 1);
							else if (edIndex === 2 && i === 0)
								targetLine = mapLine(mapLine(sourceLine, 2, 1), 1, 0);

							const targetScrollTop = targetLine * lineHeight;
							if (Math.abs(otherEditor.getScrollTop() - targetScrollTop) > 2) {
								otherEditor.setScrollTop(targetScrollTop);
							}
						}
					});
					syncingFrom.current = null;
				}

				if (e.scrollLeftChanged) {
					syncingFrom.current = edIndex;
					editorRefs.current.forEach((otherEditor, i) => {
						if (i !== edIndex && otherEditor) {
							if (Math.abs(otherEditor.getScrollLeft() - e.scrollLeft) > 2) {
								otherEditor.setScrollLeft(e.scrollLeft);
							}
						}
					});
					syncingFrom.current = null;
				}
			});
		},
		[diffsRef, editorRefs, setRenderTrigger],
	);

	return { attachScrollListener };
}
