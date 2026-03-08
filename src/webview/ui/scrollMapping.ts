import type { DiffChunk } from "./types";

function _upperBound<T, V>(
	arr: T[],
	value: V,
	compare: (element: T, searchVal: V) => number,
): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = lo + ((hi - lo) >> 1);
		if (compare(arr[mid], value) <= 0) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function _getNextImplicitChunk(
	idx: number,
	chunks: DiffChunk[],
	sourceMaxLines: number,
	targetMaxLines: number,
	sourceIsA: boolean,
): [number, number, number, number] {
	const cur = chunks[idx];

	// Helpers to read source/target sides from a chunk
	const sOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_a : c.start_b, sourceIsA ? c.end_a : c.end_b] as const;
	const tOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_b : c.start_a, sourceIsA ? c.end_b : c.end_a] as const;

	// If there's no next chunk, return the trailing/missing chunk
	if (idx === chunks.length - 1) {
		return [sOf(cur)[1], sourceMaxLines, tOf(cur)[1], targetMaxLines];
	}

	const next = chunks[idx + 1];

	// If there's a gap between the current chunk and the next chunk
	if (sOf(next)[0] > sOf(cur)[1]) {
		return [sOf(cur)[1], sOf(next)[0], tOf(cur)[1], tOf(next)[0]];
	}

	// Otherwise return the next chunk
	return [sOf(next)[0], sOf(next)[1], tOf(next)[0], tOf(next)[1]];
}

function _getPreviousImplicitChunk(
	idx: number,
	chunks: DiffChunk[],
	sourceIsA: boolean,
): [number, number, number, number] {
	const cur = chunks[idx];

	// Helpers to read source/target sides from a chunk
	const sOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_a : c.start_b, sourceIsA ? c.end_a : c.end_b] as const;
	const tOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_b : c.start_a, sourceIsA ? c.end_b : c.end_a] as const;

	// If there's no previous chunk, return the leading/missing chunk
	if (idx === 0) {
		return [0, sOf(cur)[0], 0, tOf(cur)[0]];
	}

	const prev = chunks[idx - 1];

	// If there's a gap between the previous chunk and the current chunk
	if (sOf(cur)[0] > sOf(prev)[1]) {
		return [sOf(prev)[1], sOf(cur)[0], tOf(prev)[1], tOf(cur)[0]];
	}

	// Otherwise return the previous chunk
	return [sOf(prev)[0], sOf(prev)[1], tOf(prev)[0], tOf(prev)[1]];
}

function _getSides(chunk: DiffChunk, sourceIsA: boolean) {
	const s = [
		sourceIsA ? chunk.start_a : chunk.start_b,
		sourceIsA ? chunk.end_a : chunk.end_b,
	] as const;
	const t = [
		sourceIsA ? chunk.start_b : chunk.start_a,
		sourceIsA ? chunk.end_b : chunk.end_a,
	] as const;
	return [s, t] as const;
}

