// Copyright (C) 2009-2013 Piotr Piastucki <the_leech@users.berlios.de>
// Copyright (C) 2012-2013 Kai Willadsen <kai.willadsen@gmail.com>
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

type MyersNode = [MyersNode | null, number, number, number] | null;

export interface DiffChunk {
	tag: DiffChunkTag;
	startA: number;
	endA: number;
	startB: number;
	endB: number;
}

export class MyersSequenceMatcher<T> {
	isjunk: ((val: T) => boolean) | null;
	a: T[] | string;
	b: T[] | string;
	matchingBlocks: [number, number, number][] | null = null;
	opcodes: DiffChunk[] | null = null;
	aindex: number[] | null = [];
	bindex: number[] | null = [];
	commonPrefix = 0;
	commonSuffix = 0;
	linesDiscarded = false;

	constructor(
		isjunk: ((val: T) => boolean) | null = null,
		a: T[] | string = [],
		b: T[] | string = [],
	) {
		if (isjunk !== null) {
			throw new Error("isjunk is not supported yet");
		}
		this.isjunk = isjunk;
		this.a = a;
		this.b = b;
	}

	getMatchingBlocks(): [number, number, number][] {
		if (this.matchingBlocks === null) {
			for (const _ of this.initialize()) {
				// consume generator
			}
		}
		return this.matchingBlocks as [number, number, number][];
	}

	getOpcodes(): DiffChunk[] {
		if (this.opcodes !== null) {
			return this.opcodes;
		}

		let i = 0;
		let j = 0;
		this.opcodes = [];
		const matchingBlocks = this.getMatchingBlocks();

		for (const [ai, bj, size] of matchingBlocks) {
			let tag: DiffChunkTag | "" = "";
			if (i < ai && j < bj) {
				tag = "replace";
			} else if (i < ai) {
				tag = "delete";
			} else if (j < bj) {
				tag = "insert";
			}
			if (tag) {
				this.opcodes.push({
					tag,
					startA: i,
					endA: ai,
					startB: j,
					endB: bj,
				});
			}
			i = ai + size;
			j = bj + size;
			if (size) {
				this.opcodes.push({
					tag: "equal",
					startA: ai,
					endA: i,
					startB: bj,
					endB: j,
				});
			}
		}
		return this.opcodes;
	}

	getDifferenceOpcodes(): DiffChunk[] {
		return this.getOpcodes().filter((chunk) => chunk.tag !== "equal");
	}

	preprocessRemovePrefixSuffix(
		a: T[] | string,
		b: T[] | string,
	): [T[] | string, T[] | string] {
		this.commonPrefix = this.commonSuffix = 0;
		this.commonPrefix = findCommonPrefix(a, b);
		if (this.commonPrefix > 0) {
			a = a.slice(this.commonPrefix);
			b = b.slice(this.commonPrefix);
		}

		if (a.length > 0 && b.length > 0) {
			this.commonSuffix = findCommonSuffix(a, b);
			if (this.commonSuffix > 0) {
				a = a.slice(0, a.length - this.commonSuffix);
				b = b.slice(0, b.length - this.commonSuffix);
			}
		}
		return [a, b];
	}

	preprocessDiscardNonmatchingLines(
		a: T[] | string,
		b: T[] | string,
	): [T[] | string, T[] | string] {
		if (a.length === 0 || b.length === 0) {
			this.aindex = [];
			this.bindex = [];
			return [a, b];
		}

		const indexMatching = (
			aSeq: T[] | string,
			bSeq: T[] | string,
		): [T[] & string, number[]] => {
			const aSet = new Set<T | string>();
			for (const item of aSeq) {
				aSet.add(item);
			}

			const matches: (T | string)[] = [];
			const index: number[] = [];
			for (let i = 0; i < bSeq.length; i++) {
				const item = bSeq[i];
				if (item !== undefined && aSet.has(item)) {
					matches.push(item);
					index.push(i);
				}
			}
			return [
				(typeof bSeq === "string" ? matches.join("") : matches) as T[] &
					string,
				index,
			];
		};

		let indexedB: T[] | string;
		let indexedA: T[] | string;
		[indexedB, this.bindex] = indexMatching(a, b);
		[indexedA, this.aindex] = indexMatching(b, a);

		this.linesDiscarded =
			b.length - indexedB.length > 10 || a.length - indexedA.length > 10;
		if (this.linesDiscarded) {
			a = indexedA;
			b = indexedB;
		}
		return [a, b];
	}

