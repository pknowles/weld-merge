// Copyright (C) 2002-2006 Stephen Kennedy <stevek@gnome.org>
// Copyright (C) 2009, 2012-2013 Kai Willadsen <kai.willadsen@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 2 of the License, or (at
// your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import {
	type DiffChunk,
	type DiffChunkTag,
	MyersSequenceMatcher,
	SyncPointMyersSequenceMatcher,
} from "./myers.ts";

const THREE_PANES = 3;
const NUM_PANES = 5;
const NUM_DIFFS = 4;
const PANE_0 = 0;
const PANE_1 = 1;
const PANE_2 = 2;
const PANE_3 = 3;
const PANE_4 = 4;
const PANE_INDICES_5 = [PANE_0, PANE_1, PANE_2, PANE_3, PANE_4] as const;

const opcodeReverse = {
	replace: "replace",
	insert: "delete",
	delete: "insert",
	conflict: "conflict",
	equal: "equal",
} as const;

function reverseChunk(chunk: DiffChunk): DiffChunk {
	const tag = opcodeReverse[chunk.tag as keyof typeof opcodeReverse];
	return {
		tag,
		startA: chunk.startB,
		endA: chunk.endB,
		startB: chunk.startA,
		endB: chunk.endA,
	};
}

function consumeBlankLines(
	chunk: DiffChunk | null,
	texts: (readonly string[])[],
	pane1: number,
	pane2: number,
): DiffChunk | null {
	if (!chunk) {
		return null;
	}

	const findBlankLines = (
		txt: readonly string[],
		startLine: number,
		endLine: number,
	): [number, number] => {
		let lo = startLine;
		let hi = endLine;
		while (lo < hi && !txt[lo]) {
			lo++;
		}
		while (lo < hi && !txt[hi - 1]) {
			hi--;
		}
		return [lo, hi];
	};

	let tag = chunk.tag;
	const txt1 = texts[pane1];
	const txt2 = texts[pane2];
	if (!(txt1 && txt2)) {
		return chunk;
	}

	const [c1, c2] = findBlankLines(txt1, chunk.startA, chunk.endA);
	const [c3, c4] = findBlankLines(txt2, chunk.startB, chunk.endB);

	if (c1 === c2 && c3 === c4) {
		return null;
	}
	if (c1 === c2 && tag === "replace") {
		tag = "insert";
	} else if (c3 === c4 && tag === "replace") {
		tag = "delete";
	}

	return { tag, startA: c1, endA: c2, startB: c3, endB: c4 };
}

type LineCacheEntry = [number | null, number | null, number | null];

class Differ {
	_matcher = MyersSequenceMatcher;
	_syncMatcher = SyncPointMyersSequenceMatcher;

	numSequences = 0;
	seqLength: [number, number, number, number, number] = [0, 0, 0, 0, 0];
	diffs: [DiffChunk[], DiffChunk[], DiffChunk[], DiffChunk[]] = [
		[],
		[],
		[],
		[],
	];
	syncPoints: [() => number, () => number][][] = [];
	conflicts: number[] = [];
	_oldMergeCache = new Set<string>();
	_changedChunks: [DiffChunk | null, DiffChunk | null] | [] = [];
	_mergeCache: [DiffChunk | null, DiffChunk | null][] = [];
	_paneChunkBounds: [
		{ index: number; start: number; end: number }[],
		{ index: number; start: number; end: number }[],
		{ index: number; start: number; end: number }[],
	] = [[], [], []];
	ignoreBlanks = false;
	_initialized = false;
	_hasMergeableChanges: [boolean, boolean, boolean, boolean] = [
		false,
		false,
		false,
		false,
	];

	listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

