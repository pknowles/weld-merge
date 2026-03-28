// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	type Dispatch,
	type FC,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { GitGraph } from "./GitGraph.tsx";
import type {
	ChangedFile,
	CommitInfo,
	HostMessage,
	SubmoduleConflictSnapshot,
	VsCodeApi,
} from "./types.ts";

declare function acquireVsCodeApi(): VsCodeApi;

interface AppState {
	snapshot: SubmoduleConflictSnapshot | null;
	searchResults: CommitInfo[];
	selectedSha: string;
	loading: boolean;
	error: string | null;
	conflictLost: string | null;
}

function hasCommand(value: unknown): value is { command: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"command" in value &&
		typeof value.command === "string"
	);
}

function isHostMessage(value: unknown): value is HostMessage {
	if (!hasCommand(value)) {
		return false;
	}
	return [
		"snapshot",
		"conflictLost",
		"searchResults",
		"commitFiles",
		"staged",
		"error",
	].includes(value.command);
}

function mergeCommitFiles(
	commits: CommitInfo[],
	sha: string,
	files: ChangedFile[],
): CommitInfo[] {
	return commits.map((commit) =>
		commit.hash === sha ? { ...commit, files } : commit,
	);
}

function applyHostMessage(
	message: HostMessage,
	setState: Dispatch<SetStateAction<AppState>>,
): void {
	switch (message.command) {
		case "snapshot":
			setState({
				snapshot: message.snapshot,
				searchResults: [],
				selectedSha: message.snapshot.selected,
				loading: false,
				error: null,
				conflictLost: null,
			});
			break;
		case "conflictLost":
			setState((current) => ({
				...current,
				loading: false,
				conflictLost: message.message,
			}));
			break;
		case "searchResults":
			setState((current) => ({
				...current,
				searchResults: message.commits,
			}));
			break;
		case "commitFiles":
			setState((current) => ({
				...current,
				snapshot: current.snapshot
					? {
							...current.snapshot,
							commits: mergeCommitFiles(
								current.snapshot.commits,
								message.sha,
								message.files,
							),
						}
					: null,
				searchResults: mergeCommitFiles(
					current.searchResults,
					message.sha,
					message.files,
				),
			}));
			break;
		case "staged":
			setState((current) => ({
				...current,
				conflictLost: "Submodule conflict was staged.",
			}));
			break;
		case "error":
			setState((current) => ({
				...current,
				loading: false,
				error: message.message,
			}));
			break;
		default:
			break;
	}
}

function useHostMessages(
	vscode: VsCodeApi,
	setState: Dispatch<SetStateAction<AppState>>,
): void {
	useEffect(() => {
		const handleMessage = (event: MessageEvent<unknown>) => {
			if (isHostMessage(event.data)) {
				applyHostMessage(event.data, setState);
			}
		};
		window.addEventListener("message", handleMessage);
		vscode.postMessage({ command: "ready" });
		return () => window.removeEventListener("message", handleMessage);
	}, [setState, vscode]);
}

function useSubmoduleState(vscode: VsCodeApi): {
	state: AppState;
	selectSha: (sha: string) => void;
	search: (query: string) => void;
	loadFiles: (sha: string) => void;
	stage: () => void;
	showDiff: (filePath: string) => void;
	commits: CommitInfo[];
} {
	const [state, setState] = useState<AppState>({
		snapshot: null,
		searchResults: [],
		selectedSha: "",
		loading: true,
		error: null,
		conflictLost: null,
	});

	useHostMessages(vscode, setState);

	// Snapshot and search results use null files for "not loaded yet"; an empty
	// array means the commit really has no changed files.
	const allCommits = useMemo(() => {
		const byHash = new Map<string, CommitInfo>();
		if (state.snapshot) {
			for (const commit of state.snapshot.commits) {
				byHash.set(commit.hash, commit);
			}
		}
		for (const commit of state.searchResults) {
			byHash.set(commit.hash, commit);
		}
		return Array.from(byHash.values());
	}, [state.snapshot, state.searchResults]);

	const selectSha = useCallback((sha: string) => {
		setState((current) => ({ ...current, selectedSha: sha }));
	}, []);
	const search = useCallback(
		(query: string) =>
			vscode.postMessage({ command: "searchCommits", query }),
		[vscode],
	);
	const loadFiles = useCallback(
		(sha: string) =>
			vscode.postMessage({ command: "loadCommitFiles", sha }),
		[vscode],
	);
	const stage = useCallback(() => {
		if (state.selectedSha) {
			vscode.postMessage({
				command: "stageCommit",
				sha: state.selectedSha,
			});
		}
	}, [state.selectedSha, vscode]);
	const showDiff = useCallback(
		(filePath: string) => {
			if (state.selectedSha) {
				vscode.postMessage({
					command: "showFileDiff",
					sha: state.selectedSha,
					filePath,
				});
			}
		},
		[state.selectedSha, vscode],
	);

	useEffect(() => {
		if (!state.selectedSha) {
			return;
		}
		const commit = allCommits.find(
			(candidate) => candidate.hash === state.selectedSha,
		);
		if (commit && commit.files === null) {
			loadFiles(commit.hash);
		}
	}, [allCommits, loadFiles, state.selectedSha]);

	return {
		state,
		selectSha,
		search,
		loadFiles,
		stage,
		showDiff,
		commits: allCommits,
	};
}