function _getInterpolationRanges(
	line: number,
	upperBoundChunkIdx: number,
	chunks: DiffChunk[],
	sourceMaxLines: number,
	targetMaxLines: number,
	sourceIsA: boolean,
): [number, number, number, number] {
	// Helpers to read source/target sides from a chunk
	const sOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_a : c.start_b, sourceIsA ? c.end_a : c.end_b] as const;
	const tOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_b : c.start_a, sourceIsA ? c.end_b : c.end_a] as const;
	const chunkSrcMid = (chunk: DiffChunk) => (sOf(chunk)[0] + sOf(chunk)[1]) / 2;
	const chunkDstMid = (chunk: DiffChunk) => (tOf(chunk)[0] + tOf(chunk)[1]) / 2;
	const implicitSrcMid = (chunk: [number, number, number, number]) =>
		(chunk[0] + chunk[1]) / 2;
	const implicitDstMid = (chunk: [number, number, number, number]) =>
		(chunk[2] + chunk[3]) / 2;

	let res: [number, number, number, number];

	if (upperBoundChunkIdx === chunks.length) {
		const last = chunks[chunks.length - 1];
		const gap = _getNextImplicitChunk(
			chunks.length - 1,
			chunks,
			sourceMaxLines,
			targetMaxLines,
			sourceIsA,
		);

		if (line < implicitSrcMid(gap)) {
			// Between last chunk mid and trailing gap mid
			res = [
				chunkSrcMid(last),
				implicitSrcMid(gap),
				chunkDstMid(last),
				implicitDstMid(gap),
			];
		} else {
			// Between trailing gap mid and end of file
			res = [
				implicitSrcMid(gap),
				sourceMaxLines,
				implicitDstMid(gap),
				targetMaxLines,
			];
		}
	} else if (line < sOf(chunks[upperBoundChunkIdx])[0]) {
		const chunk = _getPreviousImplicitChunk(
			upperBoundChunkIdx,
			chunks,
			sourceIsA,
		);

		if (line < implicitSrcMid(chunk)) {
			// If in the first half, interpolate from the previous real chunk, or 0 if it doesn't exist
			res = [
				upperBoundChunkIdx > 0
					? chunkSrcMid(chunks[upperBoundChunkIdx - 1])
					: 0,
				implicitSrcMid(chunk),
				upperBoundChunkIdx > 0
					? chunkDstMid(chunks[upperBoundChunkIdx - 1])
					: 0,
				implicitDstMid(chunk),
			];
		} else {
			// If in the second half, interpolate to the current real chunk
			res = [
				implicitSrcMid(chunk),
				chunkSrcMid(chunks[upperBoundChunkIdx]),
				implicitDstMid(chunk),
				chunkDstMid(chunks[upperBoundChunkIdx]),
			];
		}
	} else {
		if (line < chunkSrcMid(chunks[upperBoundChunkIdx])) {
			// If in the first half, interpolate from the previous implicit chunk
			const prev = _getPreviousImplicitChunk(
				upperBoundChunkIdx,
				chunks,
				sourceIsA,
			);
			res = [
				implicitSrcMid(prev),
				chunkSrcMid(chunks[upperBoundChunkIdx]),
				implicitDstMid(prev),
				chunkDstMid(chunks[upperBoundChunkIdx]),
			];
		} else {
			// If in the second half, interpolate to the next implicit chunk
			const next = _getNextImplicitChunk(
				upperBoundChunkIdx,
				chunks,
				sourceMaxLines,
				targetMaxLines,
				sourceIsA,
			);
			res = [
				chunkSrcMid(chunks[upperBoundChunkIdx]),
				implicitSrcMid(next),
				chunkDstMid(chunks[upperBoundChunkIdx]),
				implicitDstMid(next),
			];
		}
	}

	if (line < res[0] || line > res[1]) {
		throw new Error(
			`Line ${line} is outside source interpolation range [${res[0]}, ${res[1]}]`,
		);
	}
	if (
		!Number.isFinite(res[0]) ||
		!Number.isFinite(res[1]) ||
		!Number.isFinite(res[2]) ||
		!Number.isFinite(res[3])
	) {
		throw new Error(
			`Invalid interpolation range [${res[0]}, ${res[1]}] -> [${res[2]}, ${res[3]}]`,
		);
	}

	return res;
}

/**
 * Maps a continuous line number from one side of a chunk array to the other.
 * This is a pure function that performs proportional interpolation within chunks
 * and 1:1 offsetting between chunks.
 *
 * @param sourceLine The line number to map from (0-indexed, continuous/fractional)
 * @param chunks The array of diff chunks connecting the two panes
 * @param sourceIsA True if mapping from side A to side B, false if B to A
 * @param targetMaxLines Optional maximum line count for the target pane to clamp the result
 * @returns The mapped line number on the target pane (0-indexed, continuous/fractional)
 */
