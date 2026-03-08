// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import type { DiffChunk } from "./types.ts";

/**
 * Standard binary search upper_bound implementation.
 * Returns the index of the first element in arr such that compare(element, value) > 0.
 */
function _upperBound<T, V>(
	arr: T[],
	value: V,
	compare: (element: T, searchVal: V) => number,
): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = lo + ((hi - lo) >> 1);
		const midVal = arr[mid];
		if (midVal !== undefined && compare(midVal, value) <= 0) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

const _sOf = (c: DiffChunk, sourceIsA: boolean) =>
	[sourceIsA ? c.startA : c.startB, sourceIsA ? c.endA : c.endB] as const;
const _tOf = (c: DiffChunk, sourceIsA: boolean) =>
	[sourceIsA ? c.startB : c.startA, sourceIsA ? c.endB : c.endA] as const;

/**
 * Returns the "implicit chunk" (a gap of matching lines) after the chunk at index idx.
 * Implicit chunks are 4-tuples: [sourceStart, sourceEnd, targetStart, targetEnd].
 */
function _getNextImplicitChunk(
	idx: number,
	chunks: DiffChunk[],
	sourceMaxLines: number,
	targetMaxLines: number,
	sourceIsA: boolean,
): [number, number, number, number] {
	const cur = chunks[idx];
	if (!cur) {
		throw new Error(`Current chunk at index ${idx} not found`);
	}
	const [_sCurStart, sCurEnd] = _sOf(cur, sourceIsA);
	const [_tCurStart, tCurEnd] = _tOf(cur, sourceIsA);

	if (idx === chunks.length - 1) {
		return [sCurEnd, sourceMaxLines, tCurEnd, targetMaxLines];
	}

	const next = chunks[idx + 1];
	if (!next) {
		throw new Error(`Next chunk not found at index ${idx + 1}`);
	}
	const [sNextStart, sNextEnd] = _sOf(next, sourceIsA);
	const [tNextStart, tNextEnd] = _tOf(next, sourceIsA);

	if (sNextStart > sCurEnd) {
		return [sCurEnd, sNextStart, tCurEnd, tNextStart];
	}

	return [sNextStart, sNextEnd, tNextStart, tNextEnd];
}

/**
 * Returns the "implicit chunk" (a gap of matching lines) before the chunk at index idx.
 */
function _getPreviousImplicitChunk(
	idx: number,
	chunks: DiffChunk[],
	sourceIsA: boolean,
): [number, number, number, number] {
	const cur = chunks[idx];
	if (!cur) {
		throw new Error(`Current chunk at index ${idx} not found`);
	}
	const [sCurStart, _sCurEnd] = _sOf(cur, sourceIsA);
	const [tCurStart, _tCurEnd] = _tOf(cur, sourceIsA);

	if (idx === 0) {
		return [0, sCurStart, 0, tCurStart];
	}

	const prev = chunks[idx - 1];
	if (!prev) {
		throw new Error(`Previous chunk not found at index ${idx - 1}`);
	}
	const [sPrevStart, sPrevEnd] = _sOf(prev, sourceIsA);
	const [tPrevStart, tPrevEnd] = _tOf(prev, sourceIsA);

	if (sCurStart > sPrevEnd) {
		return [sPrevEnd, sCurStart, tPrevEnd, tCurStart];
	}

	return [sPrevStart, sPrevEnd, tPrevStart, tPrevEnd];
}

const _chunkSrcMid = (chunk: DiffChunk, sourceIsA: boolean) => {
	const [sStart, sEnd] = _sOf(chunk, sourceIsA);
	return (sStart + sEnd) / 2;
};
const _chunkDstMid = (chunk: DiffChunk, sourceIsA: boolean) => {
	const [tStart, tEnd] = _tOf(chunk, sourceIsA);
	return (tStart + tEnd) / 2;
};
const _implicitSrcMid = (chunk: [number, number, number, number]) =>
	(chunk[0] + chunk[1]) / 2;
const _implicitDstMid = (chunk: [number, number, number, number]) =>
	(chunk[2] + chunk[3]) / 2;

function _getTrailingInterpolationRanges(
	line: number,
	chunks: DiffChunk[],
	sourceMaxLines: number,
	targetMaxLines: number,
	sourceIsA: boolean,
): [number, number, number, number] {
	const last = chunks.at(-1);
	if (!last) {
		throw new Error("No last chunk available");
	}

	const gap = _getNextImplicitChunk(
		chunks.length - 1,
		chunks,
		sourceMaxLines,
		targetMaxLines,
		sourceIsA,
	);

	if (line < _implicitSrcMid(gap)) {
		return [
			_chunkSrcMid(last, sourceIsA),
			_implicitSrcMid(gap),
			_chunkDstMid(last, sourceIsA),
			_implicitDstMid(gap),
		];
	}
	return [
		_implicitSrcMid(gap),
		sourceMaxLines,
		_implicitDstMid(gap),
		targetMaxLines,
	];
}

