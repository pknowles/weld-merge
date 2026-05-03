import type { editor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Differ } from "../../matchers/diffutil.ts";
import {
	applyChunkEdit,
	copyDownChunk,
	copyUpChunk,
	deleteChunk,
	getChunkText,
} from "./editorActions.ts";
import { getPaneHighlights } from "./highlightUtil.ts";
import type {
	BaseDiffPayload,
	DiffChunk,
	FileState,
	MonacoContentChange,
	PayloadDiffs,
	PayloadFiles,
} from "./types.ts";
import type { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const compareChunkOrder = (left: DiffChunk, right: DiffChunk): number => {
	if (left.startA !== right.startA) {
		return left.startA - right.startA;
	}
	if (left.endA !== right.endA) {
		return left.endA - right.endA;
	}
	if (left.startB !== right.startB) {
		return left.startB - right.startB;
	}
	if (left.endB !== right.endB) {
		return left.endB - right.endB;
	}
	return left.tag.localeCompare(right.tag);
};

const assertDiffChunksWellFormed = (chunks: DiffChunk[], label: string) => {
	let prev: DiffChunk | null = null;
	for (const chunk of chunks) {
		const lenA = chunk.endA - chunk.startA;
		const lenB = chunk.endB - chunk.startB;
		if (lenA < 0 || lenB < 0) {
			throw new Error(
				`${label}: invalid diff range ${chunk.startA}:${chunk.endA} -> ${chunk.startB}:${chunk.endB}`,
			);
		}
		if (lenA === 0 && lenB === 0) {
			throw new Error(
				`${label}: empty diff chunk ${chunk.startA}:${chunk.endA} -> ${chunk.startB}:${chunk.endB}`,
			);
		}
		if (prev && compareChunkOrder(prev, chunk) >= 0) {
			throw new Error(
				`${label}: chunk sequence must be strictly increasing; previous ${prev.startA}:${prev.endA}:${prev.startB}:${prev.endB}:${prev.tag}`,
			);
		}
		prev = chunk;
	}
};

interface MessageHandlersDeps {
	filesRef: React.MutableRefObject<PaneFiles>;
	diffsRef: React.MutableRefObject<PaneDiffs>;
	setFiles: (f: PaneFiles) => void;
	setDiffs: (d: PaneDiffs) => void;
	setLastExternalChangeVersion: (v: number) => void;
	setDebounceDelay: (d: number) => void;
	setSyntaxHighlighting: (s: boolean) => void;
	setBaseCompareHighlighting: (b: boolean) => void;
	setIsConflicted: (isConflicted: boolean) => void;
	setRenderTrigger: (p: (p: number) => number) => void;
	commitModelUpdate: (v: string) => void;
	resolveClipboardRead: (id: number, text: string) => void;
	vscodeApi: ReturnType<typeof useVscodeMessageBus>;
	differRef: React.MutableRefObject<Differ | null>;
	lastExternalChangeVersionRef: React.MutableRefObject<number>;
	applyExternalEditsRef: React.RefObject<{
		applyIncrementalEdits: (changes: MonacoContentChange[]) => void;
		applyFullSync: (content: string) => void;
	} | null>;
}

type MessageDispatchDeps = MessageHandlersDeps;

interface LoadDiffData {
	files: PayloadFiles;
	diffs: PayloadDiffs;
	isConflicted?: boolean;
	config: {
		debounceDelay?: number;
		syntaxHighlighting?: boolean;
		baseCompareHighlighting?: boolean;
	};
	lastExternalChangeVersion: number;
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
}

function handleLoadDiff(data: LoadDiffData, p: MessageDispatchDeps) {
	const [localFile, mergedFile, remoteFile] = data.files;
	const [leftDiffs, rightDiffs] = data.diffs;
	assertDiffChunksWellFormed(leftDiffs, "loadDiff left");
	assertDiffChunksWellFormed(rightDiffs, "loadDiff right");

	// Remember which base-compare panes were open before this reload so we
	// can re-request them below. The webview owns this state — no round-trip.
	const wasLeftOpen = p.filesRef.current[0] !== null;
	const wasRightOpen = p.filesRef.current[4] !== null;

	// PaneFiles still has the 5-slot shape (baseLeft, local, merged, remote,
	// baseRight). The base-compare slots are filled lazily via loadBaseDiff,
	// so they start as null here. See TODO.md "PaneFiles / PaneDiffs".
	const iF: PaneFiles = [null, localFile, mergedFile, remoteFile, null];
	const iD: PaneDiffs = [null, leftDiffs, rightDiffs, null];
	p.filesRef.current = iF;
	p.setFiles(iF);
	p.setDiffs(iD);
	p.diffsRef.current = iD;
	p.setLastExternalChangeVersion(data.lastExternalChangeVersion);
	p.lastExternalChangeVersionRef.current = data.lastExternalChangeVersion;
	p.setIsConflicted(data.isConflicted ?? true);
	p.setRenderTrigger((prev) => prev + 1);

	handleConfig(data.config, p);

	const differ = new Differ();
	differ.setSequences([
		splitLines(localFile.content),
		splitLines(mergedFile.content),
		splitLines(remoteFile.content),
	]);
	p.differRef.current = differ;

	// Re-request any base-compare panes that were open before this reload.
	if (wasLeftOpen) {
		p.vscodeApi?.postMessage({ command: "requestBaseDiff", side: "left" });
	}
	if (wasRightOpen) {
		p.vscodeApi?.postMessage({ command: "requestBaseDiff", side: "right" });
	}
}

function handleLoadBaseDiff(data: BaseDiffPayload, p: MessageDispatchDeps) {
	const { side, file, diffs: pD } = data;
	assertDiffChunksWellFormed(
		pD,
		side === "left" ? "loadBaseDiff left" : "loadBaseDiff right",
	);
	const nF = [...p.filesRef.current] as PaneFiles;
	nF[side === "left" ? 0 : 4] = file;
	p.filesRef.current = nF;
	p.setFiles(nF);

	const nD = [...p.diffsRef.current] as PaneDiffs;
	nD[side === "left" ? 0 : 3] = pD;
	p.diffsRef.current = nD;
	p.setDiffs(nD);
	p.setRenderTrigger((prev) => prev + 1);
}

function handleExternalEdit(
	m: { changes: MonacoContentChange[]; lastExternalChangeVersion: number },
	p: MessageHandlersDeps,
) {
	if (m.lastExternalChangeVersion > p.lastExternalChangeVersionRef.current) {
		p.lastExternalChangeVersionRef.current = m.lastExternalChangeVersion;
		p.setLastExternalChangeVersion(m.lastExternalChangeVersion);
		p.applyExternalEditsRef.current?.applyIncrementalEdits(m.changes);
	}
}

function handleFullSync(
	m: { content: string; lastExternalChangeVersion: number },
	p: MessageHandlersDeps,
) {
	if (m.lastExternalChangeVersion >= p.lastExternalChangeVersionRef.current) {
		p.lastExternalChangeVersionRef.current = m.lastExternalChangeVersion;
		p.setLastExternalChangeVersion(m.lastExternalChangeVersion);
		p.applyExternalEditsRef.current?.applyFullSync(m.content);

		const nF = [...p.filesRef.current] as PaneFiles;
		if (nF[2]) {
			nF[2] = { ...nF[2], content: m.content };
			p.filesRef.current = nF;
			p.setFiles(nF);
		}
		p.commitModelUpdate(m.content);
	}
}

function handleUpdateConfig(
	config: LoadDiffData["config"],
	p: MessageHandlersDeps,
) {
	handleConfig(config, p);
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
	return value === null ? ref.current : value;
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
			const newM = splitLines(value);
			let nD: PaneDiffs | null = null;
			const d = differRef.current;
			if (d) {
				const oldM = splitLines(cF[2].content);
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
				const leftDiffs = d._mergeCache
					.map((p) => p[0])
					.filter((c): c is DiffChunk => c !== null);
				const rightDiffs = d._mergeCache
					.map((p) => p[1])
					.filter((c): c is DiffChunk => c !== null);
				assertDiffChunksWellFormed(leftDiffs, "commitModelUpdate left");
				assertDiffChunksWellFormed(
					rightDiffs,
					"commitModelUpdate right",
				);
				nD[1] = leftDiffs;
				nD[2] = rightDiffs;
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
	const {
		filesRef,
		diffsRef,
		setFiles,
		setDiffs,
		setLastExternalChangeVersion,
		setDebounceDelay,
		setSyntaxHighlighting,
		setBaseCompareHighlighting,
		setIsConflicted,
		setRenderTrigger,
		commitModelUpdate,
		resolveClipboardRead,
		vscodeApi,
		differRef,
		lastExternalChangeVersionRef,
		applyExternalEditsRef,
	} = p;

	useEffect(() => {
		const messageDeps: MessageDispatchDeps = {
			filesRef,
			diffsRef,
			setFiles,
			setDiffs,
			setLastExternalChangeVersion,
			setDebounceDelay,
			setSyntaxHighlighting,
			setBaseCompareHighlighting,
			setIsConflicted,
			setRenderTrigger,
			commitModelUpdate,
			resolveClipboardRead,
			vscodeApi,
			differRef,
			lastExternalChangeVersionRef,
			applyExternalEditsRef,
		};
		const handleMessage = (event: MessageEvent) => {
			const m = event.data;
			switch (m.command) {
				case "loadDiff":
					handleLoadDiff(
						{
							...m.data,
							lastExternalChangeVersion:
								m.lastExternalChangeVersion,
						},
						messageDeps,
					);
					break;
				case "loadBaseDiff":
					handleLoadBaseDiff(m.data, messageDeps);
					break;
				case "externalEdit":
					handleExternalEdit(m, messageDeps);
					break;
				case "fullSync":
					handleFullSync(m, messageDeps);
					break;
				case "updateConfig":
					handleUpdateConfig(m.config, messageDeps);
					break;
				case "conflictStateLost":
					setIsConflicted(false);
					break;
				case "clipboardText":
					resolveClipboardRead(Number(m.requestId), m.text as string);
					break;
				default:
					break;
			}
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [
		applyExternalEditsRef,
		commitModelUpdate,
		differRef,
		diffsRef,
		filesRef,
		lastExternalChangeVersionRef,
		resolveClipboardRead,
		setBaseCompareHighlighting,
		setIsConflicted,
		setDebounceDelay,
		setDiffs,
		setFiles,
		setLastExternalChangeVersion,
		setRenderTrigger,
		setSyntaxHighlighting,
		vscodeApi,
	]);

	useEffect(() => {
		if (vscodeApi) {
			vscodeApi.postMessage({ command: "ready" });
		}
	}, [vscodeApi]);
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

	return useMemo(
		() => ({
			handleApplyChunk,
			handleDeleteChunk,
			handleCopyUpChunk,
			handleCopyDownChunk,
		}),
		[
			handleApplyChunk,
			handleDeleteChunk,
			handleCopyUpChunk,
			handleCopyDownChunk,
		],
	);
};