	preprocess(): [T[] | string, T[] | string] {
		const [a, b] = this.preprocessRemovePrefixSuffix(this.a, this.b);
		return this.preprocessDiscardNonmatchingLines(a, b);
	}

	postprocess() {
		const mb = [
			this.matchingBlocks?.[this.matchingBlocks.length - 1] as [
				number,
				number,
				number,
			],
		];
		let i = (this.matchingBlocks?.length ?? 0) - 2;
		while (i >= 0) {
			const block = (this.matchingBlocks as [number, number, number][])[
				i
			];
			if (!block) {
				break;
			}
			let [curA, curB, curLen] = block;
			i -= 1;
			while (i >= 0) {
				const prevBlock = (
					this.matchingBlocks as [number, number, number][]
				)[i];
				if (!prevBlock) {
					break;
				}

				const [prevA, prevB, prevLen] = prevBlock;
				if (this._canMergeBlocks(prevA, prevB, prevLen, curA, curB)) {
					curB -= prevLen;
					curA -= prevLen;
					curLen += prevLen;
					i -= 1;
					continue;
				}
				break;
			}
			mb.push([curA, curB, curLen]);
		}
		mb.reverse();
		this.matchingBlocks = mb;
	}

	protected _canMergeBlocks(
		prevA: number,
		prevB: number,
		prevLen: number,
		curA: number,
		curB: number,
	): boolean {
		if (prevB + prevLen !== curB && prevA + prevLen !== curA) {
			return false;
		}

		const prevSliceA = this.a.slice(curA - prevLen, curA);
		const prevSliceB = this.b.slice(curB - prevLen, curB);
		return this._slicesMatch(prevSliceA, prevSliceB);
	}

	protected _slicesMatch<T>(a: T[] | string, b: T[] | string): boolean {
		if (a.length !== b.length) {
			return false;
		}
		for (let k = 0; k < a.length; k++) {
			if (a[k] !== b[k]) {
				return false;
			}
		}
		return true;
	}

	buildMatchingBlocks(lastsnake: MyersNode): void {
		const matchingBlocks: [number, number, number][] = [];
		this.matchingBlocks = matchingBlocks;

		while (lastsnake !== null) {
			const [prevSnake, x, y, snake] = lastsnake;
			this._processSnake(x, y, snake, matchingBlocks);
			lastsnake = prevSnake;
		}

		if (this.commonPrefix) {
			matchingBlocks.unshift([0, 0, this.commonPrefix]);
		}
		if (this.commonSuffix) {
			matchingBlocks.push([
				this.a.length - this.commonSuffix,
				this.b.length - this.commonSuffix,
				this.commonSuffix,
			]);
		}
		matchingBlocks.push([this.a.length, this.b.length, 0]);

		this.aindex = null;
		this.bindex = null;
	}

	protected _processSnake(
		x: number,
		y: number,
		snake: number,
		matchingBlocks: [number, number, number][],
	): void {
		const commonPrefix = this.commonPrefix;
		if (this.linesDiscarded && this.aindex && this.bindex) {
			this._processDiscardedSnake(x, y, snake, matchingBlocks);
		} else {
			matchingBlocks.unshift([x + commonPrefix, y + commonPrefix, snake]);
		}
	}

