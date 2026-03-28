import { Gitgraph, TemplateName, templateExtend } from "@gitgraph/react";
import { type FC, useLayoutEffect, useMemo, useRef } from "react";
import type { CommitInfo } from "./types.ts";

// Using any for internal types because @gitgraph/react might not export them cleanly
// biome-ignore lint/suspicious/noExplicitAny: library types are problematic
type GitgraphApi = any;
// biome-ignore lint/suspicious/noExplicitAny: library types are problematic
type BranchApi = any;

interface GitGraphProps {
	commits: CommitInfo[];
	localSha: string;
	remoteSha: string;
	baseSha: string;
	selectedSha: string;
	onSelect: (sha: string) => void;
}

const customTemplate = templateExtend(TemplateName.Metro, {
	colors: [
		"var(--vscode-charts-blue)",
		"var(--vscode-charts-purple)",
		"var(--vscode-charts-orange)",
		"var(--vscode-charts-green)",
		"var(--vscode-charts-red)",
	],
	commit: {
		message: {
			displayHash: false,
			displayAuthor: false,
		},
		dot: {
			size: 10,
		},
	},
});

const calculateChildCounts = (
	commits: CommitInfo[],
	baseSha: string,
	localSha: string,
	remoteSha: string,
) => {
	const rootKey = "ROOT";
	const allCommits = new Set<string>();
	const childCounts: Record<string, number> = { [rootKey]: 0 };

	for (const c of commits) {
		for (const p of c.parents) {
			if (allCommits.has(p)) {
				childCounts[p] = (childCounts[p] || 0) + 1;
			} else {
				childCounts[rootKey] = (childCounts[rootKey] || 0) + 1;
			}
		}
		allCommits.add(c.hash);
	}

	for (const sha of [baseSha, localSha, remoteSha]) {
		if (allCommits.has(sha)) {
			childCounts[sha] = (childCounts[sha] || 0) + 1;
		}
	}

	return { allCommits, childCounts, rootKey };
};

const ensureBranch = (
	p1: string,
	state: {
		branchMap: Map<string, BranchApi>;
		branchPool: Map<string, BranchApi[]>;
	},
) => {
	const { branchMap, branchPool } = state;
	if (branchMap.has(p1)) {
		return;
	}
	const pool = branchPool.get(p1);
	if (pool && pool.length > 0) {
		const target = pool.pop();
		if (target) {
			branchMap.set(p1, target);
			return;
		}
	}
	throw new Error(`Did not pre-create enough branches for ${p1}`);
};

const renderCommitDot = (
	c: CommitInfo,
	target: BranchApi,
	props: {
		onSelect: (sha: string) => void;
		baseSha: string;
		localSha: string;
		remoteSha: string;
	},
) => {
	const { onSelect, baseSha, localSha, remoteSha } = props;
	target.commit({
		hash: c.hash,
		subject: `${c.shortHash} - ${c.subject}`,
		// biome-ignore lint/suspicious/noExplicitAny: library types
		onMessageClick: (commit: any) => onSelect(commit.hash),
		// biome-ignore lint/suspicious/noExplicitAny: library types
		onClick: (commit: any) => onSelect(commit.hash),
		...(c.hash === baseSha ? { tag: "Base" } : {}),
		...(c.hash === localSha ? { tag: "Local" } : {}),
		...(c.hash === remoteSha ? { tag: "Remote" } : {}),
		// biome-ignore lint/suspicious/noExplicitAny: library types
	} as any);
};

const createExtraBranches = (
	c: CommitInfo,
	target: BranchApi,
	state: {
		branchPool: Map<string, BranchApi[]>;
		childCounts: Record<string, number>;
		nextBranchIndex: number;
	},
) => {
	if (!state.branchPool.has(c.hash)) {
		state.branchPool.set(c.hash, []);
	}
	const pool = state.branchPool.get(c.hash);
	if (!pool) {
		return;
	}

	const count = state.childCounts[c.hash] || 0;
	for (let i = 1; i < count; i++) {
		pool.push(
			target.branch(
				String.fromCharCode(65 + (state.nextBranchIndex % 26)),
			),
		);
		state.nextBranchIndex++;
	}
};

const handleMergeParents = (
	c: CommitInfo,
	target: BranchApi,
	branchMap: Map<string, BranchApi>,
) => {
	const p2 = c.parents?.[1];
	if (p2 && branchMap.has(p2)) {
		const sourceBranch = branchMap.get(p2);
		if (sourceBranch) {
			target.merge({
				branch: sourceBranch,
				commitOptions: {
					style: { message: { display: false } },
				},
				// biome-ignore lint/suspicious/noExplicitAny: library types
			} as any);
		}
	}
};

