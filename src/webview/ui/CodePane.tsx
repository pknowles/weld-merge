import Editor from "@monaco-editor/react";
import { editor, KeyCode, KeyMod, Selection } from "monaco-editor";
import {
	type CSSProperties,
	type FC,
	type FocusEvent,
	type MouseEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { computeMinimalEdits } from "./editorUtil.ts";
import type { MeldUIActions, MeldUIState } from "./meldPaneTypes.ts";
import type { Commit, FileState, Highlight } from "./types.ts";

const NEWLINE_REGEX = /\r?\n/;

interface CodePaneProps {
	file: FileState;
	index: number;
	ui: MeldUIState;
	actions: MeldUIActions;
	isMiddle: boolean;
	highlights?: Highlight[] | undefined;
	onToggleBase?: (() => void) | undefined;
	baseSide?: "left" | "right" | undefined;
	isBaseActive?: boolean | undefined;
	style?: CSSProperties | undefined;
	onMount: (ed: editor.IStandaloneCodeEditor, i: number) => void;
}

const CommitHover: FC<{
	commit: Commit;
	pos: { x: number; y: number };
	hoverRef: React.RefObject<HTMLDivElement | null>;
	onCopyHash: (e: MouseEvent) => void;
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
}> = ({ commit, pos, hoverRef, onCopyHash, onMouseEnter, onMouseLeave }) => (
	<div
		ref={hoverRef}
		onMouseEnter={onMouseEnter}
		onMouseLeave={onMouseLeave}
		role="tooltip"
		style={{
			position: "fixed",
			top: pos.y,
			left: pos.x,
			zIndex: 1000,
			backgroundColor: "var(--vscode-editorWidget-background, #252526)",
			border: "1px solid var(--vscode-widget-border, #454545)",
			borderRadius: "6px",
			padding: "16px",
			width: "350px",
			boxShadow: "0 4px 10px rgba(0, 0, 0, 0.2)",
			color: "var(--vscode-editor-foreground, #cccccc)",
			fontSize: "13px",
			fontFamily: "var(--vscode-font-family, sans-serif)",
			pointerEvents: "auto",
			textAlign: "left",
			lineHeight: 1.4,
			userSelect: "text",
			cursor: "auto",
		}}
	>
		<div style={{ fontWeight: 600, marginBottom: "8px", fontSize: "14px" }}>
			{commit.title}
		</div>
		<div style={{ opacity: 0.8, marginBottom: "4px" }}>
			<strong>{commit.authorName}</strong> &lt;{commit.authorEmail}&gt;
		</div>
		<div style={{ opacity: 0.8, marginBottom: "12px" }}>
			{new Date(commit.date).toLocaleString()}
		</div>
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: "8px",
				backgroundColor:
					"var(--vscode-textCodeBlock-background, #1e1e1e)",
				padding: "4px 8px",
				borderRadius: "4px",
				marginBottom: "12px",
			}}
		>
			<span
				style={{
					fontFamily: "var(--vscode-editor-font-family, monospace)",
				}}
			>
				{commit.hash.substring(0, 8)}
			</span>
			<button
				type="button"
				onClick={onCopyHash}
				title="Copy Hash"
				style={{
					background: "none",
					border: "none",
					color: "var(--vscode-textLink-foreground, #3794ff)",
					cursor: "pointer",
					marginLeft: "auto",
					padding: "4px",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 16 16"
					fill="currentColor"
				>
					<title>Copy Hash</title>
					<path
						fillRule="evenodd"
						clipRule="evenodd"
						d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H6v10h6V7z"
					/>
					<path
						fillRule="evenodd"
						clipRule="evenodd"
						d="M3 1L2 2v10h2V3h6V1H3z"
					/>
				</svg>
			</button>
		</div>
		{commit.body && (
			<pre
				style={{
					marginTop: "0",
					borderTop: "1px solid var(--vscode-widget-border, #454545)",
					paddingTop: "12px",
					whiteSpace: "pre-wrap",
					fontFamily: "var(--vscode-editor-font-family, monospace)",
					margin: 0,
				}}
			>
				{commit.body}
			</pre>
		)}
	</div>
);

const CommitInfo: FC<{
	commit: Commit;
	onCopyHash?: (hash: string) => void;
	onShowDiff?: () => void;
}> = ({ commit, onCopyHash, onShowDiff }) => {
	const [showHover, setShowHover] = useState(false);
	const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
	const hoverRef = useRef<HTMLDivElement>(null);
	const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
	const onEnter = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
		}
		const r = e.currentTarget.getBoundingClientRect();
		const x = Math.min(
			Math.max(8, r.left - 20),
			Math.max(8, window.innerWidth - 370),
		);
		const y =
			r.bottom + 254 > window.innerHeight - 20 && r.top - 254 > 8
				? r.top - 254
				: r.bottom + 4;
		setHoverPos({ x, y });
		setShowHover(true);
	};
	const onLeave = () => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
		}
		hoverTimerRef.current = setTimeout(() => {
			setShowHover(false);
		}, 300);
	};
	const onHoverStay = () => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
		}
	};
	return (
		<>
			<button
				type="button"
				style={{
					position: "relative",
					background: "none",
					border: "none",
					padding: 0,
					margin: "0 8px",
					color: "inherit",
					font: "inherit",
					display: "inline-block",
					cursor: "pointer",
					opacity: 0.7,
					textDecoration: "underline",
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
				}}
				onClick={() => onShowDiff?.()}
				onMouseEnter={onEnter}
				onMouseLeave={onLeave}
				onFocus={onEnter}
				onBlur={onLeave}
			>
				[{commit.title}]
			</button>
			{showHover && (
				<CommitHover
					commit={commit}
					pos={hoverPos}
					hoverRef={hoverRef}
					onCopyHash={(e) => {
						e.stopPropagation();
						onCopyHash?.(commit.hash);
					}}
					onMouseEnter={onHoverStay}
					onMouseLeave={onLeave}
				/>
			)}
		</>
	);
};

