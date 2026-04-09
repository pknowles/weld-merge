// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	type FC,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GitGraph } from "./GitGraph.tsx";
import type { CommitInfo } from "./types.ts";

interface VsCodeApi {
	postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface AppState {
	name: string;
	base: string;
	local: string;
	remote: string;
	commits: CommitInfo[];
	searchResults: CommitInfo[];
	selected: string;
	loading: boolean;
	error?: string;
}

const CommitItem: FC<{
	c: CommitInfo;
	isLocal: boolean;
	isRemote: boolean;
	onSelect: (sha: string) => void;
}> = ({ c, isLocal, isRemote, onSelect }) => (
	<button
		key={c.hash}
		type="button"
		style={{
			display: "flex",
			flexDirection: "column",
			width: "100%",
			padding: "8px 12px",
			textAlign: "left",
			backgroundColor: "transparent",
			border: "none",
			color: "inherit",
			cursor: "pointer",
			borderBottom: "1px solid var(--vscode-panel-border)",
		}}
		onClick={() => onSelect(c.hash)}
		onMouseEnter={(e) => {
			(e.currentTarget as HTMLButtonElement).style.backgroundColor =
				"var(--vscode-list-hoverBackground)";
		}}
		onMouseLeave={(e) => {
			(e.currentTarget as HTMLButtonElement).style.backgroundColor =
				"transparent";
		}}
	>
		<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
			{isLocal && (
				<span
					style={{
						backgroundColor:
							"var(--vscode-gitDecoration-addedResourceForeground)",
						color: "#fff",
						padding: "1px 4px",
						borderRadius: "2px",
						fontSize: "0.7em",
						fontWeight: "bold",
					}}
				>
					LOCAL
				</span>
			)}
			{isRemote && (
				<span
					style={{
						backgroundColor:
							"var(--vscode-gitDecoration-modifiedResourceForeground)",
						color: "#fff",
						padding: "1px 4px",
						borderRadius: "2px",
						fontSize: "0.7em",
						fontWeight: "bold",
					}}
				>
					REMOTE
				</span>
			)}
			<span style={{ fontWeight: "bold", fontSize: "0.9em" }}>
				{c.subject}
			</span>
		</div>
		<span style={{ fontSize: "0.8em", opacity: 0.7 }}>
			{c.shortHash} • {c.authorName}
		</span>
	</button>
);

const CommitList: FC<{
	items: CommitInfo[];
	localSha: string;
	remoteSha: string;
	onSelect: (sha: string) => void;
}> = ({ items, localSha, remoteSha, onSelect }) => {
	const elements: ReactNode[] = [];
	for (const c of items) {
		elements.push(
			<CommitItem
				key={c.hash}
				c={c}
				isLocal={c.hash === localSha}
				isRemote={c.hash === remoteSha}
				onSelect={onSelect}
			/>,
		);
	}
	return <>{elements}</>;
};

const SearchOverlay: FC<{
	results: CommitInfo[];
	localSha: string;
	remoteSha: string;
	isOpen: boolean;
	onSelect: (sha: string) => void;
}> = ({ results, localSha, remoteSha, isOpen, onSelect }) => {
	if (!isOpen || results.length === 0) {
		return null;
	}

	return (
		<div
			style={{
				position: "absolute",
				top: "100%",
				left: 0,
				right: 0,
				zIndex: 100,
				backgroundColor: "var(--vscode-dropdown-background)",
				border: "1px solid var(--vscode-dropdown-border)",
				maxHeight: "300px",
				overflowY: "auto",
				boxShadow: "0 4px 8px rgba(0,0,0,0.5)",
				borderRadius: "0 0 4px 4px",
				marginTop: "1px",
				color: "var(--vscode-dropdown-foreground)",
			}}
		>
			<CommitList
				items={results}
				localSha={localSha}
				remoteSha={remoteSha}
				onSelect={onSelect}
			/>
		</div>
	);
};

const Header: FC<{
	submoduleName: string;
	onStage: () => void;
	canStage: boolean;
	commits: CommitInfo[];
	localSha: string;
	remoteSha: string;
	selectedCommit: CommitInfo | undefined;
	onSelect: (sha: string) => void;
	onSearch: (query: string) => void;
}> = ({
	submoduleName,
	onStage,
	canStage,
	commits,
	localSha,
	remoteSha,
	selectedCommit,
	onSelect,
	onSearch,
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const [q, setQ] = useState("");
	const searchRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const trimmed = q.trim();
		if (trimmed.length < 3) {
			return;
		}
		const timer = setTimeout(() => {
			onSearch(trimmed);
		}, 500);
		return () => {
			clearTimeout(timer);
		};
	}, [q, onSearch]);

