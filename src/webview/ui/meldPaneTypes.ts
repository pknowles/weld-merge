import type { editor } from "monaco-editor";
import type { PaneDiffs, PaneFiles } from "./appHooks.ts";
import type {
	DiffChunk,
	FileState,
	Highlight,
	MonacoContentChange,
} from "./types.ts";

export interface MeldUIState {
	files: PaneFiles;
	diffs: PaneDiffs;
	prevBaseLeft: FileState | null;
	prevBaseRight: FileState | null;
	prevBaseLeftDiffs: DiffChunk[] | null;
	prevBaseRightDiffs: DiffChunk[] | null;
	renderBaseLeft: boolean;
	renderBaseRight: boolean;
	baseCompareHighlighting: boolean;
	isConflicted: boolean;
	renderTrigger: number;
	syntaxHighlighting: boolean;
	lastExternalChangeVersion: number;
	editorRefArray: React.MutableRefObject<editor.IStandaloneCodeEditor[]>;
}

export interface MeldUIActions {
	attachScrollListener: (ed: editor.IStandaloneCodeEditor, i: number) => void;
	forceSyncToPane: (target: number, source: number) => void;
	handleApplyChunk: (paneIndex: number, chunk: DiffChunk) => void;
	handleDeleteChunk: (paneIndex: number, chunk: DiffChunk) => void;
	handleCopyUpChunk: (paneIndex: number, chunk: DiffChunk) => void;
	handleCopyDownChunk: (paneIndex: number, chunk: DiffChunk) => void;
	handleCopyHash: (hash: string) => void;
	handleShowDiff: (idx: number) => void;
	handleCompleteMerge: () => void;
	toggleBaseDiff: (side: "left" | "right") => void;
	handleNavigate: (dir: "prev" | "next", type: "diff" | "conflict") => void;
	getHighlights: (idx: number) => Highlight[];
	requestClipboardText: () => Promise<string>;
	writeClipboardText: (text: string) => Promise<void>;
	handleMergedContentChanged: (changes: editor.IModelContentChange[]) => void;
	sendSave: () => void;
	setRenderTrigger: (p: (prev: number) => number) => void;
}

export interface MeldPaneProps {
	idx: number;
	ui: MeldUIState;
	actions: MeldUIActions;
	applyExternalEditsRef?:
		| React.RefObject<{
				applyIncrementalEdits: (changes: MonacoContentChange[]) => void;
				applyFullSync: (content: string) => void;
		  } | null>
		| undefined;
}