const HeaderNav: FC<{ actions: MeldUIActions; index: number }> = ({
	actions,
	index,
}) => {
	if (index !== 2) {
		return null;
	}
	return (
		<div
			style={{
				display: "flex",
				gap: "2px",
				alignItems: "center",
				marginRight: "8px",
			}}
		>
			<button
				type="button"
				className="nav-btn"
				onClick={() => actions.handleNavigate("prev", "diff")}
				title="Previous Diff (Alt+Up)"
			>
				<svg width="16" height="16" viewBox="0 0 16 16">
					<title>Previous Diff</title>
					<path
						fill="currentColor"
						d="M7.414 7L10 9.586L9.586 10L6 6.414L9.586 3L10 3.414L7.414 6H14v1H7.414z"
						transform="rotate(90 8 8)"
					/>
				</svg>
			</button>
			<button
				type="button"
				className="nav-btn"
				onClick={() => actions.handleNavigate("next", "diff")}
				title="Next Diff (Alt+Down)"
			>
				<svg width="16" height="16" viewBox="0 0 16 16">
					<title>Next Diff</title>
					<path
						fill="currentColor"
						d="M7.414 7L10 9.586L9.586 10L6 6.414L9.586 3L10 3.414L7.414 6H14v1H7.414z"
						transform="rotate(-90 8 8)"
					/>
				</svg>
			</button>
			<div
				style={{
					width: "1px",
					height: "16px",
					backgroundColor: "#444",
					margin: "0 4px",
				}}
			/>
			<button
				type="button"
				className="nav-btn nav-btn-conflict"
				onClick={() => actions.handleNavigate("prev", "conflict")}
				title="Previous Conflict (Ctrl+J)"
			>
				<svg width="16" height="16" viewBox="0 0 16 16">
					<title>Previous Conflict</title>
					<path fill="currentColor" d="M8 3.5l-4 4h3V12h2V7.5h3z" />
					<path
						fill="currentColor"
						opacity="0.5"
						d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7-6a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"
					/>
				</svg>
			</button>
			<button
				type="button"
				className="nav-btn nav-btn-conflict"
				onClick={() => actions.handleNavigate("next", "conflict")}
				title="Next Conflict (Ctrl+K)"
			>
				<svg width="16" height="16" viewBox="0 0 16 16">
					<title>Next Conflict</title>
					<path fill="currentColor" d="M8 12.5l4-4h-3V4H7v4.5H4z" />
					<path
						fill="currentColor"
						opacity="0.5"
						d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7-6a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"
					/>
				</svg>
			</button>
		</div>
	);
};

const ToggleBaseBtn: FC<{
	isBaseActive: boolean;
	onToggleBase: (() => void) | undefined;
	baseSide: "left" | "right" | undefined;
	side: "left" | "right";
}> = ({ isBaseActive, onToggleBase, baseSide, side }) => {
	if (!onToggleBase || baseSide !== side) {
		return null;
	}
	const path =
		side === "left"
			? "M2 2h12v12H2V2zm-1 0a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm3 1v10h3V3H4z"
			: "M14 2H2v12h12V2zM1 2a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm11 1v10H9V3h3z";
	return (
		<button
			type="button"
			onClick={onToggleBase}
			title="Compare with Base"
			data-testid={`toggle-base-${side}`}
			style={{
				background: "none",
				border: "none",
				color: isBaseActive
					? "var(--vscode-textLink-foreground, #3794ff)"
					: "inherit",
				cursor: "pointer",
				display: "flex",
				alignItems: "center",
				padding: "4px",
				[side === "left" ? "marginRight" : "marginLeft"]: "8px",
				opacity: isBaseActive ? 1 : 0.6,
			}}
		>
			<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
				<title>Compare with Base</title>
				<path fillRule="evenodd" clipRule="evenodd" d={path} />
			</svg>
		</button>
	);
};

