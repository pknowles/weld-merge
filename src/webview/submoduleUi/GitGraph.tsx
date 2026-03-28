import { Gitgraph, TemplateName, templateExtend } from "@gitgraph/react";
import type { GitgraphUserApi, BranchUserApi } from "@gitgraph/react";
import type { ReactSvgElement } from "@gitgraph/react/lib/types";
import { type FC, useMemo, useRef, useLayoutEffect } from "react";
import type { CommitInfo } from "./types.ts";

interface GitGraphProps {
	commits: CommitInfo[];
	localSha: string;
	remoteSha: string;
	baseSha: string;
	selectedSha: string;
	onSelect: (sha: string) => void;
}

const customTemplate = templateExtend(TemplateName.Metro, {
	branch: { spacing: 20, lineWidth: 3, label: { display: false } },
	commit: {
		spacing: 24,
		dot: { size: 7 },
		message: {
			font: "var(--vscode-font-family)",
			displayHash: false,
			displayAuthor: false
		},
	},
});

const renderGraph = (gitgraph: GitgraphUserApi<ReactSvgElement>, props: GitGraphProps) => {
	const { commits, onSelect, baseSha, localSha, remoteSha } = props;
	const branchMap = new Map<string, BranchUserApi<ReactSvgElement>>();
	const allCommits = new Set<string>();

	const main = gitgraph.branch("main");
	const rootKey = "ROOT";
	main.commit({
		hash: rootKey,
		subject: "Earlier history...",
		style: { dot: { size: 6 } },
	} as any);
	branchMap.set(rootKey, main);
	let nextBranchIndex = 0;

	const childCounts: Record<string, number> = { [rootKey]: 0 };
	for (const c of commits) {
		for (const p of c.parents) {
			if (!allCommits.has(p)) {
				childCounts[rootKey] += 1;
			} else {
				childCounts[p] = (childCounts[p] || 0) + 1;
			}
		}
		allCommits.add(c.hash);
	}
	// All special markers terminate a branch so it's a distinguished color
	for (const sha of [baseSha, localSha, remoteSha]) {
		if (!allCommits.has(sha)) continue;
		childCounts[sha] = (childCounts[sha] || 0) + 1;
	}

	const branchPool = new Map<string, Array<BranchUserApi<ReactSvgElement>>>();

	for (const c of commits) {
		const p1 = allCommits.has(c.parents[0]) ? c.parents[0] : rootKey;

		if (!branchMap.has(p1)) {
			const pool = branchPool.get(p1);
			if (!pool || pool.length === 0)
				throw new Error(`Did not pre-create enough branches for ${p1}`);
			branchMap.set(p1, pool.pop()!);
		}
		const target = branchMap.get(p1)!;

		target.commit({
			hash: c.hash,
			subject: `${c.shortHash} - ${c.subject}`,
			onMessageClick: (commit: any) => onSelect(commit.hash),
			onClick: (commit: any) => onSelect(commit.hash),
			...(c.hash === baseSha ? { tag: "Base" } : {}),
			...(c.hash === localSha ? { tag: "Local" } : {}),
			...(c.hash === remoteSha ? { tag: "Remote" } : {}),
		} as any);

		branchMap.delete(p1);

		// Create all extra child branch points immediately after the parent is created
		if (!branchPool.has(c.hash)) branchPool.set(c.hash, []);
		const pool = branchPool.get(c.hash)!;
		for (let i = 1; i < (childCounts[c.hash] || 0); i++) {
			pool.push(target.branch(String.fromCharCode(65 + (nextBranchIndex % 26))));
			nextBranchIndex++;
		}

		// All special markers terminate a branch so it's a distinguished color
		if (c.hash !== baseSha && c.hash !== localSha && c.hash !== remoteSha)
			branchMap.set(c.hash, target);

		const p2 = c.parents?.[1];
		if (p2 && branchMap.has(p2)) {
			// Correctly merge the branch representing the second parent into the current target
			target.merge({
				branch: branchMap.get(p2)!,
				commitOptions: {
					style: { message: { display: false } },
				},
			} as any);
		}
	}
};

export const GitGraph: FC<GitGraphProps> = ({ commits, localSha, remoteSha, baseSha, selectedSha, onSelect }) => {
	const options = useMemo(() => ({ template: customTemplate }), []);
	const containerRef = useRef<HTMLDivElement>(null);

	// Imperative selection update to avoid full re-render & scroll reset
	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		// 1. Reset all nodes & text (Cleanup)
		const dots = container.querySelectorAll("circle");
		const labels = container.querySelectorAll("text");
		for (const d of dots) {
			d.style.stroke = "none";
			d.style.strokeWidth = "0";
			d.setAttribute("fill", d.getAttribute("data-original-fill") || d.getAttribute("fill") || "");
		}
		for (const l of labels) {
			l.style.fontWeight = "normal";
			l.setAttribute("fill", l.getAttribute("data-original-fill") || l.getAttribute("fill") || "");
		}

		if (!selectedSha) return;

		// 2. Find and highlight the selected node by its native ID
		// The library puts 'id="[full-sha]"' on the <circle> in <defs>, and uses a <use> for the dot.
		const useElement = container.querySelector(`use[*|href="#${selectedSha}"], use[href="#${selectedSha}"]`);
		if (!useElement) return;

		// The visible dot is the <use> element, but the style is often in the original circle or the use.
		// We can target the original definition circle for highlighting.
		const targetDot = container.querySelector(`circle[id="${selectedSha}"]`);

		// The labels are inside a separate <g> tree, but they share the same grandparent with the <use>
		const commitRoot = targetDot.parentElement?.parentElement;
		const targetLabel = commitRoot?.querySelector("text");

		if (targetDot) {
			if (!targetDot.getAttribute("data-original-fill")) {
				targetDot.setAttribute("data-original-fill", targetDot.getAttribute("fill") || "");
			}
			targetDot.setAttribute("fill", "var(--vscode-focusBorder)");
			targetDot.style.stroke = "var(--vscode-focusBorder)";
			targetDot.style.strokeWidth = "2px";
		}

		if (targetLabel) {
			if (!targetLabel.getAttribute("data-original-fill")) {
				targetLabel.setAttribute("data-original-fill", targetLabel.getAttribute("fill") || "");
			}
			targetLabel.style.fontWeight = "bold";
			targetLabel.setAttribute("fill", "var(--vscode-focusBorder)");
		}
	}, [selectedSha, commits]);

	if (commits.length === 0) { return <div style={{ padding: "10px", opacity: 0.5 }}>No history.</div>; }

	// Ensure the graph ONLY re-builds when the history data changes
	const graph = useMemo(() => (
		<Gitgraph options={options}>
			{(gitgraph) => renderGraph(gitgraph, { commits, selectedSha, onSelect, baseSha, localSha, remoteSha })}
		</Gitgraph>
	), [commits, options, onSelect, baseSha, localSha, remoteSha]);

	return (
		<div
			ref={containerRef}
			style={{ flex: 1, width: "100%", height: "100%", overflow: "auto", scrollbarWidth: "thin", position: "relative" }}
		>
			<style>{`
				svg circle, svg text, .gitgraph-commit-dot, .gitgraph-commit-message { 
					cursor: pointer !important; 
					pointer-events: auto !important; 
				}
				svg circle:hover { filter: brightness(1.2); }
				svg text:hover { opacity: 0.8; }
			`}</style>

			<div style={{ padding: "30px 20px" }}>
				{graph}
			</div>
		</div>
	);
};

