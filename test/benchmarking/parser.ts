import fs from "node:fs";
import path from "node:path";

interface CallFrame {
	functionName: string;
	url: string;
	scriptId: string;
	lineNumber: number;
	columnNumber: number;
}

interface ProfileNode {
	id: number;
	callFrame: CallFrame;
	hitCount: number;
	children?: number[];
}

interface CpuProfile {
	nodes: ProfileNode[];
	startTime: number;
	endTime: number;
	samples: number[];
	timeDeltas: number[];
}

export function parseProfile(profilePath: string, projectRoot: string) {
	if (!fs.existsSync(profilePath)) {
		return [];
	}
	const raw = fs.readFileSync(profilePath, "utf8");
	const profile = JSON.parse(raw) as CpuProfile;

	const functionStats = new Map<
		string,
		{ selfTime: number; totalTime: number; hitCount: number }
	>();
	for (const node of profile.nodes) {
		const url = node.callFrame.url;
		// More robust filter for project files, including bundled webview JS
		const isProjectFile =
			(url.includes(projectRoot) || url.includes("out/webview")) &&
			!url.includes("node_modules") &&
			!url.startsWith("node:");

		if (isProjectFile) {
			const fileName = path.basename(url);
			// For bundled code, ignore empty function names or very generic ones
			if (
				node.callFrame.functionName === "" ||
				node.callFrame.functionName === "(anonymous)"
			) {
				continue;
			}

			const key = `${node.callFrame.functionName} (${fileName}:${node.callFrame.lineNumber})`;
			const stats = functionStats.get(key) || {
				selfTime: 0,
				totalTime: 0,
				hitCount: 0,
			};
			stats.selfTime += node.hitCount;
			stats.hitCount += node.hitCount;
			functionStats.set(key, stats);
		}
	}

	return Array.from(functionStats.entries())
		.map(([name, stats]) => ({ name, ...stats }))
		.sort((a, b) => b.selfTime - a.selfTime);
}
