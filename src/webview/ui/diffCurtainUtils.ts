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

	if (
		rawLs < 1 ||
		rawLs > p.lMax ||
		rawLe < 1 ||
		rawLe > p.lMax ||
		rawRs < 1 ||
		rawRs > p.rMax ||
		rawRe < 1 ||
		rawRe > p.rMax
	) {
		throw new Error(
			`DiffCurtain connection out of bounds: L[${rawLs}-${rawLe}]/max=${p.lMax}, R[${rawRs}-${rawRe}]/max=${p.rMax} (reversed: ${p.reversed})`,
		);
	}

	const lS = Math.min(p.lMax, Math.max(1, rawLs));
	const lE = Math.min(p.lMax, Math.max(1, rawLe));
	const rS = Math.min(p.rMax, Math.max(1, rawRs));
	const rE = Math.min(p.rMax, Math.max(1, rawRe));
	const lEmp = p.reversed ? p.startB === p.endB : p.startA === p.endA;
	const rEmp = p.reversed ? p.startA === p.endA : p.startB === p.endB;
	return { lS, lE, rS, rE, lEmp, rEmp };
}