const HeaderStyles = () => (
	<style>
		{
			".nav-btn { background: none; border: none; color: inherit; cursor: pointer; display: flex; alignItems: center; padding: 4px; opacity: 0.6; transition: opacity 0.2s, background-color 0.2s; border-radius: 4px; } .nav-btn:hover { opacity: 1; background-color: rgba(255, 255, 255, 0.1); } .nav-btn-conflict { color: var(--vscode-errorForeground, #f48771); } @keyframes flash-red { 0% { background-color: #2ea043; } 20% { background-color: #f48771; box-shadow: 0 0 10px #f48771; } 100% { background-color: #2ea043; } } .button-flash { animation: flash-red 1s ease-out; }"
		}
	</style>
);

const handleClipboardAction = (
	ed: editor.ICodeEditor,
	type: "copy" | "cut",
	writeText?: (t: string) => void,
) => {
	const s = ed.getSelection();
	const m = ed.getModel();
	if (!s) {
		return;
	}
	if (!m) {
		return;
	}
	const text = s.isEmpty()
		? `${m.getLineContent(s.startLineNumber)}\n`
		: m.getValueInRange(s);
	if (!text) {
		return;
	}
	writeText?.(text);
	if (type === "cut" && !ed.getOption(editor.EditorOption.readOnly)) {
		ed.executeEdits("cut", [
			{
				range: s.isEmpty()
					? new Selection(
							s.startLineNumber,
							1,
							s.startLineNumber + 1,
							1,
						)
					: s,
				text: "",
			},
		]);
	}
};

const setupActions = (ed: editor.IStandaloneCodeEditor, p: CodePaneProps) => {
	ed.addAction({
		id: "custom-copy",
		label: "Copy",
		keybindings: [KeyMod.CtrlCmd | KeyCode.KeyC],
		run: (e) =>
			handleClipboardAction(e, "copy", p.actions.writeClipboardText),
	});
	ed.addAction({
		id: "custom-cut",
		label: "Cut",
		keybindings: [KeyMod.CtrlCmd | KeyCode.KeyX],
		precondition: "!editorReadonly",
		run: (e) =>
			handleClipboardAction(e, "cut", p.actions.writeClipboardText),
	});
	ed.addAction({
		id: "custom-paste",
		label: "Paste",
		keybindings: [KeyMod.CtrlCmd | KeyCode.KeyV],
		run: (e) =>
			p.actions
				.requestClipboardText?.()
				.then((t) => e.trigger("keyboard", "paste", { text: t })),
	});
};

const getHighlightOptions = (h: Highlight) => ({
	isWholeLine: h.isWholeLine,
	className: h.isWholeLine ? `diff-${h.tag}` : null,
	inlineClassName: h.isWholeLine ? null : `diff-${h.tag}-inline`,
	linesDecorationsClassName: h.isWholeLine ? `diff-${h.tag}-margin` : null,
	marginClassName: h.isWholeLine ? `diff-${h.tag}-margin` : null,
});

