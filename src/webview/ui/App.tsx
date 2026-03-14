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
import type { Highlight as MeldHighlight } from "./types.ts";
import { ANIMATION_DURATION } from "./types.ts";
import { useClipboardOverrides } from "./useClipboardOverrides.ts";
import { useSynchronizedScrolling } from "./useSynchronizedScrolling.ts";
import { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

const DEFAULT_DEBOUNCE_DELAY = 300;
const MeldRoot: FC<{ children: React.ReactNode }> = ({ children }) => (
	<div
		style={{
			display: "flex",
			width: "100%",
			height: "100%",
			overflow: "hidden",
			position: "relative",
		}}
	>
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
	debounceDelay: number;
}

const useMeldUIActions = (p: MeldUIActionsProps) =>
	useMemo(
		() => ({
			attachScrollListener: p.attachScrollListener,
			forceSyncToPane: p.forceSyncToPane,
			...p.chunkActions,
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
			handleNavigate: p.handleNavigate,
			getHighlights: p.highlights,
			requestClipboardText: p.requestClipboardText,
			writeClipboardText: p.writeClipboardText,
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
	const [smoothScrolling, setSmoothScrolling] = useState(true);
	const [renderTrigger, setRenderTrigger] = useState(0);
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
		smoothScrolling,
		setSmoothScrolling,
		renderTrigger,
		setRenderTrigger,
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

const useAppState = () => {
	const d = useAppCoreData();
	const s = useAppServices(d.editorRefArray);
	const { attachScrollListener, forceSyncToPane } = useSynchronizedScrolling(
		d.editorRefArray,
		d.diffsRef,
		d.diffsAreReversedRef,
		d.setRenderTrigger,
		d.smoothScrolling,
	);

	const prevB = [
		usePreviousNonNull(d.files[0]),
		usePreviousNonNull(d.files[4]),
	] as const;
	const prevD = [
		usePreviousNonNull(d.diffs[0]),
		usePreviousNonNull(d.diffs[3]),
	] as const;
	const commitModelUpdate = useCommitModelUpdate({
		filesRef: d.filesRef,
		diffsRef: d.diffsRef,
		setFiles: d.setFiles,
		setDiffs: d.setDiffs,
		setRenderTrigger: d.setRenderTrigger,
		differRef: d.differRef,
	});

	useAppMessageHandlers({
		filesRef: d.filesRef,
		diffsRef: d.diffsRef,
		setFiles: d.setFiles,
		setDiffs: d.setDiffs,
		setExternalSyncId: d.setExternalSyncId,
		setDebounceDelay: d.setDebounceDelay,
		setSyntaxHighlighting: d.setSyntaxHighlighting,
		setBaseCompareHighlighting: d.setBaseCompareHighlighting,
		setSmoothScrolling: d.setSmoothScrolling,
		setRenderTrigger: d.setRenderTrigger,
		commitModelUpdate,
		resolveClipboardRead: s.resolveClipboardRead,
		vscodeApi: s.vscodeApi,
		differRef: d.differRef,
	});

	const { renderBL, renderBR } = useBaseAnimation(d.files);
	const uiState = useMemo(
		() => ({
			files: d.files,
			diffs: d.diffs,
			prevBaseLeft: prevB[0],
			prevBaseRight: prevB[1],
			prevBaseLeftDiffs: prevD[0],
			prevBaseRightDiffs: prevD[1],
			renderBaseLeft: renderBL,
			renderBaseRight: renderBR,
			baseCompareHighlighting: d.baseCompareHighlighting,
			renderTrigger: d.renderTrigger,
			syntaxHighlighting: d.syntaxHighlighting,
			externalSyncId: d.externalSyncId,
			editorRefArray: d.editorRefArray,
		}),
		[
			d.files,
			d.diffs,
			prevB,
			prevD,
			renderBL,
			renderBR,
			d.baseCompareHighlighting,
			d.renderTrigger,
			d.syntaxHighlighting,
			d.externalSyncId,
			d.editorRefArray,
		],
	);

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
		attachScrollListener,
		forceSyncToPane,
		chunkActions,
		handleNavigate,
		highlights,
		requestClipboardText: s.requestClipboardText,
		writeClipboardText: s.writeClipboardText,
		commitModelUpdate,
		debounceDelay: d.debounceDelay,
	});

	return { files: d.files, uiState, uiActions };
};

export const App: FC = () => {
	const { files, uiState, uiActions } = useAppState();

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