	const sortedCommits = useMemo(() => {
		const filtered = q
			? commits.filter(
					(c) =>
						c.subject.toLowerCase().includes(q.toLowerCase()) ||
						c.hash.includes(q),
				)
			: commits;
		const local = filtered.filter((c) => c.hash === localSha);
		const remote = filtered.filter(
			(c) => c.hash === remoteSha && c.hash !== localSha,
		);
		const others = filtered.filter(
			(c) => c.hash !== localSha && c.hash !== remoteSha,
		);
		return [...local, ...remote, ...others];
	}, [commits, localSha, remoteSha, q]);

	useEffect(() => {
		const handleClickAway = (e: MouseEvent) => {
			if (
				searchRef.current &&
				!searchRef.current.contains(e.target as Node)
			) {
				setIsOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickAway);
		return () => document.removeEventListener("mousedown", handleClickAway);
	}, []);

	return (
		<div
			style={{
				padding: "10px",
				borderBottom: "1px solid var(--vscode-panel-border)",
				display: "flex",
				flexDirection: "column",
				gap: "8px",
			}}
		>
			<h2 style={{ margin: 0, fontSize: "1.05em", fontWeight: "normal" }}>
				Resolve:{" "}
				<span style={{ fontWeight: "bold" }}>{submoduleName}</span>
			</h2>
			<div
				style={{ display: "flex", gap: "4px", position: "relative" }}
				ref={searchRef}
			>
				<input
					type="text"
					placeholder="Select commit..."
					value={
						isOpen
							? q
							: selectedCommit
								? `${selectedCommit.shortHash} - ${selectedCommit.subject}`
								: ""
					}
					style={{
						flex: 1,
						backgroundColor: "var(--vscode-input-background)",
						color: "var(--vscode-input-foreground)",
						border: "1px solid var(--vscode-input-border)",
						padding: "4px 8px",
					}}
					onChange={(e) => {
						setQ(e.target.value);
						setIsOpen(true);
					}}
					onFocus={() => {
						setQ("");
						setIsOpen(true);
					}}
				/>
				<SearchOverlay
					results={sortedCommits}
					localSha={localSha}
					remoteSha={remoteSha}
					isOpen={isOpen}
					onSelect={(sha) => {
						onSelect(sha);
						setIsOpen(false);
					}}
				/>
				<button
					type="button"
					onClick={onStage}
					disabled={!canStage}
					style={{
						backgroundColor: "var(--vscode-button-background)",
						color: "var(--vscode-button-foreground)",
						border: "none",
						padding: "4px 12px",
						cursor: canStage ? "pointer" : "default",
						opacity: canStage ? 1 : 0.5,
					}}
				>
					Stage
				</button>
			</div>
		</div>
	);
};

const FileItem: FC<{
	file: { path: string; status: string };
	onDiff: (path: string) => void;
}> = ({ file, onDiff }) => (
	<button
		key={file.path}
		type="button"
		onClick={() => onDiff(file.path)}
		style={{
			display: "block",
			textAlign: "left",
			width: "100%",
			border: "none",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			padding: "4px 0",
		}}
		onMouseEnter={(e) =>
			(e.currentTarget.style.textDecoration = "underline")
		}
		onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
	>
		<span
			style={{
				color: "var(--vscode-gitDecoration-addedResourceForeground)",
				marginRight: "8px",
			}}
		>
			{file.status}
		</span>
		{file.path}
	</button>
);

const FileList: FC<{
	files: { path: string; status: string }[];
	onDiff: (path: string) => void;
}> = ({ files, onDiff }) => {
	const elements: ReactNode[] = [];
	for (const f of files) {
		elements.push(<FileItem key={f.path} file={f} onDiff={onDiff} />);
	}
	return <>{elements}</>;
};

const CommitDetail: FC<{
	commit: CommitInfo | undefined;
	onDiff: (filePath: string) => void;
}> = ({ commit, onDiff }) => {
	if (!commit) {
		return (
			<div
				style={{
					flex: 1,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					height: "100%",
					opacity: 0.5,
				}}
			>
				Select a commit
			</div>
		);
	}

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					padding: "15px",
					borderBottom: "1px solid var(--vscode-panel-border)",
					backgroundColor: "rgba(0,0,0,0.05)",
				}}
			>
				<h3 style={{ margin: "0 0 10px 0" }}>{commit.subject}</h3>
				<p style={{ opacity: 0.7, fontSize: "0.8em", margin: "4px 0" }}>
					{commit.authorName} on{" "}
					{commit.authorDate
						? new Date(commit.authorDate).toLocaleString()
						: "N/A"}
				</p>
				<p
					style={{
						opacity: 0.5,
						fontSize: "0.75em",
						fontFamily: "monospace",
						margin: "4px 0",
					}}
				>
					{commit.hash}
				</p>
			</div>
			<div
				style={{
					flex: 1,
					overflowY: "auto",
					padding: "15px",
					scrollbarWidth: "thin",
				}}
			>
				{commit.message &&
				commit.message.trim() !== commit.subject.trim() ? (
					<pre
						style={{
							whiteSpace: "pre-wrap",
							fontFamily: "var(--vscode-editor-font-family)",
						}}
					>
						{commit.message}
					</pre>
				) : (
					<p
						style={{
							opacity: 0.4,
							fontSize: "0.9em",
							fontStyle: "italic",
						}}
					>
						No additional message
					</p>
				)}
				<div style={{ marginTop: "15px" }}>
					<h4 style={{ opacity: 0.6, fontSize: "0.8em" }}>
						Changed Files:
					</h4>
					<FileList files={commit.files || []} onDiff={onDiff} />
				</div>
			</div>
		</div>
	);
};