const useCodePaneLogic = (p: CodePaneProps) => {
	const [ed, setEd] = useState<editor.IStandaloneCodeEditor | null>(null);
	const [lastSyncId, setLastSyncId] = useState(p.ui.externalSyncId);
	const isApplyingSync = useRef(false);
	const [isFlashing, setIsFlashing] = useState(false);
	const decRef = useRef<string[]>([]);

	useEffect(() => {
		if (ed && p.highlights) {
			const nd = p.highlights
				.filter((h) => h.startLine <= h.endLine)
				.map((h) => ({
					range: {
						startLineNumber: h.startLine,
						startColumn: h.startColumn,
						endLineNumber: h.endLine,
						endColumn: h.endColumn,
					},
					options: getHighlightOptions(h),
				}));
			decRef.current = ed.deltaDecorations(decRef.current, nd);
		}
	}, [ed, p.highlights]);

	useEffect(() => {
		if (
			!ed ||
			p.file.content == null ||
			p.ui.externalSyncId === lastSyncId
		) {
			return;
		}

		setLastSyncId(p.ui.externalSyncId);

		if (p.file.content === ed.getValue()) {
			return;
		}

		const m = ed.getModel();
		if (!m) {
			return;
		}

		isApplyingSync.current = true;
		try {
			const e = computeMinimalEdits(m, p.file.content);
			if (e.length > 0) {
				m.pushEditOperations(
					ed.getSelections() || [],
					e,
					() => ed.getSelections() || [],
				);
			}
		} finally {
			isApplyingSync.current = false;
		}
	}, [ed, p.file.content, p.ui.externalSyncId, lastSyncId]);

	const onSubmit = () => {
		if (!ed) {
			return;
		}
		const markers = ["<<<<<<<", "=======", ">>>>>>>", "|||||||"];
		const lines = ed.getValue().split(NEWLINE_REGEX);
		const idx = lines.findIndex(
			(l) => markers.some((m) => l.startsWith(m)) || l.startsWith("(??)"),
		);
		if (idx !== -1) {
			setIsFlashing(true);
			setTimeout(() => {
				setIsFlashing(false);
			}, 1000);
			ed.revealLineInCenter(idx + 1);
			ed.setPosition({ lineNumber: idx + 1, column: 1 });
			ed.focus();
		}
		p.actions.handleCompleteMerge();
	};

	return { ed, setEd, isApplyingSync, isFlashing, onSubmit };
};
const HEADER_STYLE: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	backgroundColor: "#2d2d2d",
	color: "#cccccc",
	padding: "0 8px",
	height: "35px",
	boxSizing: "border-box",
	fontFamily: "sans-serif",
	fontSize: "12px",
	borderBottom: "1px solid #444",
	minWidth: 0,
};

export const CodePane: FC<CodePaneProps> = (p) => {
	const { setEd, isApplyingSync, isFlashing, onSubmit } = useCodePaneLogic(p);

	useEffect(
		() => () => {
			p.ui.editorRefArray.current[p.index] =
				undefined as unknown as editor.IStandaloneCodeEditor;
			p.actions.setRenderTrigger((p) => p + 1);
		},
		[p.index, p.actions.setRenderTrigger, p.ui.editorRefArray],
	);

	return (
		<div
			style={{
				flex: 1,
				display: "flex",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				...p.style,
			}}
		>
			<div style={HEADER_STYLE}>
				<HeaderStyles />
				<ToggleBaseBtn
					side="left"
					isBaseActive={p.isBaseActive ?? false}
					onToggleBase={p.onToggleBase}
					baseSide={p.baseSide}
				/>
				<span style={{ flexShrink: 0 }}>{p.file.label}</span>
				{p.file.commit && (
					<CommitInfo
						commit={p.file.commit}
						onCopyHash={p.actions.handleCopyHash}
						onShowDiff={() => p.actions.handleShowDiff(p.index)}
					/>
				)}
				<div style={{ flex: 1 }} />
				<HeaderNav actions={p.actions} index={p.index} />
				<div style={{ flex: 1 }} />
				<ToggleBaseBtn
					side="right"
					isBaseActive={p.isBaseActive ?? false}
					onToggleBase={p.onToggleBase}
					baseSide={p.baseSide}
				/>
			</div>
			<div style={{ flex: 1, position: "relative", minHeight: 0 }}>
				<Editor
					language={
						p.ui.syntaxHighlighting ? "typescript" : "plaintext"
					}
					defaultValue={p.file.content || ""}
					theme="vs-dark"
					options={useMemo(
						() => ({
							minimap: { enabled: false },
							readOnly: !p.isMiddle,
							scrollBeyondLastLine: false,
							wordWrap: "off",
							renderWhitespace: "all",
							renderLineHighlight: "all",
						}),
						[p.isMiddle],
					)}
					onMount={(e) => {
						setEd(e);
						p.onMount(e, p.index);
						setupActions(e, p);
						if (p.index === 2 && p.ui.files[1] !== null) {
							setTimeout(() => {
								p.actions.handleNavigate("next", "conflict");
							}, 500);
						}
					}}
					onChange={(v) => {
						if (!isApplyingSync.current) {
							if (v !== p.file.content) {
								p.actions.onEditImmediate(p.index);
							}
							p.actions.onEdit(v, p.index);
						}
					}}
				/>
			</div>
			{p.isMiddle && (
				<div
					style={{
						backgroundColor: "#252526",
						padding: "8px 12px",
						borderTop: "1px solid #444",
						display: "flex",
						justifyContent: "flex-start",
						alignItems: "center",
						fontFamily: "sans-serif",
						fontSize: "13px",
					}}
				>
					<button
						type="button"
						className={isFlashing ? "button-flash" : ""}
						onClick={onSubmit}
						style={{
							backgroundColor: "#2ea043",
							color: "white",
							border: "none",
							padding: "6px 12px",
							borderRadius: "4px",
							cursor: "pointer",
							fontWeight: 600,
						}}
					>
						Save & Complete Merge
					</button>
				</div>
			)}
		</div>
	);
};
