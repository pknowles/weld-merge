import debounce from "lodash.debounce";
import type { editor } from "monaco-editor";
import { type FC, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PaneDiffs, PaneFiles } from "./appHooks.ts";
import {
	useAppChunkActions,
	useAppHighlights,
	useAppMessageHandlers,
	useAppNavigation,
	useCommitModelUpdate,
	usePreviousNonNull,
} from "./appHooks.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { MeldPane } from "./meldPane.tsx";
import type {
	DiffChunk,
	FileState,
	Highlight as MeldHighlight,
} from "./types.ts";
import { ANIMATION_DURATION, DIFF_WIDTH } from "./types.ts";
import { useClipboardOverrides } from "./useClipboardOverrides.ts";
import { useSynchronizedScrolling } from "./useSynchronizedScrolling.ts";
import { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

const DEFAULT_DEBOUNCE_DELAY = 300;

const GlobalStyles: FC = () => (
	<style>
		{`
        html, body, #root {
            margin: 0;
            padding: 0;
            height: 100%;
            width: 100%;
            overflow: hidden;
        }
        .diff-path-insert { fill: var(--vscode-weldMerge-diffCurtainInsertFill, rgba(0, 200, 0, 0.2)); }
        .diff-path-delete { fill: var(--vscode-weldMerge-diffCurtainDeleteFill, rgba(0, 200, 0, 0.2)); }
        .diff-path-replace { fill: var(--vscode-weldMerge-diffCurtainReplaceFill, rgba(0, 100, 255, 0.2)); }
        .diff-path-conflict { fill: var(--vscode-weldMerge-diffCurtainConflictFill, rgba(255, 0, 0, 0.2)); }
        
        .diff-edge-insert { stroke: var(--vscode-weldMerge-diffCurtainInsertStroke, rgba(0, 200, 0, 0.5)); stroke-width: 1px; }
        .diff-edge-delete { stroke: var(--vscode-weldMerge-diffCurtainDeleteStroke, rgba(0, 200, 0, 0.5)); stroke-width: 1px; }
        .diff-edge-replace { stroke: var(--vscode-weldMerge-diffCurtainReplaceStroke, rgba(0, 100, 255, 0.5)); stroke-width: 1px; }
        .diff-edge-conflict { stroke: var(--vscode-weldMerge-diffCurtainConflictStroke, rgba(255, 0, 0, 0.5)); stroke-width: 1px; }

        .diff-insert { background-color: var(--vscode-weldMerge-diffInsertBackground, rgba(0, 200, 0, 0.15)) !important; }
        .diff-delete { background-color: var(--vscode-weldMerge-diffDeleteBackground, rgba(0, 200, 0, 0.15)) !important; }
        .diff-replace { background-color: var(--vscode-weldMerge-diffReplaceBackground, rgba(0, 100, 255, 0.15)) !important; }
        .diff-conflict { background-color: var(--vscode-weldMerge-diffConflictBackground, rgba(255, 0, 0, 0.2)) !important; }
        .diff-margin { background-color: transparent !important; }

        .diff-insert-margin { background-color: var(--vscode-weldMerge-diffInsertBackground, rgba(0, 200, 0, 0.15)) !important; }
        .diff-delete-margin { background-color: var(--vscode-weldMerge-diffDeleteBackground, rgba(0, 200, 0, 0.15)) !important; }
        .diff-replace-margin { background-color: var(--vscode-weldMerge-diffReplaceBackground, rgba(0, 100, 255, 0.15)) !important; }
        .diff-conflict-margin { background-color: var(--vscode-weldMerge-diffConflictBackground, rgba(255, 0, 0, 0.2)) !important; }

        .diff-insert-inline { background-color: var(--vscode-weldMerge-diffInsertInlineBackground, rgba(0, 200, 0, 0.35)) !important; }
        .diff-delete-inline { background-color: var(--vscode-weldMerge-diffDeleteInlineBackground, rgba(255, 0, 0, 0.35)) !important; }
        .diff-replace-inline { background-color: var(--vscode-weldMerge-diffReplaceInlineBackground, rgba(0, 100, 255, 0.35)) !important; }
        .diff-conflict-inline { background-color: var(--vscode-weldMerge-diffConflictInlineBackground, rgba(255, 0, 0, 0.35)) !important; }

        .diff-view path { transition: opacity 0.2s; }
        .diff-container:hover .diff-view path { opacity: 0.8; }

        /* Diff Connector Buttons */
        .diff-actions { opacity: 0; transition: opacity 0.1s; }
        .diff-container:hover .diff-actions { opacity: 1; }
        .action-button { 
            width: 16px; 
            height: 16px; 
            border: 1px solid rgba(255,255,255,0.2); 
            background: rgba(0,0,0,0.5); 
            border-radius: 3px; 
            color: white; 
            font-size: 13px; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            padding: 0; 
            cursor: pointer; 
            box-sizing: border-box; 
            line-height: 1; 
            pointer-events: auto;
        }
        .action-button:hover { 
            background: rgba(100,100,100,0.9); 
            border-color: rgba(255,255,255,0.6); 
        }
    `}
	</style>
);

const MeldRoot: FC<{ children: React.ReactNode }> = ({ children }) => (
	<div
		style={
			{
				display: "flex",
				width: "100vw",
				height: "100vh",
				overflow: "hidden",
				position: "relative",
				"--weld-diff-width": `${DIFF_WIDTH}px`,
			} as React.CSSProperties
		}
		data-testid="weld-root"
	>
		<GlobalStyles />
		{children}
	</div>
);

const useBaseAnimation = (files: PaneFiles) => {
	const [renderBL, setRenderBL] = useState(false);
	const [renderBR, setRenderBR] = useState(false);
	useLayoutEffect(() => {
		if (files[0]) {
			setRenderBL(true);
			return;
		}
		const t = setTimeout(() => {
			setRenderBL(false);
		}, ANIMATION_DURATION);
		return () => {
			clearTimeout(t);
		};
	}, [files[0]]);
	useLayoutEffect(() => {
		if (files[4]) {
			setRenderBR(true);
			return;
		}
		const t = setTimeout(() => {
			setRenderBR(false);
		}, ANIMATION_DURATION);
		return () => {
			clearTimeout(t);
		};
	}, [files[4]]);
	return { renderBL, renderBR };
};

interface MeldUIActionsProps {
	files: PaneFiles;
	setFiles: (f: PaneFiles) => void;
	filesRef: React.MutableRefObject<PaneFiles>;
	diffs: PaneDiffs;
	setDiffs: (d: PaneDiffs) => void;
	diffsRef: React.MutableRefObject<PaneDiffs>;
	vscodeApi: ReturnType<typeof useVscodeMessageBus>;
	attachScrollListener: (ed: editor.IStandaloneCodeEditor, i: number) => void;
	forceSyncToPane: (target: number, source: number) => void;
	chunkActions: ReturnType<typeof useAppChunkActions>;
	handleNavigate: (dir: "prev" | "next", type: "diff" | "conflict") => void;
	highlights: (idx: number) => MeldHighlight[];
	requestClipboardText: () => Promise<string>;
	writeClipboardText: (t: string) => Promise<void>;
	commitModelUpdate: (v: string) => void;
	setRenderTrigger: (p: (p: number) => number) => void;
	debounceDelay: number;
}

const useMeldUIActions = (p: MeldUIActionsProps) =>
	useMemo(
		() => ({
			attachScrollListener: p.attachScrollListener,
			forceSyncToPane: p.forceSyncToPane,
			...p.chunkActions,
			vscodeApi: p.vscodeApi,
			handleCopyHash: (hash: string) =>
				p.vscodeApi?.postMessage({ command: "copyHash", hash }),
			handleShowDiff: (idx: number) =>
				p.vscodeApi?.postMessage({
					command: "showDiff",
					paneIndex: idx,
				}),
			handleCompleteMerge: () =>
				p.vscodeApi?.postMessage({ command: "completeMerge" }),
			toggleBaseDiff: (side: "left" | "right") => {
				const targetIdx = side === "left" ? 0 : 4;
				if (p.files[targetIdx]) {
					const nf = [...p.files] as PaneFiles;
					nf[targetIdx] = null;
					p.filesRef.current = nf;
					p.setFiles(nf);
					const nd = [...p.diffs] as PaneDiffs;
					nd[side === "left" ? 0 : 3] = null;
					p.diffsRef.current = nd;
					p.setDiffs(nd);
				} else {
					p.vscodeApi?.postMessage({
						command: "requestBaseDiff",
						side,
					});
				}
			},
			setRenderTrigger: p.setRenderTrigger,
			handleNavigate: p.handleNavigate,
			getHighlights: p.highlights,
			requestClipboardText: p.requestClipboardText,
			writeClipboardText: p.writeClipboardText,
			onEditImmediate: (_i: number) => {
				// useCommitModelUpdate already clears/updates diffs debounced.
				// Synchronous clearing here causes visible flicker on every keystroke.
			},
			onEdit: debounce((v: string | undefined, i: number) => {
				if (v !== undefined && i === 2) {
					p.commitModelUpdate(v);
					p.vscodeApi?.postMessage({
						command: "contentChanged",
						text: v,
					});
				}
			}, p.debounceDelay),
		}),
		[
			p.attachScrollListener,
			p.forceSyncToPane,
			p.chunkActions,
			p.vscodeApi,
			p.files,
			p.setFiles,
			p.filesRef,
			p.diffs,
			p.setDiffs,
			p.diffsRef,
			p.handleNavigate,
			p.highlights,
			p.requestClipboardText,
			p.writeClipboardText,
			p.commitModelUpdate,
			p.debounceDelay,
			p.setRenderTrigger,
		],
	);

const useAppCoreData = () => {
	const [files, setFiles] = useState<PaneFiles>([
		null,
		null,
		null,
		null,
		null,
	]);
	const filesRef = useRef<PaneFiles>([null, null, null, null, null]);
	const [diffs, setDiffs] = useState<PaneDiffs>([null, null, null, null]);
	const diffsRef = useRef<PaneDiffs>([null, null, null, null]);
	const differRef = useRef(null);
	const [externalSyncId, setExternalSyncId] = useState(0);
	const [debounceDelay, setDebounceDelay] = useState(DEFAULT_DEBOUNCE_DELAY);
	const [syntaxHighlighting, setSyntaxHighlighting] = useState(true);
	const [baseCompareHighlighting, setBaseCompareHighlighting] =
		useState(false);
	const [renderTrigger, setRenderTrigger] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const editorRefArray = useRef<editor.IStandaloneCodeEditor[]>([]);
	const diffsAreReversedRef = useRef<boolean[]>([false, true, false, false]);
	return {
		files,
		setFiles,
		filesRef,
		diffs,
		setDiffs,
		diffsRef,
		differRef,
		externalSyncId,
		setExternalSyncId,
		debounceDelay,
		setDebounceDelay,
		syntaxHighlighting,
		setSyntaxHighlighting,
		baseCompareHighlighting,
		setBaseCompareHighlighting,
		renderTrigger,
		setRenderTrigger,
		error,
		setError,
		editorRefArray,
		diffsAreReversedRef,
	};
};

const useAppServices = (
	editorRefArray: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
) => {
	const vscodeApi = useVscodeMessageBus();
	const cb = useClipboardOverrides(editorRefArray);
	return { vscodeApi, ...cb };
};

const useAppStateMessageHandlers = (
	d: ReturnType<typeof useAppCoreData>,
	s: ReturnType<typeof useAppServices>,
	commitModelUpdate: (v: string) => void,
) => {
	useAppMessageHandlers({
		filesRef: d.filesRef,
		diffsRef: d.diffsRef,
		setFiles: d.setFiles,
		setDiffs: d.setDiffs,
		setExternalSyncId: d.setExternalSyncId,
		setDebounceDelay: d.setDebounceDelay,
		setSyntaxHighlighting: d.setSyntaxHighlighting,
		setBaseCompareHighlighting: d.setBaseCompareHighlighting,
		setRenderTrigger: d.setRenderTrigger,
		commitModelUpdate,
		resolveClipboardRead: s.resolveClipboardRead,
		vscodeApi: s.vscodeApi,
		differRef: d.differRef,
		setError: d.setError,
	});
};

const useUIState = (p: {
	d: ReturnType<typeof useAppCoreData>;
	prevBL: FileState | null;
	prevBR: FileState | null;
	prevDL: DiffChunk[] | null;
	prevDR: DiffChunk[] | null;
	renderBL: boolean;
	renderBR: boolean;
}) =>
	useMemo(
		() => ({
			files: p.d.files,
			diffs: p.d.diffs,
			prevBaseLeft: p.prevBL,
			prevBaseRight: p.prevBR,
			prevBaseLeftDiffs: p.prevDL,
			prevBaseRightDiffs: p.prevDR,
			renderBaseLeft: p.renderBL,
			renderBaseRight: p.renderBR,
			baseCompareHighlighting: p.d.baseCompareHighlighting,
			renderTrigger: p.d.renderTrigger,
			syntaxHighlighting: p.d.syntaxHighlighting,
			externalSyncId: p.d.externalSyncId,
			editorRefArray: p.d.editorRefArray,
		}),
		[
			p.d.files,
			p.d.diffs,
			p.prevBL,
			p.prevBR,
			p.prevDL,
			p.prevDR,
			p.renderBL,
			p.renderBR,
			p.d.baseCompareHighlighting,
			p.d.renderTrigger,
			p.d.syntaxHighlighting,
			p.d.externalSyncId,
			p.d.editorRefArray,
		],
	);

const useAppState = () => {
	const d = useAppCoreData();
	const s = useAppServices(d.editorRefArray);
	const sync = useSynchronizedScrolling(
		d.editorRefArray,
		d.diffsRef,
		d.diffsAreReversedRef,
		d.setRenderTrigger,
	);

	const prevBL = usePreviousNonNull(d.files[0]);
	const prevBR = usePreviousNonNull(d.files[4]);
	const prevDL = usePreviousNonNull(d.diffs[0]);
	const prevDR = usePreviousNonNull(d.diffs[3]);
	const commitModelUpdate = useCommitModelUpdate({
		filesRef: d.filesRef,
		diffsRef: d.diffsRef,
		setFiles: d.setFiles,
		setDiffs: d.setDiffs,
		setRenderTrigger: d.setRenderTrigger,
		differRef: d.differRef,
	});

	useAppStateMessageHandlers(d, s, commitModelUpdate);

	const { renderBL, renderBR } = useBaseAnimation(d.files);
	const uiState = useUIState({
		d,
		prevBL,
		prevBR,
		prevDL,
		prevDR,
		renderBL,
		renderBR,
	});

	const highlights = useAppHighlights(
		d.files,
		d.diffs,
		d.baseCompareHighlighting,
	);
	const handleNavigate = useAppNavigation(d.editorRefArray, d.diffsRef);
	const chunkActions = useAppChunkActions(d.editorRefArray);

	const uiActions = useMeldUIActions({
		files: d.files,
		setFiles: d.setFiles,
		filesRef: d.filesRef,
		diffs: d.diffs,
		setDiffs: d.setDiffs,
		diffsRef: d.diffsRef,
		vscodeApi: s.vscodeApi,
		attachScrollListener: sync.attachScrollListener,
		forceSyncToPane: sync.forceSyncToPane,
		chunkActions,
		handleNavigate,
		highlights,
		requestClipboardText: s.requestClipboardText,
		writeClipboardText: s.writeClipboardText,
		commitModelUpdate,
		setRenderTrigger: d.setRenderTrigger,
		debounceDelay: d.debounceDelay,
	});

	return { files: d.files, uiState, uiActions, error: d.error };
};

export const App: FC = () => {
	const { files, uiState, uiActions, error } = useAppState();

	if (error) {
		return (
			<div
				style={{
					color: "var(--vscode-errorForeground)",
					padding: "20px",
					fontFamily: "var(--vscode-font-family)",
				}}
			>
				<h3>Merge Error</h3>
				<p>{error}</p>
				<button
					type="button"
					onClick={() =>
						uiActions.vscodeApi?.postMessage({ command: "ready" })
					}
					style={{
						backgroundColor: "var(--vscode-button-background)",
						color: "var(--vscode-button-foreground)",
						border: "none",
						padding: "4px 12px",
						cursor: "pointer",
					}}
				>
					Retry
				</button>
			</div>
		);
	}

	if (files[1] === null) {
		return (
			<div
				style={{
					color: "white",
					padding: "20px",
					fontFamily: "sans-serif",
				}}
			>
				Loading Diff...
			</div>
		);
	}

	return (
		<ErrorBoundary>
			<MeldRoot>
				{/* biome-ignore lint/performance: This is React, not Solid */}
				{[0, 1, 2, 3, 4].map((idx) => (
					<MeldPane
						key={idx}
						idx={idx}
						ui={uiState}
						actions={uiActions}
					/>
				))}
			</MeldRoot>
		</ErrorBoundary>
	);
};