	protected _processDiscardedSnake(
		x: number,
		y: number,
		snake: number,
		matchingBlocks: [number, number, number][],
	): void {
		const commonPrefix = this.commonPrefix;
		if (this.aindex === null || this.bindex === null) {
			return;
		}

		let curX = x + snake - 1;
		let curY = y + snake - 1;
		let xprev = (this.aindex[curX] ?? 0) + commonPrefix;
		let yprev = (this.bindex[curY] ?? 0) + commonPrefix;

		if (snake > 1) {
			let newsnake = 1;
			for (let i = 1; i < snake; i++) {
				curX -= 1;
				curY -= 1;
				const xnext = (this.aindex[curX] ?? 0) + commonPrefix;
				const ynext = (this.bindex[curY] ?? 0) + commonPrefix;
				if (xprev - xnext !== 1 || yprev - ynext !== 1) {
					matchingBlocks.unshift([xprev, yprev, newsnake]);
					newsnake = 0;
				}
				xprev = xnext;
				yprev = ynext;
				newsnake += 1;
			}
			matchingBlocks.unshift([xprev, yprev, newsnake]);
		} else {
			matchingBlocks.unshift([xprev, yprev, snake]);
		}
	}

	*initialize(): Generator<number | null, void, unknown> {
		const [a, b] = this.preprocess();
		const m = a.length;
		const n = b.length;
		const middle = m + 1;
		let lastsnake: MyersNode = null;
		const delta = n - m + middle;
		const dmin = Math.min(middle, delta);
		const dmax = Math.max(middle, delta);

		if (n > 0 && m > 0) {
			const size = n + m + 2;
			const fp: [number, MyersNode][] = new Array(size).fill([-1, null]);
			let p = -1;
			while (true) {
				p += 1;
				if (p % 100 === 0) {
					yield null;
				}

				this._findVerticalSnakes(a, b, {
					fp,
					startKm: dmin - p,
					delta,
					middle,
				});
				this._findHorizontalSnakes(a, b, {
					fp,
					startKm: dmax + p,
					delta,
					middle,
				});

				const [y, node] = this._findFinalSnake(a, b, {
					fp,
					delta,
					middle,
				});
				fp[delta] = [y, node];
				if (y >= n) {
					lastsnake = node;
					break;
				}
			}
		}
		this.buildMatchingBlocks(lastsnake);
		this.postprocess();
		yield 1;
	}

	protected _findVerticalSnakes(
		a: T[] | string,
		b: T[] | string,
		params: {
			fp: [number, MyersNode][];
			startKm: number;
			delta: number;
			middle: number;
		},
	): void {
		const { fp, startKm, delta, middle } = params;
		const m = a.length;
		const n = b.length;
		let yv = -1;
		let node: MyersNode = null;
		for (let km = startKm; km < delta; km++) {
			const t = fp[km + 1];
			if (t && yv < t[0]) {
				yv = t[0];
				node = t[1];
			} else {
				yv += 1;
			}
			const result = this._extendSnake(a, b, {
				y: yv,
				km,
				middle,
				node,
				m,
				n,
			});
			fp[km] = result;
			[yv, node] = result;
		}
	}

	protected _findHorizontalSnakes(
		a: T[] | string,
		b: T[] | string,
		params: {
			fp: [number, MyersNode][];
			startKm: number;
			delta: number;
			middle: number;
		},
	): void {
		const { fp, startKm, delta, middle } = params;
		const m = a.length;
		const n = b.length;
		let yh = -1;
		let node: MyersNode = null;
		for (let km = startKm; km > delta; km--) {
			const t = fp[km - 1];
			if (t && yh <= t[0]) {
				yh = t[0];
				node = t[1];
				yh += 1;
			}
			const result = this._extendSnake(a, b, {
				y: yh,
				km,
				middle,
				node,
				m,
				n,
			});
			fp[km] = result;
			[yh, node] = result;
		}
	}