	on(event: string, callback: (...args: unknown[]) => void) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, []);
		}
		this.listeners.get(event)?.push(callback);
	}

	emit(event: string, ...args: unknown[]) {
		const listeners = this.listeners.get(event);
		if (listeners) {
			for (const cb of listeners) {
				cb(...args);
			}
		}
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: restoring functional code
	_updateMergeCache(texts: string[][]) {
		if (this.numSequences === THREE_PANES) {
			this._mergeCache = Array.from(
				this._mergeDiffs(this.diffs[0], this.diffs[1], texts),
			).filter(
				(pair): pair is [DiffChunk | null, DiffChunk | null] =>
					pair[0] !== null || pair[1] !== null,
			);
		} else {
			this._mergeCache = this.diffs[0].map(
				(c) => [c, null] as [DiffChunk | null, DiffChunk | null],
			);
		}

		if (this.ignoreBlanks) {
			this._mergeCache = this._mergeCache
				.map(
					(pair) =>
						[
							consumeBlankLines(pair[0], texts, 1, 0),
							consumeBlankLines(pair[1], texts, 1, 2),
						] as [DiffChunk | null, DiffChunk | null],
				)
				.filter((x) => x[0] !== null || x[1] !== null);
		}

		let mergeable0 = false;
		let mergeable1 = false;
		for (const [c0, c1] of this._mergeCache) {
			mergeable0 = mergeable0 || (c0 !== null && c0.tag !== "conflict");
			mergeable1 = mergeable1 || (c1 !== null && c1.tag !== "conflict");
			if (mergeable0 && mergeable1) {
				break;
			}
		}
		this._hasMergeableChanges = [false, mergeable0, mergeable1, false];

		this.conflicts = [];
		for (let i = 0; i < this._mergeCache.length; i++) {
			const pair = this._mergeCache[i];
			if (
				pair &&
				(pair[0]?.tag === "conflict" || pair[1]?.tag === "conflict")
			) {
				this.conflicts.push(i);
			}
		}

		this._updatePaneChunkBounds();
		this.emit("diffs-changed", null);
	}

	private _pushBound(
		pane: 0 | 1 | 2,
		index: number,
		start: number,
		end: number,
	) {
		this._paneChunkBounds[pane].push({
			index,
			start,
			end: start === end ? end + 1 : end,
		});
	}

	private _updatePaneChunkBounds() {
		this._paneChunkBounds = [[], [], []];
		for (let i = 0; i < this._mergeCache.length; i++) {
			const pair = this._mergeCache[i];
			if (!pair) {
				continue;
			}

			if (pair[0]) {
				this._pushBound(0, i, pair[0].startB, pair[0].endB);
			}

			const p1 = pair[0] || pair[1];
			if (p1) {
				this._pushBound(1, i, p1.startA, p1.endA);
			}

			if (pair[1]) {
				this._pushBound(2, i, pair[1].startB, pair[1].endB);
			}
		}
	}

	changeSequence(
		sequence: number,
		startidx: number,
		sizechange: number,
		texts: string[][],
	) {
		const t0 = performance.now();
		if (sequence === PANE_0 || sequence === PANE_1) {
			this._changeSequence({
				which: 0,
				sequence,
				startidx,
				sizechange,
				texts,
			});
		}
		if (
			sequence === PANE_2 ||
			(sequence === PANE_1 && this.numSequences === THREE_PANES)
		) {
			this._changeSequence({
				which: 1,
				sequence,
				startidx,
				sizechange,
				texts,
			});
		}
		if (sequence >= PANE_0 && sequence < PANE_INDICES_5.length) {
			this.seqLength[sequence as 0 | 1 | 2 | 3 | 4] += sizechange;
		}

		this._updateMergeCacheOnSequenceChange(
			sequence,
			startidx,
			sizechange,
			texts,
		);
		const w = window as unknown as Record<string, unknown>;
		// biome-ignore lint/complexity/useLiteralKeys: TypeScript noPropertyAccessFromIndexSignature requires bracket notation for Record<string,unknown>
		const stats = w["__WELD_PERF_STATS__"] as
			| { diffTimes: number[] }
			| undefined;
		if (stats) {
			stats.diffTimes.push(performance.now() - t0);
		}
	}

	_updateMergeCacheOnSequenceChange(
		sequence: number,
		startidx: number,
		sizechange: number,
		texts: string[][],
	) {
		this._oldMergeCache.clear();
		this._changedChunks = [];
		let chunkChanged = false;

		for (let i = 0; i < this._mergeCache.length; i++) {
			const pair = this._mergeCache[i];
			if (!pair) {
				continue;
			}
			const [c1, c2] = this._offsetPair(
				pair,
				sequence,
				startidx,
				sizechange,
			);

			if (this._isChunkChanged(pair, sequence, startidx)) {
				chunkChanged = true;
			}

			if (chunkChanged) {
				this._changedChunks = [c1, c2];
				chunkChanged = false;
			}
			this._mergeCache[i] = [c1, c2];
		}
		this._updateMergeCache(texts);
	}

	private _offsetPair(
		pair: [DiffChunk | null, DiffChunk | null],
		sequence: number,
		startidx: number,
		sizechange: number,
	): [DiffChunk | null, DiffChunk | null] {
		let [c1, c2] = pair;
		if (sequence === PANE_0) {
			c1 = this._offsetChunkB(c1, startidx, sizechange);
		} else if (sequence === PANE_2) {
			c2 = this._offsetChunkB(c2, startidx, sizechange);
		} else {
			c1 = this._offsetChunkA(c1, startidx, sizechange);
			if (this.numSequences === THREE_PANES) {
				c2 = this._offsetChunkA(c2, startidx, sizechange);
			}
		}
		return [c1, c2];
	}

	private _isChunkChanged(
		pair: [DiffChunk | null, DiffChunk | null],
		sequence: number,
		startidx: number,
	): boolean {
		const [c1, c2] = pair;
		if (sequence === PANE_0) {
			return Boolean(c1 && c1.startB <= startidx && startidx < c1.endB);
		}
		if (sequence === PANE_2) {
			return Boolean(c2 && c2.startB <= startidx && startidx < c2.endB);
		}
		return Boolean(c1 && c1.startA <= startidx && startidx < c1.endA);
	}

	private _offsetChunkB(
		c: DiffChunk | null,
		start: number,
		offset: number,
	): DiffChunk | null {
		if (!c) {
			return null;
		}
		return {
			...c,
			startB: c.startB + (c.startB > start ? offset : 0),
			endB: c.endB + (c.endB > start ? offset : 0),
		};
	}

	private _offsetChunkA(
		c: DiffChunk | null,
		start: number,
		offset: number,
	): DiffChunk | null {
		if (!c) {
			return null;
		}
		return {
			...c,
			startA: c.startA + (c.startA > start ? offset : 0),
			endA: c.endA + (c.endA > start ? offset : 0),
		};
	}

	_locateChunk(
		whichDiffs: 0 | 1 | 2 | 3,
		sequence: number,
		line: number,
	): number {
		const diffsSub = this.diffs[whichDiffs];
		for (let i = 0; i < diffsSub.length; i++) {
			const c = diffsSub[i];
			if (!c) {
				continue;
			}
			const highIndexVal = sequence === 1 ? c.endA : c.endB;
			if (line < highIndexVal) {
				return i;
			}
		}
		return diffsSub.length;
	}

	getChunk(
		index: number,
		fromPane: number,
		toPane: number | null = null,
	): DiffChunk | null {
		const sequence = fromPane === 2 || toPane === 2 ? 1 : 0;
		const pair = this._mergeCache[index];
		if (!pair) {
			return null;
		}
		let chunk = pair[sequence as 0 | 1];
		if (fromPane === 0 || fromPane === 2) {
			return chunk ? reverseChunk(chunk) : null;
		}
		if (toPane === null && !chunk) {
			chunk = pair[1];
		}
		return chunk;
	}

	private _binarySearchChunk(
		boundsArray: { index: number; start: number; end: number }[],
		line: number,
	) {
		let low = 0;
		let high = boundsArray.length - 1;
		let foundIndex: number | null = null;
		let nearestIdx = -1;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const b = boundsArray[mid];
			if (!b) {
				break;
			}

			if (line >= b.start && line < b.end) {
				foundIndex = b.index;
				nearestIdx = mid;
				break;
			}
			if (line < b.start) {
				high = mid - 1;
				nearestIdx = mid;
			} else {
				low = mid + 1;
				nearestIdx = mid;
			}
		}
		return { foundIndex, nearestIdx };
	}

	private _resolveChunkNeighbors(
		boundsArray: { index: number; start: number; end: number }[],
		line: number,
		foundIndex: number | null,
		nearestIdx: number,
	) {
		const prevB = boundsArray[nearestIdx - 1];
		const currB = boundsArray[nearestIdx];
		const nextB = boundsArray[nearestIdx + 1];

		if (foundIndex !== null) {
			return {
				prevIndex: prevB ? prevB.index : null,
				nextIndex: nextB ? nextB.index : null,
			};
		}

		if (nearestIdx !== -1 && currB) {
			if (line < currB.start) {
				return {
					prevIndex: prevB ? prevB.index : null,
					nextIndex: currB.index,
				};
			}
			return {
				prevIndex: currB.index,
				nextIndex: nextB ? nextB.index : null,
			};
		}

		return { prevIndex: null, nextIndex: null };
	}

	locateChunk(pane: number, line: number): LineCacheEntry {
		if (pane < 0 || pane > 2) {
			return [null, null, null];
		}
		const boundsArray = this._paneChunkBounds[pane as 0 | 1 | 2];
		if (!boundsArray || boundsArray.length === 0) {
			return [null, null, null];
		}

		const { foundIndex, nearestIdx } = this._binarySearchChunk(
			boundsArray,
			line,
		);
		const { prevIndex, nextIndex } = this._resolveChunkNeighbors(
			boundsArray,
			line,
			foundIndex,
			nearestIdx,
		);

		return [foundIndex, prevIndex, nextIndex];
	}

	allChanges() {
		return this._mergeCache.slice();
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: restoring functional code
	private _changeSequence(params: {
		which: number;
		sequence: number;
		startidx: number;
		sizechange: number;
		texts: string[][];
	}) {
		const { which, sequence, startidx, sizechange, texts } = params;
		if (which < 0 || which >= NUM_DIFFS) {
			return;
		}
		const diffs = this.diffs[which as 0 | 1 | 2 | 3];
		const x = (which === 0 ? 0 : 2) as 0 | 2;
		const linesAdded: [number, number, number, number, number] = [
			0, 0, 0, 0, 0,
		];
		if (sequence >= 0 && sequence < NUM_PANES) {
			linesAdded[sequence as 0 | 1 | 2 | 3 | 4] = sizechange;
		}

		// 1. Identify chunks affected by the change (plus one neighbor on each side for stability)
		let loidx = this._locateChunk(
			which as 0 | 1 | 2 | 3,
			sequence,
			startidx,
		);
		let hiidx = loidx;
		if (sizechange < 0) {
			hiidx = this._locateChunk(
				which as 0 | 1 | 2 | 3,
				sequence,
				startidx - sizechange,
			);
		}

		let lorange: [number, number];
		if (loidx > 0) {
			loidx -= 1;
			const chunk = diffs[loidx];
			if (chunk) {
				lorange = [chunk.startB, chunk.startA];
			} else {
				lorange = [0, 0];
			}
		} else {
			lorange = [0, 0];
		}

		let hirange: [number, number];
		if (hiidx < diffs.length) {
			hiidx += 1;
			const chunk = diffs[hiidx - 1]; // Use original coordinate from before expansion
			if (chunk) {
				hirange = [chunk.endB, chunk.endA];
			} else {
				hirange = [this.seqLength[x], this.seqLength[1]];
			}
		} else {
			hirange = [this.seqLength[x], this.seqLength[1]];
		}

		// 2. Determine actual line ranges for re-diffing (applying offsets for shifts in the new text)
		const rangex: [number, number] = [
			lorange[0],
			hirange[0] + linesAdded[x],
		];
		const range1: [number, number] = [
			lorange[1],
			hirange[1] + linesAdded[1],
		];

		const lines1 = texts[1]?.slice(range1[0], range1[1]) ?? [];
		const linesx = texts[x]?.slice(rangex[0], rangex[1]) ?? [];

		const offsetValue = (
			c: DiffChunk,
			o1: number,
			o2: number,
		): DiffChunk => ({
			tag: c.tag,
			startA: c.startA + o1,
			endA: c.endA + o1,
			startB: c.startB + o2,
			endB: c.endB + o2,
		});

		// 3. Perform re-diff and offset back to global coordinates
		let newdiffs = new this._matcher(
			null,
			lines1,
			linesx,
		).getDifferenceOpcodes();
		newdiffs = newdiffs.map((c) => offsetValue(c, range1[0], rangex[0]));

		// 4. Offset subsequent chunks and splice in the results
		if (hiidx < diffs.length) {
			const offsetDiffs = diffs
				.slice(hiidx)
				.map((c) => offsetValue(c, linesAdded[1], linesAdded[x]));
			this.diffs[which as 0 | 1 | 2 | 3].splice(
				hiidx,
				diffs.length - hiidx,
				...offsetDiffs,
			);
		}

		this.diffs[which as 0 | 1 | 2 | 3].splice(
			loidx,
			hiidx - loidx,
			...newdiffs,
		);
	}

	_mergeBlocks(
		using: [DiffChunk[], DiffChunk[]],
	): [number, number, number, number, number, number] {
		const u0 = using[0];
		const u1 = using[1];
		const u0First = u0[0];
		const u1First = u1[0];
		const u0Last = u0.at(-1);
		const u1Last = u1.at(-1);

		if (!u0First) {
			throw new Error("Invalid merge block: missing first chunk (0)");
		}
		if (!u1First) {
			throw new Error("Invalid merge block: missing first chunk (1)");
		}
		if (!u0Last) {
			throw new Error("Invalid merge block: missing last chunk (0)");
		}
		if (!u1Last) {
			throw new Error("Invalid merge block: missing last chunk (1)");
		}

		const lowc = Math.min(u0First.startA, u1First.startA);
		const highc = Math.max(u0Last.endA, u1Last.endA);

		const low: [number, number] = [0, 0];
		const high: [number, number] = [0, 0];

		// For dFirst[0] (seq 0)
		low[0] = lowc - u0First.startA + u0First.startB;
		high[0] = highc - u0Last.endA + u0Last.endB;

		// For dFirst[1] (seq 1)
		low[1] = lowc - u1First.startA + u1First.startB;
		high[1] = highc - u1Last.endA + u1Last.endB;

		return [low[0], high[0], lowc, highc, low[1], high[1]];
	}

	*_autoMerge(
		using: [DiffChunk[], DiffChunk[]],
		texts: string[][],
	): Generator<[DiffChunk, DiffChunk]> {
		const [l0, h0, l1, h1, l2, h2] = this._mergeBlocks(using);

		let matches = h0 - l0 === h2 - l2;
		if (matches) {
			const t0 = texts[PANE_0];
			const t2 = texts[PANE_2];
			if (t0 && t2) {
				for (let i = 0; i < h0 - l0; i++) {
					if (t0[l0 + i] !== t2[l2 + i]) {
						matches = false;
						break;
					}
				}
			} else {
				matches = false;
			}
		}

		const tag = this._getAutoMergeTag({
			matches,
			l0,
			h0,
			l1,
			h1,
		});

		const out0: DiffChunk = {
			tag,
			startA: l1,
			endA: h1,
			startB: l0,
			endB: h0,
		};
		const out1: DiffChunk = {
			tag,
			startA: l1,
			endA: h1,
			startB: l2,
			endB: h2,
		};
		yield [out0, out1];
	}

	private _getAutoMergeTag(params: {
		matches: boolean;
		l0: number;
		h0: number;
		l1: number;
		h1: number;
	}): DiffChunkTag {
		const { matches, l0, h0, l1, h1 } = params;
		if (!matches) {
			return "conflict";
		}
		if (l1 !== h1 && l0 === h0) {
			return "delete";
		}
		if (l1 !== h1) {
			return "replace";
		}
		return "insert";
	}

	*_mergeDiffs(
		seq0: DiffChunk[],
		seq1: DiffChunk[],
		texts: string[][],
	): Generator<[DiffChunk | null, DiffChunk | null]> {
		const s0 = seq0.slice();
		const s1 = seq1.slice();
		const seqs: [DiffChunk[], DiffChunk[]] = [s0, s1];

		while (s0.length > 0 || s1.length > 0) {
			const highSeq = this._findHighSeq(s0, s1);
			const seqArr = seqs[highSeq];
			if (!seqArr) {
				break;
			}
			const highDiff = seqArr.shift();
			if (!highDiff) {
				break;
			}

			let highMark = highDiff.endA;
			const using: [DiffChunk[], DiffChunk[]] = [[], []];
			using[highSeq].push(highDiff);

			const result = this._collectOverlappingChunks({
				seqs,
				highSeq,
				highMark,
				highDiff,
				using,
			});
			highMark = result.highMark;

			yield* this._yieldMergeDiffs(using, texts);
		}
	}

	private *_yieldMergeDiffs(
		using: [DiffChunk[], DiffChunk[]],
		texts: string[][],
	): Generator<[DiffChunk | null, DiffChunk | null]> {
		if (using[PANE_0].length === 0) {
			const first1 = using[PANE_1][0];
			if (first1) {
				yield [null, first1];
			}
		} else if (using[PANE_1].length === 0) {
			const first0 = using[PANE_0][0];
			if (first0) {
				yield [first0, null];
			}
		} else {
			yield* this._autoMerge(using, texts);
		}
	}

	private _findHighSeq(s0: DiffChunk[], s1: DiffChunk[]): 0 | 1 {
		const first0 = s0[0];
		const first1 = s1[0];
		if (!first0) {
			return 1;
		}
		if (!first1) {
			return 0;
		}
		if (first0.startA > first1.startA) {
			return 1;
		}
		if (first0.startA < first1.startA) {
			return 0;
		}
		if (first0.tag === "insert") {
			return 0;
		}
		if (first1.tag === "insert") {
			return 1;
		}
		return 0;
	}

	private _collectOverlappingChunks(params: {
		seqs: [DiffChunk[], DiffChunk[]];
		highSeq: 0 | 1;
		highMark: number;
		highDiff: DiffChunk;
		using: [DiffChunk[], DiffChunk[]];
	}) {
		const { seqs, highSeq, highMark, highDiff, using } = params;
		let currentHighSeq = highSeq;
		let currentHighMark = highMark;
		let currentHighDiff = highDiff;

		while (true) {
			const otherSeq: 0 | 1 = currentHighSeq === 1 ? 0 : 1;
			const otherSeqArr = seqs[otherSeq];
			const otherDiff = otherSeqArr?.[0];
			if (
				this._shouldStopCollecting(
					otherDiff,
					currentHighMark,
					currentHighDiff,
				)
			) {
				break;
			}
			if (otherDiff) {
				using[otherSeq].push(otherDiff);
				otherSeqArr?.shift();

				if (currentHighMark < otherDiff.endA) {
					currentHighSeq = otherSeq;
					currentHighMark = otherDiff.endA;
					currentHighDiff = otherDiff;
				}
			}
		}
		return { highMark: currentHighMark };
	}

	private _shouldStopCollecting(
		otherDiff: DiffChunk | undefined,
		currentHighMark: number,
		currentHighDiff: DiffChunk,
	): boolean {
		if (!otherDiff) {
			return true;
		}
		if (currentHighMark < otherDiff.startA) {
			return true;
		}
		if (currentHighMark === otherDiff.startA) {
			return (
				currentHighDiff.tag !== "insert" || otherDiff.tag !== "insert"
			);
		}
		return false;
	}

	setSequences(sequences: string[][]): void {
		this.diffs = [[], [], [], []];
		this.numSequences = sequences.length;
		this.seqLength = [0, 0, 0, 0, 0];
		for (
			let i = 0;
			i < this.numSequences && i < PANE_INDICES_5.length;
			i++
		) {
			this.seqLength[i] = sequences[i]?.length ?? 0;
		}

		const seq1 = sequences[PANE_1] || [];
		for (let i = 0; i < this.numSequences - 1 && i < PANE_3 + 1; i++) {
			let matcher:
				| MyersSequenceMatcher<string>
				| SyncPointMyersSequenceMatcher<string>;
			const otherSeq = sequences[i * 2] || [];
			if (this.syncPoints.length > 0) {
				const syncPoints: [number, number][] = this.syncPoints
					.map((s) => {
						const pair = s[i];
						return pair
							? ([pair[0](), pair[1]()] as [number, number])
							: null;
					})
					.filter((p): p is [number, number] => p !== null);
				matcher = new this._syncMatcher(
					null,
					seq1,
					otherSeq,
					syncPoints,
				);
			} else {
				matcher = new this._matcher(null, seq1, otherSeq);
			}

			matcher.initialize();
			this.diffs[i as 0 | 1 | 2 | 3] = matcher.getDifferenceOpcodes();
		}
		this._initialized = true;
		this._updateMergeCache(sequences);
	}

	clear() {
		this.diffs = [[], [], [], []];
		this.seqLength = [0, 0, 0, 0, 0];
		this._initialized = false;
		this._oldMergeCache.clear();
		this._updateMergeCache([[], [], [], [], []]);
	}
}

export { Differ };