const Header: FC<{
	snapshot: SubmoduleConflictSnapshot;
	selected: CommitInfo | undefined;
	canStage: boolean;
	onSearch: (query: string) => void;
	onSelect: (sha: string) => void;
	onStage: () => void;
	commits: CommitInfo[];
}> = ({
	snapshot,
	selected,
	canStage,
	onSearch,
	onSelect,
	onStage,
	commits,
}) => {
	const [query, setQuery] = useState("");
	const [isOpen, setIsOpen] = useState(false);
	const visibleCommits = useMemo(() => {
		const lower = query.toLowerCase();
		if (!lower) {
			return commits.slice(0, 12);
		}
		return commits
			.filter(
				(commit) =>
					commit.subject.toLowerCase().includes(lower) ||
					commit.hash.startsWith(lower),
			)
			.slice(0, 20);
	}, [commits, query]);
	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed.length < 3) {
			return;
		}
		const timer = setTimeout(() => onSearch(trimmed), 350);
		return () => clearTimeout(timer);
	}, [onSearch, query]);

	return (
		<header className="submodule-header">
			<h1>
				Resolve: <strong>{snapshot.submodulePath}</strong>
			</h1>
			<div className="submodule-search">
				<input
					value={
						isOpen
							? query
							: selected
								? `${selected.shortHash} - ${selected.subject}`
								: ""
					}
					onChange={(event) => {
						setQuery(event.currentTarget.value);
						setIsOpen(true);
					}}
					onFocus={() => {
						setQuery("");
						setIsOpen(true);
					}}
					onBlur={() => setTimeout(() => setIsOpen(false), 100)}
					placeholder="Select commit"
				/>
				<button type="button" disabled={!canStage} onClick={onStage}>
					Stage
				</button>
				{isOpen && visibleCommits.length > 0 && (
					<div className="submodule-search-results">
						{visibleCommits.map((commit) => (
							<button
								type="button"
								key={commit.hash}
								onClick={() => {
									onSelect(commit.hash);
									setQuery("");
								}}
							>
								<strong>{commit.shortHash}</strong>
								<span>{commit.subject}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</header>
	);
};

const Details: FC<{
	commit: CommitInfo | undefined;
	onDiff: (filePath: string) => void;
}> = ({ commit, onDiff }) => {
	if (!commit) {
		return (
			<section className="submodule-details muted">
				Select a commit.
			</section>
		);
	}
	return (
		<section className="submodule-details">
			<h2>{commit.subject}</h2>
			<p className="muted">
				{commit.authorName} {commit.authorDate}
			</p>
			<p className="hash">{commit.hash}</p>
			{commit.message ? <pre>{commit.message}</pre> : null}
			<h3>Changed Files</h3>
			{commit.files === null ? (
				<p className="muted">Loading files...</p>
			) : commit.files.length === 0 ? (
				<p className="muted">No files changed.</p>
			) : (
				<div className="file-list">
					{commit.files.map((file) => (
						<button
							type="button"
							key={`${file.status}:${file.path}`}
							onClick={() => onDiff(file.path)}
						>
							<span>{file.status}</span>
							{file.path}
						</button>
					))}
				</div>
			)}
		</section>
	);
};

const AppContent: FC<{
	state: AppState;
	actions: ReturnType<typeof useSubmoduleState>;
}> = ({ state, actions }) => {
	const [sidebarWidth, setSidebarWidth] = useState(500);
	const startResize = useCallback(() => {
		const resize = (event: MouseEvent) => {
			const maxWidth = Math.max(320, window.innerWidth - 320);
			setSidebarWidth(Math.min(Math.max(event.clientX, 300), maxWidth));
		};
		const stopResize = () => {
			document.removeEventListener("mousemove", resize);
			document.removeEventListener("mouseup", stopResize);
		};
		document.addEventListener("mousemove", resize);
		document.addEventListener("mouseup", stopResize);
	}, []);
	if (state.loading) {
		return <main className="status-page">Loading...</main>;
	}
	if (state.error) {
		return <main className="status-page error">{state.error}</main>;
	}
	if (state.conflictLost && !state.snapshot) {
		return <main className="status-page error">{state.conflictLost}</main>;
	}
	if (!state.snapshot) {
		return (
			<main className="status-page error">No submodule snapshot.</main>
		);
	}
	const selected = actions.commits.find(
		(commit) => commit.hash === state.selectedSha,
	);
	return (
		<main className="submodule-app">
			{state.conflictLost ? (
				<div className="conflict-lost">{state.conflictLost}</div>
			) : null}
			<div
				className="submodule-body"
				style={{
					gridTemplateColumns: `${sidebarWidth}px 6px minmax(280px, 1fr)`,
				}}
			>
				<section className="submodule-sidebar">
					<Header
						snapshot={state.snapshot}
						selected={selected}
						canStage={
							!state.conflictLost && Boolean(state.selectedSha)
						}
						onSearch={actions.search}
						onSelect={actions.selectSha}
						onStage={actions.stage}
						commits={actions.commits}
					/>
					<GitGraph
						commits={state.snapshot.commits}
						baseSha={state.snapshot.base}
						localSha={state.snapshot.local}
						remoteSha={state.snapshot.remote}
						selectedSha={state.selectedSha}
						onSelect={actions.selectSha}
					/>
				</section>
				<hr className="submodule-resizer" onMouseDown={startResize} />
				<Details commit={selected} onDiff={actions.showDiff} />
			</div>
		</main>
	);
};

export const SubmoduleApp: FC = () => {
	const vscode = useMemo(() => acquireVsCodeApi(), []);
	const actions = useSubmoduleState(vscode);
	return <AppContent state={actions.state} actions={actions} />;
};