	protected _findFinalSnake(
		a: T[] | string,
		b: T[] | string,
		params: { fp: [number, MyersNode][]; delta: number; middle: number },
	): [number, MyersNode] {
		const { fp, delta, middle } = params;
		const m = a.length;
		const n = b.length;
		let y: number;
		let node: MyersNode;

		const t1 = fp[delta + 1] as [number, MyersNode] | undefined;
		const t2 = fp[delta - 1] as [number, MyersNode] | undefined;
		const yv = t2 ? t2[0] : -1;
		const yh = t1 ? t1[0] : -1;

		if (yv < yh) {
			y = t1 ? t1[0] : 0;
			node = t1 ? t1[1] : null;
		} else {
			y = t2 ? t2[0] + 1 : 0;
			node = t2 ? t2[1] : null;
		}

		return this._extendSnake(a, b, { y, km: delta, middle, node, m, n });
	}

	protected _extendSnake(
		a: T[] | string,
		b: T[] | string,
		params: {
			y: number;
			km: number;
			middle: number;
			node: MyersNode;
			m: number;
			n: number;
		},
	): [number, MyersNode] {
		const { y, km, middle, m, n } = params;
		let { node } = params;
		let curX = y - km + middle;
		let curY = y;
		if (curX < m && curY < n && a[curX] === b[curY]) {
			const snakeStart = curX;
			while (curX < m && curY < n && a[curX] === b[curY]) {
				curX += 1;
				curY += 1;
			}
			const snakeLen = curX - snakeStart;
			node = [node, curX - snakeLen, curY - snakeLen, snakeLen];
		}
		return [curY, node];
	}
}

export class InlineMyersSequenceMatcher<T> extends MyersSequenceMatcher<T> {
	override preprocessDiscardNonmatchingLines(
		a: T[] | string,
		b: T[] | string,
	): [T[] | string, T[] | string] {
		if (a.length <= 2 && b.length <= 2) {
			this.aindex = [];
			this.bindex = [];
			return [a, b];
		}

		const indexMatchingKmers = (
			aSeq: T[] | string,
			bSeq: T[] | string,
		): [T[] & string, number[]] => {
			const aSet = new Set<string>();
			for (let i = 0; i < aSeq.length - 2; i++) {
				if (typeof aSeq === "string") {
					aSet.add(aSeq.substring(i, i + 3));
				} else {
					aSet.add(aSeq.slice(i, i + 3).join(","));
				}
			}

			const matches: (T | string)[] = [];
			const index: number[] = [];
			let nextPossMatch = 0;

			for (let i = 2; i < bSeq.length; i++) {
				let triplet: string;
				if (typeof bSeq === "string") {
					triplet = bSeq.substring(i - 2, i + 1);
				} else {
					triplet = bSeq.slice(i - 2, i + 1).join(",");
				}

				if (!aSet.has(triplet)) {
					continue;
				}

				for (let j = Math.max(nextPossMatch, i - 2); j <= i; j++) {
					const item = bSeq[j];
					if (item !== undefined) {
						matches.push(item);
						index.push(j);
					}
				}
				nextPossMatch = i + 1;
			}
			return [
				(typeof bSeq === "string" ? matches.join("") : matches) as T[] &
					string,
				index,
			];
		};

		let indexedB: T[] | string;
		let indexedA: T[] | string;
		[indexedB, this.bindex] = indexMatchingKmers(a, b);
		[indexedA, this.aindex] = indexMatchingKmers(b, a);

		this.linesDiscarded =
			b.length - indexedB.length > 10 || a.length - indexedA.length > 10;
		if (this.linesDiscarded) {
			a = indexedA;
			b = indexedB;
		}
		return [a, b];
	}
}

export class SyncPointMyersSequenceMatcher<T> extends MyersSequenceMatcher<T> {
	syncpoints: [number, number][] | null;
	splitMatchingBlocks: [number, number, number][][] = [];

	constructor(
		isjunk: ((val: T) => boolean) | null = null,
		a: T[] | string = [],
		b: T[] | string = [],
		syncpoints: [number, number][] | null = null,
	) {
		super(isjunk, a, b);
		this.syncpoints = syncpoints;
	}

