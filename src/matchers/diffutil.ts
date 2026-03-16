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
	_lineCache: [
		LineCacheEntry[],
		LineCacheEntry[],
		LineCacheEntry[],
		LineCacheEntry[],
		LineCacheEntry[],
	] = [[], [], [], [], []];
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

	_updateMergeCache(texts: string[][]) {
		this._computeRawMergeCache(texts);
		this._applyIgnoreBlanks(texts);
		this._calculateMergeableState();
		this._updateLineCache();
		this.emit("diffs-changed", null);
	}

	private _computeRawMergeCache(texts: string[][]) {
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
	}

	private _applyIgnoreBlanks(texts: string[][]) {
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
	}

	private _calculateMergeableState() {
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
	}

	_updateLineCache() {
		for (const i of PANE_INDICES_5) {
			this._lineCache[i] = new Array(this.seqLength[i] + 1).fill([
				null,
				null,
				null,
			]);
		}

		const prev: [number | null, number | null, number | null] = [
			null,
			null,
			null,
		];
		const next: [number | null, number | null, number | null] = [
			this._findNextChunk(0, 0, -1),
			this._findNextChunk(0, 1, -1),
			this._findNextChunk(1, 2, -1),
		];
		const oldEnd: [number, number, number] = [0, 0, 0];

		for (const [i, c] of this._mergeCache.entries()) {
			this._updateLineCacheForChunk({
				index: i,
				chunkPair: c,
				prev,
				next,
				oldEnd,
			});
		}

		this._fillRemainingLineCache(oldEnd, prev, next);
	}

	private _findNextChunk(
		diffIdx: 0 | 1,
		seq: number,
		current: number,
	): number | null {
		const lastChunk = this._mergeCache.length;
		if (seq === 1 && current + 1 < lastChunk) {
			return current + 1;
		}
		for (let j = current + 1; j < lastChunk; j++) {
			const pair = this._mergeCache[j];
			if (pair && pair[diffIdx] !== null) {
				return j;
			}
		}
		return null;
	}

	private _updateLineCacheForChunk(params: {
		index: number;
		chunkPair: [DiffChunk | null, DiffChunk | null];
		prev: [number | null, number | null, number | null];
		next: [number | null, number | null, number | null];
		oldEnd: [number, number, number];
	}) {
		const { index: i, chunkPair: c, prev, next, oldEnd } = params;
		const seqParams = [
			{
				diff: 0 as const,
				seq: 0 as const,
				getKey: (x: DiffChunk) => [x.startB, x.endB] as const,
			},
			{
				diff: 0 as const,
				seq: 1 as const,
				getKey: (x: DiffChunk) => [x.startA, x.endA] as const,
			},
			{
				diff: 1 as const,
				seq: 2 as const,
				getKey: (x: DiffChunk) => [x.startB, x.endB] as const,
			},
		] as const;

		for (const param of seqParams) {
			const { diff: diffValue, seq: seqValue, getKey } = param;
			let actualDiff: 0 | 1 = diffValue;
			let chunk = c[diffValue];
			if (chunk === null) {
				if (seqValue === 1) {
					actualDiff = 1;
					chunk = c[1];
				} else {
					continue;
				}
			}
			if (!chunk) {
				continue;
			}

			const [start, end] = getKey(chunk);
			const last = oldEnd[seqValue];
			if (start > last) {
				for (let k = last; k < start; k++) {
					this._lineCache[seqValue][k] = [
						null,
						prev[seqValue],
						next[seqValue],
					];
				}
			}

			const realEnd = start === end ? end + 1 : end;
			next[seqValue] = this._findNextChunk(actualDiff, seqValue, i);

			for (let k = start; k < realEnd; k++) {
				this._lineCache[seqValue][k] = [
					i,
					prev[seqValue],
					next[seqValue],
				];
			}

			prev[seqValue] = i;
			oldEnd[seqValue] = realEnd;
		}
	}

	private _fillRemainingLineCache(
		oldEnd: [number, number, number],
		prev: [number | null, number | null, number | null],
		next: [number | null, number | null, number | null],
	) {
		for (let seq = 0; seq < THREE_PANES; seq++) {
			const last = oldEnd[seq as 0 | 1 | 2];
			const cache = this._lineCache[seq as 0 | 1 | 2];
			if (last < cache.length) {
				for (let k = last; k < cache.length; k++) {
					cache[k] = [
						null,
						prev[seq as 0 | 1 | 2],
						next[seq as 0 | 1 | 2],
					];
				}
			}
		}
	}

	changeSequence(
		sequence: number,
		startidx: number,
		sizechange: number,
		texts: string[][],
	) {
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
	}

	_updateMergeCacheOnSequenceChange(
		_sequence: number,
		_startidx: number,
		_sizechange: number,
		texts: string[][],
	) {
		this._oldMergeCache.clear();
		this._changedChunks = [];
		this._updateMergeCache(texts);
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
			const highIndexVal = sequence !== 1 ? c.endB : c.endA;
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

	locateChunk(pane: number, line: number): LineCacheEntry {
		const cache = this._lineCache[pane as 0 | 1 | 2 | 3 | 4];
		if (cache && line < cache.length) {
			return cache[line] || [null, null, null];
		}
		return [null, null, null];
	}

	allChanges() {
		return this._mergeCache.slice();
	}

	*pairChanges(
		fromindex: number,
		toindex: number,
		lines: (number | null)[] = [null, null, null, null],
	) {
		const mergeCache = this._getMergeCacheSubset(fromindex, toindex, lines);
		if (mergeCache.length === 0) {
			return;
		}

		if (fromindex === 1) {
			const seq = Math.floor(toindex / 2);
			for (const c of mergeCache) {
				const chunk = c[seq as 0 | 1];
				if (chunk) {
					yield chunk;
				}
			}
		} else {
			const seq = Math.floor(fromindex / 2);
			for (const c of mergeCache) {
				const chunk = c[seq as 0 | 1];
				if (chunk) {
					yield reverseChunk(chunk);
				}
			}
		}
	}

	private _getMergeCacheSubset(
		fromindex: number,
		toindex: number,
		lines: (number | null)[],
	): [DiffChunk | null, DiffChunk | null][] {
		if (lines.includes(null)) {
			return this._mergeCache;
		}
		const [start1, end1] = this._rangeFromLines(fromindex, [
			lines[0] as number,
			lines[1] as number,
		]);
		const [start2, end2] = this._rangeFromLines(toindex, [
			lines[2] as number,
			lines[3] as number,
		]);
		if (
			(start1 === null || end1 === null) &&
			(start2 === null || end2 === null)
		) {
			return [];
		}
		const starts = [start1, start2].filter((x): x is number => x !== null);
		const ends = [end1, end2].filter((x): x is number => x !== null);
		const start = Math.min(...starts);
		const end = Math.max(...ends);
		return this._mergeCache.slice(start, end + 1);
	}

	_rangeFromLines(
		textindex: number,
		lines: number[],
	): [number | null, number | null] {
		const loLine = lines[0];
		const hiLine = lines[1];
		if (loLine === undefined || hiLine === undefined) {
			return [null, null];
		}
		const topChunk = this.locateChunk(textindex, loLine);
		let start = topChunk[0];
		if (start === null) {
			start = topChunk[2];
		}
		const bottomChunk = this.locateChunk(textindex, hiLine);
		let end = bottomChunk[0];
		if (end === null) {
			end = bottomChunk[1];
		}
		return [start, end];
	}

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
		const linesAdded: [number, number, number, number, number] = [
			0, 0, 0, 0, 0,
		];
		if (sequence >= 0 && sequence < NUM_PANES) {
			linesAdded[sequence as 0 | 1 | 2 | 3 | 4] = sizechange;
		}

		let loidx = this._locateChunk(
			which as 0 | 1 | 2 | 3,
			sequence,
			startidx,
		);
		if (loidx > 0) {
			loidx--;
		}
		let hiidx = this._locateChunk(
			which as 0 | 1 | 2 | 3,
			sequence,
			startidx + Math.max(0, -sizechange),
		);
		if (hiidx < diffs.length) {
			hiidx++;
		}

		const lorange = this._getLoRange(diffs, loidx);
		const x = (which === 0 ? 0 : 2) as 0 | 2;
		const hirange = this._getHiRange(diffs, hiidx, x);

		const rangex: [number, number] = [
			lorange[0],
			hirange[0] + linesAdded[x],
		];
		const range1: [number, number] = [
			lorange[1],
			hirange[1] + linesAdded[1],
		];

		const linesx = texts[x]?.slice(rangex[0], rangex[1]);
		const lines1 = texts[1]?.slice(range1[0], range1[1]);

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

		let newdiffs = new this._matcher(
			null,
			lines1,
			linesx,
		).getDifferenceOpcodes();
		newdiffs = newdiffs.map((c) => offsetValue(c, range1[0], rangex[0]));

		const offsetDiffs = diffs
			.slice(hiidx)
			.map((c) => offsetValue(c, linesAdded[1], linesAdded[x]));

		this.diffs[which as 0 | 1 | 2 | 3].splice(
			loidx,
			diffs.length - loidx,
			...newdiffs,
			...offsetDiffs,
		);
	}

	private _getLoRange(diffs: DiffChunk[], loidx: number): [number, number] {
		if (loidx > 0) {
			const prevChunk = diffs[loidx - 1];
			if (prevChunk) {
				return [prevChunk.endB, prevChunk.endA];
			}
		}
		return [0, 0];
	}

	private _getHiRange(
		diffs: DiffChunk[],
		hiidx: number,
		x: 0 | 2,
	): [number, number] {
		if (hiidx < diffs.length) {
			const nextChunk = diffs[hiidx];
			if (nextChunk) {
				return [nextChunk.startB, nextChunk.startA];
			}
		}
		return [this.seqLength[x], this.seqLength[1]];
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

	*setSequencesIter(sequences: string[][]): Generator<number | null> {
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

			const work = matcher.initialize();
			while (true) {
				const step = work.next();
				if (step.done) {
					break;
				}
				if (step.value === null) {
					yield null;
				}
				// continue initialization
			}
			this.diffs[i as 0 | 1 | 2 | 3] = matcher.getDifferenceOpcodes();
		}
		this._initialized = true;
		this._updateMergeCache(sequences);
		yield 1;
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