const processCommit = (
	c: CommitInfo,
	props: {
		onSelect: (sha: string) => void;
		allCommits: Set<string>;
		baseSha: string;
		localSha: string;
		remoteSha: string;
		rootKey: string;
	},
	state: {
		branchMap: Map<string, BranchApi>;
		branchPool: Map<string, BranchApi[]>;
		childCounts: Record<string, number>;
		nextBranchIndex: number;
	},
) => {
	const parent0 = c.parents[0];
	const p1 =
		parent0 && props.allCommits.has(parent0) ? parent0 : props.rootKey;
	ensureBranch(p1, state);

	const target = state.branchMap.get(p1);
	if (!target) {
		return;
	}

	renderCommitDot(c, target, props);

	state.branchMap.delete(p1);
	createExtraBranches(c, target, state);

	if (
		c.hash !== props.baseSha &&
		c.hash !== props.localSha &&
		c.hash !== props.remoteSha
	) {
		state.branchMap.set(c.hash, target);
	}

	handleMergeParents(c, target, state.branchMap);
};

const renderGraph = (gitgraph: GitgraphApi, props: GitGraphProps) => {
	const { commits, onSelect, baseSha, localSha, remoteSha } = props;
	const { allCommits, childCounts, rootKey } = calculateChildCounts(
		commits,
		baseSha,
		localSha,
		remoteSha,
	);
	const branchMap = new Map<string, BranchApi>();
	const branchPool = new Map<string, BranchApi[]>();

	const main = gitgraph.branch("main");
	main.commit({
		hash: rootKey,
		subject: "Earlier history...",
		style: { dot: { size: 6 } },
		// biome-ignore lint/suspicious/noExplicitAny: library types
	} as any);
	branchMap.set(rootKey, main);

	const state = {
		branchMap,
		branchPool,
		childCounts,
		nextBranchIndex: 0,
	};

	for (const c of commits) {
		processCommit(
			c,
			{
				onSelect,
				allCommits,
				baseSha,
				localSha,
				remoteSha,
				rootKey,
			},
			state,
		);
	}
};

const resetSelectionStyles = (container: HTMLDivElement) => {
	const dots = container.querySelectorAll("circle");
	const labels = container.querySelectorAll("text");
	for (const d of Array.from(dots)) {
		d.style.stroke = "none";
		d.style.strokeWidth = "0";
		d.setAttribute(
			"fill",
			d.getAttribute("data-original-fill") ||
				d.getAttribute("fill") ||
				"",
		);
	}
	for (const l of Array.from(labels)) {
		l.style.fontWeight = "normal";
		l.setAttribute(
			"fill",
			l.getAttribute("data-original-fill") ||
				l.getAttribute("fill") ||
				"",
		);
	}
};

const applySelectionHighlight = (
	container: HTMLDivElement,
	selectedSha: string,
) => {
	const useElement = container.querySelector(
		`use[*|href="#${selectedSha}"], use[href="#${selectedSha}"]`,
	);
	if (!useElement) {
		return;
	}

	const targetDot = container.querySelector(
		`circle[id="${selectedSha}"]`,
	) as SVGCircleElement | null;
	const commitRoot = targetDot?.parentElement?.parentElement;
	const targetLabel = commitRoot?.querySelector(
		"text",
	) as SVGTextElement | null;

	if (targetDot) {
		if (!targetDot.getAttribute("data-original-fill")) {
			targetDot.setAttribute(
				"data-original-fill",
				targetDot.getAttribute("fill") || "",
			);
		}
		targetDot.setAttribute("fill", "var(--vscode-focusBorder)");
		targetDot.style.stroke = "var(--vscode-focusBorder)";
		targetDot.style.strokeWidth = "2px";
	}

	if (targetLabel) {
		if (!targetLabel.getAttribute("data-original-fill")) {
			targetLabel.setAttribute(
				"data-original-fill",
				targetLabel.getAttribute("fill") || "",
			);
		}
		targetLabel.style.fontWeight = "bold";
		targetLabel.setAttribute("fill", "var(--vscode-focusBorder)");
	}
};

export const GitGraph: FC<GitGraphProps> = ({
	commits,
	localSha,
	remoteSha,
	baseSha,
	selectedSha,
	onSelect,
}) => {
	const options = useMemo(() => ({ template: customTemplate }), []);
	const containerRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		resetSelectionStyles(container);
		if (selectedSha) {
			applySelectionHighlight(container, selectedSha);
		}
	}, [selectedSha]);

	const graph = useMemo(
		() => (
			<Gitgraph options={options}>
				{(gitgraph) =>
					renderGraph(gitgraph, {
						commits,
						selectedSha,
						onSelect,
						baseSha,
						localSha,
						remoteSha,
					})
				}
			</Gitgraph>
		),
		[commits, options, onSelect, baseSha, localSha, remoteSha, selectedSha],
	);

	if (commits.length === 0) {
		return <div style={{ padding: "10px", opacity: 0.5 }}>No history.</div>;
	}

	return (
		<div
			ref={containerRef}
			style={{
				flex: 1,
				width: "100%",
				height: "100%",
				overflow: "auto",
				scrollbarWidth: "thin",
				position: "relative",
			}}
		>
			<style>{`
                svg circle, svg text, .gitgraph-commit-dot, .gitgraph-commit-message { 
                    cursor: pointer !important; 
                    pointer-events: auto !important; 
                }
                svg circle:hover { filter: brightness(1.2); }
                svg text:hover { opacity: 0.8; }
            `}</style>

			<div style={{ padding: "30px 20px" }}>{graph}</div>
		</div>
	);
};
