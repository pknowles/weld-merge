// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Differ } from "./diffutil.ts";
import type { DiffChunk } from "./myers.ts";

interface ThreeWayLines {
	local: string[];
	middle: string[];
	remote: string[];
}

type ThreeWayChange = [DiffChunk | null, DiffChunk | null];

function createThreeWayChanges(lines: ThreeWayLines): ThreeWayChange[] {
	// Meld computes both outer diffs against the middle sequence. AutoMergeDiffer
	// then combines overlapping changes into paired conflict chunks. Each pair is
	// [middle<->local, middle<->remote], with middle in the chunk's A coordinates.
	const differ = new Differ();
	differ.setSequences([lines.local, lines.middle, lines.remote]);
	return differ.allChanges();
}

export type { ThreeWayChange };
export { createThreeWayChanges };
