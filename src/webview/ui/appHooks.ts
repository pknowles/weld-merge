import type { editor } from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { Differ } from "../../matchers/diffutil.ts";
import {
	applyChunkEdit,
	copyDownChunk,
	copyUpChunk,
	deleteChunk,
	getChunkText,
} from "./editorActions.ts";
import { getPaneHighlights } from "./highlightUtil.ts";
import type { BaseDiffPayload, DiffChunk, FileState } from "./types.ts";
import type { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const HACK_SYNC_DELAY = 100;

interface MessageHandlersDeps {
	filesRef: React.MutableRefObject<PaneFiles>;
	diffsRef: React.MutableRefObject<PaneDiffs>;
	setFiles: (f: PaneFiles) => void;
	setDiffs: (d: PaneDiffs) => void;
	setExternalSyncId: (p: (id: number) => number) => void;
	setDebounceDelay: (d: number) => void;
	setSyntaxHighlighting: (s: boolean) => void;
	setBaseCompareHighlighting: (b: boolean) => void;
	setSmoothScrolling: (s: boolean) => void;
	setRenderTrigger: (p: (p: number) => number) => void;
	commitModelUpdate: (v: string) => void;
	resolveClipboardRead: (id: number, text: string) => void;
	vscodeApi: ReturnType<typeof useVscodeMessageBus>;
	differRef: React.MutableRefObject<Differ | null>;
}

interface LoadDiffData {
	files: FileState[];
	diffs: DiffChunk[][];
	config: {
		debounceDelay?: number;
		syntaxHighlighting?: boolean;
		baseCompareHighlighting?: boolean;
		smoothScrolling?: boolean;
	};
}

function handleConfig(config: LoadDiffData["config"], p: MessageHandlersDeps) {
	if (!config) {
		return;
	}
	if (config.debounceDelay !== undefined) {
		p.setDebounceDelay(config.debounceDelay);
	}
	if (config.syntaxHighlighting !== undefined) {
		p.setSyntaxHighlighting(config.syntaxHighlighting);
	}
	if (config.baseCompareHighlighting !== undefined) {
		p.setBaseCompareHighlighting(config.baseCompareHighlighting);
	}
	if (config.smoothScrolling !== undefined) {
		p.setSmoothScrolling(config.smoothScrolling);
	}
}

function handleLoadDiff(data: LoadDiffData, p: MessageHandlersDeps) {
	const iF: PaneFiles = [
		null,
		data.files[0] ?? null,
		data.files[1] ?? null,
		data.files[2] ?? null,
		null,
	];
	const iD: PaneDiffs = [
		null,
		data.diffs[0] ?? null,
		data.diffs[1] ?? null,
		null,
	];
	p.filesRef.current = iF;
	p.setFiles(iF);
	p.setDiffs(iD);
	p.diffsRef.current = iD;
	p.setExternalSyncId((id) => id + 1);

	handleConfig(data.config, p);

	const differ = new Differ();
	const dI = differ.setSequencesIter([
		splitLines(data.files[0]?.content ?? ""),
		splitLines(data.files[1]?.content ?? ""),
		splitLines(data.files[2]?.content ?? ""),
	]);
	let s = dI.next();
	while (!s.done) {
		s = dI.next();
	}
	p.differRef.current = differ;
	setTimeout(() => p.setRenderTrigger((prev) => prev + 1), HACK_SYNC_DELAY);
}

function handleLoadBaseDiff(data: BaseDiffPayload, p: MessageHandlersDeps) {
	const { side, file, diffs: pD } = data;
	const nF = [...p.filesRef.current] as PaneFiles;
	nF[side === "left" ? 0 : 4] = file;
	p.filesRef.current = nF;
	p.setFiles(nF);

	const nD = [...p.diffsRef.current] as PaneDiffs;
	nD[side === "left" ? 0 : 3] = pD;
	p.diffsRef.current = nD;
	p.setDiffs(nD);
	setTimeout(() => p.setRenderTrigger((prev) => prev + 1), HACK_SYNC_DELAY);
}

function findTargetChunk(
	sorted: DiffChunk[],
	cur: number,
	dir: "prev" | "next",
): DiffChunk | null {
	const n = sorted.length;
	if (n === 0) {
		return null;
	}
	const idx = sorted.findIndex((c) => c.startA + 1 >= cur);
	if (dir === "next") {
		if (idx === -1) {
			return sorted[0] ?? null;
		}
		const c = sorted[idx] as DiffChunk;
		return c.startA + 1 <= cur ? (sorted[(idx + 1) % n] ?? null) : c;
	}
	if (idx === -1) {
		return sorted[n - 1] ?? null;
	}
	const c = sorted[idx] as DiffChunk;
	return c.startA + 1 < cur ? c : (sorted[(idx - 1 + n) % n] ?? null);
}

interface CommitDeps {
	filesRef: React.MutableRefObject<PaneFiles>;
	diffsRef: React.MutableRefObject<PaneDiffs>;
	setFiles: (f: PaneFiles) => void;
	setDiffs: (d: PaneDiffs) => void;
	setRenderTrigger: (p: (p: number) => number) => void;
	differRef: React.MutableRefObject<Differ | null>;
}

export type PaneFiles = [
	FileState | null,
	FileState | null,
	FileState | null,
	FileState | null,
	FileState | null,
];
export type PaneDiffs = [
	DiffChunk[] | null,
	DiffChunk[] | null,
	DiffChunk[] | null,
	DiffChunk[] | null,
];

export function usePreviousNonNull<T>(value: T | null): T | null {
	const ref = useRef<T | null>(value);
	useEffect(() => {
		if (value !== null) {
			ref.current = value;
		}
	}, [value]);
	return value !== null ? value : ref.current;
}

export function useCommitModelUpdate(deps: CommitDeps) {
	const {
		filesRef,
		diffsRef,
		setFiles,
		setDiffs,
		setRenderTrigger,
		differRef,
	} = deps;
	return useCallback(
		(value: string) => {
			const cF = filesRef.current;
			if (!(cF[1] && cF[2] && cF[3])) {
				return;
			}
			const oldM = splitLines(cF[2].content);
			const newM = splitLines(value);
			let nD: PaneDiffs | null = null;
			const d = differRef.current;
			if (d) {
				let sIdx = 0;
				const mLen = Math.min(oldM.length, newM.length);
				while (sIdx < mLen && oldM[sIdx] === newM[sIdx]) {
					sIdx++;
				}
				d.changeSequence(1, sIdx, newM.length - oldM.length, [
					splitLines(cF[1].content),
					newM,
					splitLines(cF[3].content),
				]);
				nD = [...diffsRef.current];
				nD[1] = d._mergeCache
					.map((p) => p[0])
					.filter((c): c is DiffChunk => c !== null);
				nD[2] = d._mergeCache
					.map((p) => p[1])
					.filter((c): c is DiffChunk => c !== null);
				diffsRef.current = nD;
			}
			const nF = [...cF] as PaneFiles;
			nF[2] = { ...cF[2], content: value };
			filesRef.current = nF;
			setFiles(nF);
			if (nD) {
				setDiffs(nD);
			}
			setRenderTrigger((prev) => prev + 1);
		},
		[setFiles, setDiffs, setRenderTrigger, filesRef, diffsRef, differRef],
	);
}

export const useAppMessageHandlers = (p: MessageHandlersDeps) => {
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const m = event.data;
			switch (m.command) {
				case "loadDiff":
					handleLoadDiff(m.data, p);
					break;
				case "loadBaseDiff":
					handleLoadBaseDiff(m.data, p);
					break;
				case "updateContent":
					p.setExternalSyncId((id) => id + 1);
					p.commitModelUpdate(m.text);
					break;
				case "updateConfig":
					handleConfig(m.config, p);
					break;
				case "clipboardText":
					p.resolveClipboardRead(
						Number(m.requestId),
						m.text as string,
					);
					break;
				default:
					break;
			}
		};
		window.addEventListener("message", handleMessage);
		if (p.vscodeApi) {
			p.vscodeApi.postMessage({ command: "ready" });
		}
		return () => window.removeEventListener("message", handleMessage);
	}, [p]);
};

