// Copyright (C) 2026 Pyarelal Knowles, GPL v2

export function getBounds(p: {
	startA: number;
	endA: number;
	startB: number;
	endB: number;
	lMax: number;
	rMax: number;
	reversed: boolean;
}) {
	const rawLs = (p.reversed ? p.startB : p.startA) + 1;
	const rawLe = (p.reversed ? p.endB : p.endA) + 1;
	const rawRs = (p.reversed ? p.startA : p.startB) + 1;
	const rawRe = (p.reversed ? p.endA : p.endB) + 1;

	const maxL = p.lMax;
	const maxR = p.rMax;

	if (
		rawLs < 1 ||
		rawLs > maxL + 1 ||
		rawLe < 1 ||
		rawLe > maxL + 1 ||
		rawRs < 1 ||
		rawRs > maxR + 1 ||
		rawRe < 1 ||
		rawRe > maxR + 1
	) {
		throw new Error(
			`DiffCurtain connection out of bounds: L[${rawLs}-${rawLe}]/max=${maxL}, R[${rawRs}-${rawRe}]/max=${maxR} (reversed: ${p.reversed})`,
		);
	}

	const lS = Math.min(maxL + 1, Math.max(1, rawLs));
	const lE = Math.min(maxL + 1, Math.max(1, rawLe));
	const rS = Math.min(maxR + 1, Math.max(1, rawRs));
	const rE = Math.min(maxR + 1, Math.max(1, rawRe));
	const lEmp = p.reversed ? p.startB === p.endB : p.startA === p.endA;
	const rEmp = p.reversed ? p.startA === p.endA : p.startB === p.endB;
	return { lS, lE, rS, rE, lEmp, rEmp };
}
