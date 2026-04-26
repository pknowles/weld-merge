import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export const createRenderCounter = (id = "root") => {
	let count = 0;
	const phases: Array<"mount" | "update" | "nested-update"> = [];
	const onRender: ProfilerOnRenderCallback = (commitId, phase) => {
		if (commitId !== id) {
			return;
		}
		count += 1;
		phases.push(phase);
	};
	return {
		wrap: (ui: ReactNode) => (
			<Profiler id={id} onRender={onRender}>
				{ui}
			</Profiler>
		),
		getCount: () => count,
		getPhases: () => phases.slice(),
		reset: () => {
			count = 0;
			phases.length = 0;
		},
	};
};