export const useAppHighlights = (
	files: PaneFiles,
	diffs: PaneDiffs,
	bCH: boolean,
) =>
	useCallback(
		(idx: number) => {
			if (files.length < 5) {
				return [];
			}
			const isLBC = bCH && Boolean(files[0]);
			const isRBC = bCH && Boolean(files[4]);
			return getPaneHighlights(idx, files, diffs, isLBC, isRBC);
		},
		[diffs, files, bCH],
	);

export const useAppNavigation = (
	editorRefs: React.RefObject<editor.IStandaloneCodeEditor[]>,
	diffsRef: React.MutableRefObject<PaneDiffs>,
) =>
	useCallback(
		(dir: "prev" | "next", type: "diff" | "conflict") => {
			const targetEd = editorRefs.current?.[2];
			if (!targetEd) {
				return;
			}
			const all = [
				...(diffsRef.current[1] ?? []),
				...(diffsRef.current[2] ?? []),
			];
			const sorted = all
				.filter(
					(c) =>
						c.tag !== "equal" &&
						(type !== "conflict" || c.tag === "conflict"),
				)
				.sort((a, b) => a.startA - b.startA)
				.filter(
					(c, i, self) =>
						i === 0 ||
						c.startA !== (self[i - 1] as DiffChunk).startA,
				);

			const target = findTargetChunk(
				sorted,
				targetEd.getPosition()?.lineNumber || 1,
				dir,
			);
			if (target) {
				targetEd.revealLineInCenter(target.startA + 1);
				targetEd.setPosition({
					lineNumber: target.startA + 1,
					column: 1,
				});
				targetEd.focus();
			}
		},
		[editorRefs, diffsRef],
	);