	override *initialize(): Generator<number | null, void, unknown> {
		if (!this.syncpoints || this.syncpoints.length === 0) {
			yield* super.initialize();
		} else {
			const chunks = this._prepareChunks();
			this.splitMatchingBlocks = [];
			this.matchingBlocks = [];

			for (const [chunkAi, chunkBi, a, b] of chunks) {
				yield* this._processChunk(chunkAi, chunkBi, a, b);
			}

			this.matchingBlocks.push([this.a.length, this.b.length, 0]);
			yield 1;
		}
	}

	protected _prepareChunks(): [number, number, T[] | string, T[] | string][] {
		const chunks: [number, number, T[] | string, T[] | string][] = [];
		let ai = 0;
		let bi = 0;
		for (const [aj, bj] of this.syncpoints || []) {
			chunks.push([ai, bi, this.a.slice(ai, aj), this.b.slice(bi, bj)]);
			ai = aj;
			bi = bj;
		}
		if (ai < this.a.length || bi < this.b.length) {
			chunks.push([ai, bi, this.a.slice(ai), this.b.slice(bi)]);
		}
		return chunks;
	}

	protected *_processChunk(
		chunkAi: number,
		chunkBi: number,
		a: T[] | string,
		b: T[] | string,
	): Generator<number | null, void, unknown> {
		const matchingBlocks: [number, number, number][] = [];
		const matcher = new MyersSequenceMatcher<T>(this.isjunk, a, b);
		yield* matcher.initialize();

		const blocks = matcher.getMatchingBlocks();
		for (let idx = 0; idx < blocks.length - 1; idx++) {
			const block = blocks[idx];
			if (block) {
				const [x, y, length] = block;
				matchingBlocks.push([chunkAi + x, chunkBi + y, length]);
			}
		}

		this.matchingBlocks?.push(...matchingBlocks);
		this.splitMatchingBlocks.push([
			...matchingBlocks,
			[chunkAi + a.length, chunkBi + b.length, 0],
		]);
	}

	override getOpcodes(): DiffChunk[] {
		if (this.opcodes !== null) {
			return this.opcodes;
		}
		let i = 0;
		let j = 0;
		this.opcodes = [];
		this.getMatchingBlocks();
		for (const matchingBlocks of this.splitMatchingBlocks) {
			for (const [ai, bj, size] of matchingBlocks) {
				this._addOpcode(i, ai, j, bj);
				i = ai + size;
				j = bj + size;
				if (size) {
					this.opcodes.push({
						tag: "equal",
						startA: ai,
						endA: i,
						startB: bj,
						endB: j,
					});
				}
			}
		}
		return this.opcodes;
	}

	protected _addOpcode(i: number, ai: number, j: number, bj: number): void {
		let tag: DiffChunkTag | "" = "";
		if (i < ai && j < bj) {
			tag = "replace";
		} else if (i < ai) {
			tag = "delete";
		} else if (j < bj) {
			tag = "insert";
		}

		if (tag && this.opcodes) {
			this.opcodes.push({
				tag,
				startA: i,
				endA: ai,
				startB: j,
				endB: bj,
			});
		}
	}
}

export function findCommonPrefix<T>(a: T[] | string, b: T[] | string): number {
	const minLength = Math.min(a.length, b.length);
	for (let i = 0; i < minLength; i++) {
		if (a[i] !== b[i]) {
			return i;
		}
	}
	return minLength;
}

export function findCommonSuffix<T>(a: T[] | string, b: T[] | string): number {
	const minLength = Math.min(a.length, b.length);
	const aLen = a.length;
	const bLen = b.length;
	for (let i = 1; i <= minLength; i++) {
		if (a[aLen - i] !== b[bLen - i]) {
			return i - 1;
		}
	}
	return minLength;
}

export type DiffChunkTag =
	| "replace"
	| "delete"
	| "insert"
	| "conflict"
	| "equal";