function useSubmoduleAppLogic(vscode: VsCodeApi) {
	const [state, setState] = useState<AppState>({
		name: "",
		base: "",
		local: "",
		remote: "",
		commits: [],
		searchResults: [],
		selected: "",
		loading: true,
	});
	const [splitPos, setSplitPos] = useState(500);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const msg = event.data;
			if (msg.command === "init") {
				setState((s) => ({
					...s,
					name: msg.submoduleName,
					base: msg.base || "",
					local: msg.local || "",
					remote: msg.remote || "",
					commits: msg.commits || [],
					selected: msg.local || (msg.commits?.[0]?.hash ?? ""),
					loading: false,
				}));
			} else if (msg.command === "searchResults") {
				setState((s) => ({ ...s, searchResults: msg.commits }));
			} else if (msg.command === "commitInfo") {
				setState((s) => ({
					...s,
					commits: s.commits.map((c) =>
						c.hash === msg.hash ? { ...c, files: msg.files } : c,
					),
					searchResults: s.searchResults.map((c) =>
						c.hash === msg.hash ? { ...c, files: msg.files } : c,
					),
				}));
			} else if (msg.command === "error") {
				setState((s) => ({
					...s,
					error: msg.message,
					loading: false,
				}));
			}
		};
		window.addEventListener("message", handleMessage);
		vscode.postMessage({ command: "ready" });
		return () => window.removeEventListener("message", handleMessage);
	}, [vscode]);

	useEffect(() => {
		if (state.selected) {
			const all = [...state.commits, ...state.searchResults];
			const c = all.find((x) => x.hash === state.selected);
			if (c && !c.files) {
				vscode.postMessage({
					command: "getCommitFiles",
					sha: state.selected,
				});
			}
		}
	}, [state.selected, state.commits, state.searchResults, vscode]);

	return { state, setState, splitPos, setSplitPos };
}