export const useAppChunkActions = (
	editorRefs: React.RefObject<editor.IStandaloneCodeEditor[]>,
) => {
	const handleApplyChunk = useCallback(
		(paneIndex: number, chunk: DiffChunk) => {
			const srcEd = editorRefs.current?.[paneIndex];
			const mEd = editorRefs.current?.[2];
			if (srcEd && mEd) {
				const srcM = srcEd.getModel();
				const mM = mEd.getModel();
				if (srcM && mM) {
					const txt = getChunkText(srcM, chunk, mM.getLineCount());
					applyChunkEdit(mEd, chunk, txt);
				}
			}
		},
		[editorRefs],
	);

	const handleDeleteChunk = useCallback(
		(_pIdx: number, chunk: DiffChunk) => {
			const mEd = editorRefs.current?.[2];
			if (mEd) {
				deleteChunk(mEd, chunk);
			}
		},
		[editorRefs],
	);

	const handleCopyUpChunk = useCallback(
		(paneIndex: number, chunk: DiffChunk) => {
			const srcEd = editorRefs.current?.[paneIndex];
			const mEd = editorRefs.current?.[2];
			if (srcEd && mEd) {
				const srcM = srcEd.getModel();
				const mM = mEd.getModel();
				if (srcM && mM) {
					const txt = getChunkText(srcM, chunk, mM.getLineCount());
					copyUpChunk(mEd, chunk, txt);
				}
			}
		},
		[editorRefs],
	);

	const handleCopyDownChunk = useCallback(
		(paneIndex: number, chunk: DiffChunk) => {
			const srcEd = editorRefs.current?.[paneIndex];
			const mEd = editorRefs.current?.[2];
			if (srcEd && mEd) {
				const srcM = srcEd.getModel();
				const mM = mEd.getModel();
				if (srcM && mM) {
					const txt = getChunkText(srcM, chunk, mM.getLineCount());
					copyDownChunk(mEd, chunk, txt);
				}
			}
		},
		[editorRefs],
	);

	return {
		handleApplyChunk,
		handleDeleteChunk,
		handleCopyUpChunk,
		handleCopyDownChunk,
	};
};