function _getGeneralInterpolationRanges(
	line: number,
	upperBoundChunkIdx: number,
	chunks: DiffChunk[],
	sourceMaxLines: number,
	targetMaxLines: number,
	sourceIsA: boolean,
): [number, number, number, number] {
	const curUpper = chunks[upperBoundChunkIdx];
	if (!curUpper) {
		throw new Error(
			`Upperbound chunk at index ${upperBoundChunkIdx} not found`,
		);
	}

	if (line < _sOf(curUpper, sourceIsA)[0]) {
		const chunk = _getPreviousImplicitChunk(
			upperBoundChunkIdx,
			chunks,
			sourceIsA,
		);

		if (line < _implicitSrcMid(chunk)) {
			const prevChunk =
				upperBoundChunkIdx > 0
					? chunks[upperBoundChunkIdx - 1]
					: undefined;
			return [
				prevChunk ? _chunkSrcMid(prevChunk, sourceIsA) : 0,
				_implicitSrcMid(chunk),
				prevChunk ? _chunkDstMid(prevChunk, sourceIsA) : 0,
				_implicitDstMid(chunk),
			];
		}
		return [
			_implicitSrcMid(chunk),
			_chunkSrcMid(curUpper, sourceIsA),
			_implicitDstMid(chunk),
			_chunkDstMid(curUpper, sourceIsA),
		];
	}

	if (line < _chunkSrcMid(curUpper, sourceIsA)) {
		const prev = _getPreviousImplicitChunk(
			upperBoundChunkIdx,
			chunks,
			sourceIsA,
		);
		return [
			_implicitSrcMid(prev),
			_chunkSrcMid(curUpper, sourceIsA),
			_implicitDstMid(prev),
			_chunkDstMid(curUpper, sourceIsA),
		];
	}

	const next = _getNextImplicitChunk(
		upperBoundChunkIdx,
		chunks,
		sourceMaxLines,
		targetMaxLines,
		sourceIsA,
	);
	return [
		_chunkSrcMid(curUpper, sourceIsA),
		_implicitSrcMid(next),
		_chunkDstMid(curUpper, sourceIsA),
		_implicitDstMid(next),
	];
}

function _getInterpolationRanges(
	line: number,
	upperBoundChunkIdx: number,
	chunks: DiffChunk[],
	sourceMaxLines: number,
	targetMaxLines: number,
	sourceIsA: boolean,
): [number, number, number, number] {
	if (upperBoundChunkIdx === chunks.length) {
		return _getTrailingInterpolationRanges(
			line,
			chunks,
			sourceMaxLines,
			targetMaxLines,
			sourceIsA,
		);
	}
	return _getGeneralInterpolationRanges(
		line,
		upperBoundChunkIdx,
		chunks,
		sourceMaxLines,
		targetMaxLines,
		sourceIsA,
	);
}

/**
 * Maps a continuous line number from one side of a chunk array to the other.
 */
export function mapLineAcrossChunks(
	line: number,
	chunks: DiffChunk[] | null,
	sourceIsA: boolean,
	sourceMaxLines: number,
	targetMaxLines: number,
	smooth: boolean,
): number {
	const clampedLine = Math.max(0, Math.min(line, sourceMaxLines - 1e-10));
	const targetClamp = (val: number) =>
		Math.max(0, Math.min(val, targetMaxLines));

	if (!chunks || chunks.length === 0) {
		return targetClamp(clampedLine);
	}

	const last = chunks.at(-1);
	if (last) {
		const [, sEnd] = _sOf(last, sourceIsA);
		if (sEnd > sourceMaxLines) {
			throw new Error("last chunk outside _sourceMaxLines");
		}
	}

	if (!smooth) {
		// Discrete mapping
		const idx = _upperBound(chunks, clampedLine, (c, v) => {
			const [sStart] = _sOf(c, sourceIsA);
			return sStart - v;
		});

		// Check if we are inside the chunk BEFORE the one we found (if any)
		if (idx > 0) {
			const prev = chunks[idx - 1];
			if (prev) {
				const [sStart, sEnd] = _sOf(prev, sourceIsA);
				if (clampedLine < sEnd) {
					const [tStart, tEnd] = _tOf(prev, sourceIsA);
					const ratio = (clampedLine - sStart) / (sEnd - sStart || 1);
					return targetClamp(tStart + ratio * (tEnd - tStart));
				}
			}
		}

		// Not in a chunk, so we are in a gap (leading, intermediate, or trailing)
		if (idx < chunks.length) {
			const gap = _getPreviousImplicitChunk(idx, chunks, sourceIsA);
			const offset = gap[2] - gap[0];
			return targetClamp(clampedLine + offset);
		}

		// Trailing gap after the last chunk
		const lastChunk = chunks.at(-1);
		if (lastChunk) {
			const [, sEnd] = _sOf(lastChunk, sourceIsA);
			const [, tEnd] = _tOf(lastChunk, sourceIsA);
			return targetClamp(clampedLine + (tEnd - sEnd));
		}
		return targetClamp(clampedLine);
	}

	// Smooth/Proportional mapping
	const idx = _upperBound(
		chunks,
		clampedLine,
		(c, v) => _chunkSrcMid(c, sourceIsA) - v,
	);

	const [s1, s2, t1, t2] = _getInterpolationRanges(
		clampedLine,
		idx,
		chunks,
		sourceMaxLines,
		targetMaxLines,
		sourceIsA,
	);

	const range = s2 - s1;
	const frac = range > 0 ? (clampedLine - s1) / range : 0;
	let result = frac * (t2 - t1) + t1;

	if (result >= targetMaxLines) {
		result = targetMaxLines - 1e-8;
	}
	return targetClamp(result);
}

/**
 * Maps a continuous line number across a chain of multiple panes.
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
	if (sourceIdx === targetIdx) {
		return sourceLine;
	}

	const isMovingRight = sourceIdx < targetIdx;
	const diffIdx = isMovingRight ? sourceIdx : sourceIdx - 1;
	const targetStepIdx = isMovingRight ? sourceIdx + 1 : sourceIdx - 1;

	const chunks = diffs[diffIdx] ?? null;
	const isBackwards = diffIsReversed[diffIdx] ?? false;
	const sourceIsA = isBackwards ? !isMovingRight : isMovingRight;

	const srcMax = paneLineCounts[sourceIdx] ?? 1;
	const tgtMax = paneLineCounts[targetStepIdx] ?? 1;

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