export function mapLineAcrossChunks(
	sourceLine: number,
	chunks: DiffChunk[] | null | undefined,
	sourceIsA: boolean,
	_sourceMaxLines: number,
	targetMaxLines: number,
	smooth: boolean,
): number {
	// Clamp and adapt range [0, _sourceMaxLines]
	sourceLine = Math.max(0, Math.min(sourceLine, _sourceMaxLines - 1e-10));

	const clamp = (v: number) => Math.max(0, Math.min(v, targetMaxLines));

	if (!chunks || chunks.length === 0) {
		return clamp(sourceLine);
	}

	// Helpers to read source/target sides from a chunk
	const sOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_a : c.start_b, sourceIsA ? c.end_a : c.end_b] as const;
	const tOf = (c: DiffChunk) =>
		[sourceIsA ? c.start_b : c.start_a, sourceIsA ? c.end_b : c.end_a] as const;

	if (sOf(chunks[chunks.length - 1])[1] > _sourceMaxLines)
		throw Error("last chunk outside _sourceMaxLines");

	if (tOf(chunks[chunks.length - 1])[1] > targetMaxLines)
		throw Error("last chunk outside targetMaxLines");

	// Binary search to find the first chunk that ends after sourceLine
	// Note: chunks include only diffs/replacements/conflicts, no matches and are not contiguous
	const upperBoundChunkIdx = Math.max(
		0,
		_upperBound(chunks, sourceLine, (chunk, value) => {
			return sOf(chunk)[1] - value;
		}),
	);

	if (!smooth) {
		if (upperBoundChunkIdx === chunks.length) {
			const last = chunks[chunks.length - 1];
			const offset = tOf(last)[1] - sOf(last)[1];
			return clamp(sourceLine + offset);
		}

		const cur = chunks[upperBoundChunkIdx];
		const [sCur, tCur] = _getSides(cur, sourceIsA);
		if (sourceLine < sCur[0]) {
			const prevIdx = upperBoundChunkIdx - 1;
			const prevEndSrc =
				prevIdx >= 0 ? _getSides(chunks[prevIdx], sourceIsA)[0][1] : 0;
			const prevEndDst =
				prevIdx >= 0 ? _getSides(chunks[prevIdx], sourceIsA)[1][1] : 0;
			return clamp(sourceLine + (prevEndDst - prevEndSrc));
		}
		const srcLen = sCur[1] - sCur[0];
		const dstLen = tCur[1] - tCur[0];
		if (srcLen === 0) return clamp(tCur[0]);
		const frac = (sourceLine - sCur[0]) / srcLen;
		return clamp(tCur[0] + frac * dstLen);
	}

	const [prevSrcLine, nextSrcLine, prevDstLine, nextDstLine] =
		_getInterpolationRanges(
			sourceLine,
			upperBoundChunkIdx,
			chunks,
			_sourceMaxLines,
			targetMaxLines,
			sourceIsA,
		);

	// Interpolate from src to dst.
	const frac =
		(sourceLine - prevSrcLine) / Math.max(1, nextSrcLine - prevSrcLine);

	if (frac < 0 || frac > 1) throw new Error("Invalid interpolation range");
	//const smoothstep = frac * frac * (3 - 2 * frac);
	let result = frac * (nextDstLine - prevDstLine) + prevDstLine;

	if (result === targetMaxLines) result -= 1e-8; // Automagic range [start, end) adaption. Kinda smells

	if (!Number.isFinite(result))
		throw Error(`Result is ${result}, frac ${frac}`);
	if (result < 0 || result >= targetMaxLines)
		throw Error(`Result out of bounds: 0 <= ${result} < ${targetMaxLines}`);
	return result;
}

/**
 * Maps a continuous line number across a chain of multiple panes.
 *
 * @param sourceLine The starting line number on the source pane
 * @param sourceIdx The index of the pane we are starting from
 * @param targetIdx The index of the pane we want to map to
 * @param diffs Array where diffs[i] connects pane i and pane i+1
 * @param paneLineCounts Array of maximum line counts for each pane (used for clamping)
 * @param smooth Whether to use proportional interpolation instead of discrete jumps
 * @param diffIsReversed [CRITICAL] Array mapping diff indices to their L/R inversion state.
 *        By default (false), diffs[i].sideA is pane[i] and diffs[i].sideB is pane[i+1].
 *        When true, Side A is assumed to be pane[i+1] and Side B is pane[i].
 *
 * NOTE: This is required for the 5-way merge view because the payload provides
 * some diffs (like Local vs Merged) where Side A is the "Merged" pane on the right.
 * Correct usage for the 5-way view is typically: [false, true, false, true].
 *
 * @returns The mapped line number on the target pane
 */
export function mapLineAcrossPanes(
	sourceLine: number,
	sourceIdx: number,
	targetIdx: number,
	diffs: (DiffChunk[] | null)[],
	paneLineCounts: number[],
	smooth: boolean,
	diffIsReversed: boolean[],
): number {
	if (diffIsReversed.length === 0) {
		throw new Error("Missing 'diffIsReversed' argument in mapLineAcrossPanes");
	}
	if (sourceIdx === targetIdx) {
		return sourceLine;
	}

	if (diffs.length + 1 !== paneLineCounts.length)
		// fencepost/off by one
		throw Error("Mismatch between diffs and paneLineCounts");

	// Move one step towards the target index
	const isMovingRight = sourceIdx < targetIdx;
	const diffIdx = isMovingRight ? sourceIdx : sourceIdx - 1;
	const targetStepIdx = isMovingRight ? sourceIdx + 1 : sourceIdx - 1;

	const chunks = diffs[diffIdx];
	const isBackwards = diffIsReversed[diffIdx] || false;
	const sourceIsA = isBackwards ? !isMovingRight : isMovingRight;

	const srcMax = paneLineCounts[sourceIdx];
	const tgtMax = paneLineCounts[targetStepIdx];

	if (srcMax === undefined || tgtMax === undefined) {
		throw new Error(
			`Missing line count for pane ${srcMax === undefined ? sourceIdx : targetStepIdx}`,
		);
	}

	const nextLine = mapLineAcrossChunks(
		sourceLine,
		chunks,
		sourceIsA,
		srcMax,
		tgtMax,
		smooth,
	);

	return mapLineAcrossPanes(
		nextLine,
		targetStepIdx,
		targetIdx,
		diffs,
		paneLineCounts,
		smooth,
		diffIsReversed,
	);
}