const Sidebar: FC<{
	state: AppState;
	setState: React.Dispatch<React.SetStateAction<AppState>>;
	vscode: VsCodeApi;
	width: number;
}> = ({ state, setState, vscode, width }) => {
	const allCommits = useMemo(() => {
		const map = new Map(state.commits.map((c) => [c.hash, c]));
		for (const c of state.searchResults) {
			if (!map.has(c.hash)) {
				map.set(c.hash, c);
			}
		}
		return Array.from(map.values());
	}, [state.commits, state.searchResults]);
	const selectedCommit = useMemo(
		() => allCommits.find((c) => c.hash === state.selected),
		[allCommits, state.selected],
	);

	const onSelect = useCallback(
		(sha: string) => setState((s) => ({ ...s, selected: sha })),
		[setState],
	);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width: `${width}px`,
				minWidth: "300px",
				borderRight: "1px solid var(--vscode-panel-border)",
				overflow: "hidden",
			}}
		>
			<Header
				submoduleName={state.name}
				onStage={() =>
					vscode.postMessage({
						command: "stageCommit",
						sha: state.selected,
					})
				}
				canStage={Boolean(state.selected)}
				commits={allCommits}
				localSha={state.local}
				remoteSha={state.remote}
				selectedCommit={selectedCommit}
				onSelect={onSelect}
				onSearch={(query) =>
					vscode.postMessage({ command: "searchCommits", query })
				}
			/>
			<div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
				<GitGraph
					commits={state.commits}
					localSha={state.local}
					remoteSha={state.remote}
					baseSha={state.base}
					selectedSha={state.selected}
					onSelect={onSelect}
				/>
			</div>
		</div>
	);
};

const Details: FC<{ commit: CommitInfo | undefined; vscode: VsCodeApi }> = ({
	commit,
	vscode,
}) => (
	<div style={{ flex: 1, overflow: "hidden" }}>
		<CommitDetail
			commit={commit}
			onDiff={(filePath) =>
				vscode.postMessage({
					command: "showFileDiff",
					subSha: commit?.hash || "",
					parentSha: commit?.parents?.[0] || "",
					filePath,
				})
			}
		/>
	</div>
);

const MainLayout: FC<{
	splitPos: number;
	setSplitPos: (p: number) => void;
	state: AppState;
	setState: React.Dispatch<React.SetStateAction<AppState>>;
	vscode: VsCodeApi;
}> = ({ splitPos, setSplitPos, state, setState, vscode }) => {
	const allCommits = useMemo(() => {
		const map = new Map(state.commits.map((c) => [c.hash, c]));
		for (const c of state.searchResults) {
			if (!map.has(c.hash)) {
				map.set(c.hash, c);
			}
		}
		return Array.from(map.values());
	}, [state.commits, state.searchResults]);
	const selectedCommit = useMemo(
		() => allCommits.find((c) => c.hash === state.selected),
		[allCommits, state.selected],
	);

	const onMouseDown = useCallback(() => {
		const onMouseMove = (e: MouseEvent) => {
			setSplitPos(e.clientX);
		};
		const onMouseUp = () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
	}, [setSplitPos]);

	return (
		<div
			style={{
				display: "flex",
				height: "100%",
				backgroundColor: "var(--vscode-editor-background)",
				color: "var(--vscode-editor-foreground)",
				fontFamily: "var(--vscode-font-family)",
				fontSize: "var(--vscode-font-size)",
				overflow: "hidden",
			}}
		>
			<Sidebar
				state={state}
				setState={setState}
				vscode={vscode}
				width={splitPos}
			/>
			<hr
				onMouseDown={onMouseDown}
				style={{
					width: "6px",
					cursor: "col-resize",
					border: "none",
					backgroundColor: "transparent",
					margin: 0,
					transition: "background-color 0.1s",
				}}
				onMouseEnter={(e) =>
					(e.currentTarget.style.backgroundColor =
						"var(--vscode-focusBorder)")
				}
				onMouseLeave={(e) =>
					(e.currentTarget.style.backgroundColor = "transparent")
				}
			/>
			<Details commit={selectedCommit} vscode={vscode} />
		</div>
	);
};

export const SubmoduleApp: FC = () => {
	const vscode = useMemo(() => acquireVsCodeApi(), []);
	const { state, setState, splitPos, setSplitPos } =
		useSubmoduleAppLogic(vscode);
	if (state.error) {
		return (
			<div
				style={{
					padding: "20px",
					color: "var(--vscode-errorForeground)",
					display: "flex",
					flexDirection: "column",
					gap: "10px",
				}}
			>
				<h3 style={{ margin: 0 }}>Error</h3>
				<p style={{ margin: 0 }}>{state.error}</p>
			</div>
		);
	}
	if (state.loading && state.commits.length === 0) {
		return <div style={{ padding: "20px" }}>Loading...</div>;
	}
	return (
		<MainLayout
			splitPos={splitPos}
			setSplitPos={setSplitPos}
			state={state}
			setState={setState}
			vscode={vscode}
		/>
	);
};
