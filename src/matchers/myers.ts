// biome-ignore-all lint: Legacy ported logic
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

export type DiffChunkTag =
	| "replace"
	| "delete"
	| "insert"
	| "conflict"
	| "equal";

type MyersNode = [MyersNode | null, number, number, number] | null;

export interface DiffChunk {
	tag: DiffChunkTag;
	startA: number;
	endA: number;
	startB: number;
	endB: number;
}

export function findCommonPrefix<T>(a: T[] | string, b: T[] | string): number {
	if (!a.length || !b.length) return 0;
	if (a[0] === b[0]) {
		let pointermax = Math.min(a.length, b.length);
		let pointermid = pointermax;
		let pointermin = 0;
		while (pointermin < pointermid) {
			let matches = true;
			for (let i = pointermin; i < pointermid; i++) {
				if (a[i] !== b[i]) {
					matches = false;
					break;
				}
			}
			if (matches) {
				pointermin = pointermid;
			} else {
				pointermax = pointermid;
			}
			pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
		}
		return pointermid;
	}
	return 0;
}

export function findCommonSuffix<T>(a: T[] | string, b: T[] | string): number {
	if (!a.length || !b.length) return 0;
	if (a[a.length - 1] === b[b.length - 1]) {
		let pointermax = Math.min(a.length, b.length);
		let pointermid = pointermax;
		let pointermin = 0;
		while (pointermin < pointermid) {
			let matches = true;
			for (let i = 0; i < pointermid - pointermin; i++) {
				if (
					a[a.length - pointermid + i] !==
					b[b.length - pointermid + i]
				) {
					matches = false;
					break;
				}
			}
			if (matches) {
				pointermin = pointermid;
			} else {
				pointermax = pointermid;
			}
			pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
		}
		return pointermid;
	}
	return 0;
}

export class MyersSequenceMatcher<T> {
	isjunk: ((val: T) => boolean) | null;
	a: T[] | string;
	b: T[] | string;
	matchingBlocks: [number, number, number][] | null = null;
	opcodes: DiffChunk[] | null = null;
	aindex: number[] | null = [];
	bindex: number[] | null = [];
	commonPrefix: number = 0;
	commonSuffix: number = 0;
	linesDiscarded: boolean = false;

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

		let i = 0,
			j = 0;
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

		const index_matching = (
			a_seq: T[] | string,
			b_seq: T[] | string,
		): [T[] & string, number[]] => {
			const aset = new Set<T | string>();
			for (let i = 0; i < a_seq.length; i++) aset.add(a_seq[i]!);

			const matches: (T | string)[] = [];
			const index: number[] = [];
			for (let i = 0; i < b_seq.length; i++) {
				if (aset.has(b_seq[i]!)) {
					matches.push(b_seq[i]!);
					index.push(i);
				}
			}
			return [
				typeof b_seq === "string"
					? (matches.join("") as unknown as T[] & string)
					: (matches as unknown as T[] & string),
				index,
			];
		};

		let indexed_b: T[] | string;
		let indexed_a: T[] | string;
		[indexed_b, this.bindex] = index_matching(a, b);
		[indexed_a, this.aindex] = index_matching(b, a);

		this.linesDiscarded =
			b.length - indexed_b.length > 10 ||
			a.length - indexed_a.length > 10;
		if (this.linesDiscarded) {
			a = indexed_a;
			b = indexed_b;
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
			let [cur_a, cur_b, cur_len] = (
				this.matchingBlocks as [number, number, number][]
			)[i]!;
			i -= 1;
			while (i >= 0) {
				const [prev_a, prev_b, prev_len] = (
					this.matchingBlocks as [number, number, number][]
				)[i]!;
				if (
					prev_b + prev_len === cur_b ||
					prev_a + prev_len === cur_a
				) {
					const prev_slice_a = this.a.slice(cur_a - prev_len, cur_a);
					const prev_slice_b = this.b.slice(cur_b - prev_len, cur_b);

					let slices_match =
						prev_slice_a.length === prev_slice_b.length;
					if (slices_match) {
						for (let k = 0; k < prev_slice_a.length; k++) {
							if (prev_slice_a[k] !== prev_slice_b[k]) {
								slices_match = false;
								break;
							}
						}
					}

					if (slices_match) {
						cur_b -= prev_len;
						cur_a -= prev_len;
						cur_len += prev_len;
						i -= 1;
						continue;
					}
				}
				break;
			}
			mb.push([cur_a, cur_b, cur_len]);
		}
		mb.reverse();
		this.matchingBlocks = mb;
	}

	buildMatchingBlocks(lastsnake: MyersNode): void {
		const matchingBlocks: [number, number, number][] = [];
		this.matchingBlocks = matchingBlocks;

		const commonPrefix = this.commonPrefix;
		const commonSuffix = this.commonSuffix;
		const aindex = this.aindex as number[];
		const bindex = this.bindex as number[];

		while (lastsnake !== null) {
			const [prevsnake, x_val, y_val, snake_val] = lastsnake;
			let x = x_val;
			let y = y_val;
			const snake = snake_val;

			if (this.linesDiscarded) {
				x += snake - 1;
				y += snake - 1;
				let xprev = aindex[x]! + commonPrefix;
				let yprev = bindex[y]! + commonPrefix;
				if (snake > 1) {
					let newsnake = 1;
					for (let i = 1; i < snake; i++) {
						x -= 1;
						y -= 1;
						const xnext = aindex[x]! + commonPrefix;
						const ynext = bindex[y]! + commonPrefix;
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
			} else {
				matchingBlocks.unshift([
					x + commonPrefix,
					y + commonPrefix,
					snake,
				]);
			}
			lastsnake = prevsnake;
		}

		if (commonPrefix) {
			matchingBlocks.unshift([0, 0, commonPrefix]);
		}
		if (commonSuffix) {
			matchingBlocks.push([
				this.a.length - commonSuffix,
				this.b.length - commonSuffix,
				commonSuffix,
			]);
		}
		matchingBlocks.push([this.a.length, this.b.length, 0]);

		this.aindex = null;
		this.bindex = null;
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

				let yv = -1;
				let node: MyersNode = null;
				for (let km = dmin - p; km < delta; km++) {
					const t = fp[km + 1]!;
					if (yv < t[0]) {
						yv = t[0];
						node = t[1];
					} else {
						yv += 1;
					}
					let x = yv - km + middle;
					if (x < m && yv < n && a[x] === b[yv]) {
						let snake = x;
						x += 1;
						yv += 1;
						while (x < m && yv < n && a[x] === b[yv]) {
							x += 1;
							yv += 1;
						}
						snake = x - snake;
						node = [node, x - snake, yv - snake, snake];
					}
					fp[km] = [yv, node];
				}

				let yh = -1;
				node = null;
				for (let km = dmax + p; km > delta; km--) {
					const t = fp[km - 1]!;
					if (yh <= t[0]) {
						yh = t[0];
						node = t[1];
						yh += 1;
					}
					let x = yh - km + middle;
					if (x < m && yh < n && a[x] === b[yh]) {
						let snake = x;
						x += 1;
						yh += 1;
						while (x < m && yh < n && a[x] === b[yh]) {
							x += 1;
							yh += 1;
						}
						snake = x - snake;
						node = [node, x - snake, yh - snake, snake];
					}
					fp[km] = [yh, node];
				}

				let y: number;
				if (yv < yh) {
					const t = fp[delta + 1]!;
					y = t[0];
					node = t[1];
				} else {
					const t = fp[delta - 1]!;
					y = t[0] + 1;
					node = t[1];
				}

				let x = y - delta + middle;
				if (x < m && y < n && a[x] === b[y]) {
					let snake = x;
					x += 1;
					y += 1;
					while (x < m && y < n && a[x] === b[y]) {
						x += 1;
						y += 1;
					}
					snake = x - snake;
					node = [node, x - snake, y - snake, snake];
				}
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

		const index_matching_kmers = (
			a_seq: T[] | string,
			b_seq: T[] | string,
		): [T[] & string, number[]] => {
			const aset = new Set<string>();
			for (let i = 0; i < a_seq.length - 2; i++) {
				if (typeof a_seq === "string") {
					aset.add(a_seq.substring(i, i + 3));
				} else {
					aset.add(a_seq.slice(i, i + 3).join(","));
				}
			}

			const matches: (T | string)[] = [];
			const index: number[] = [];
			let nextPossMatch = 0;

			for (let i = 2; i < b_seq.length; i++) {
				let triplet: string;
				if (typeof b_seq === "string") {
					triplet = b_seq.substring(i - 2, i + 1);
				} else {
					triplet = b_seq.slice(i - 2, i + 1).join(",");
				}

				if (!aset.has(triplet)) {
					continue;
				}

				for (let j = Math.max(nextPossMatch, i - 2); j <= i; j++) {
					matches.push(b_seq[j]!);
					index.push(j);
				}
				nextPossMatch = i + 1;
			}
			return [
				typeof b_seq === "string"
					? (matches.join("") as unknown as T[] & string)
					: (matches as unknown as T[] & string),
				index,
			];
		};

		let indexed_b: T[] | string;
		let indexed_a: T[] | string;
		[indexed_b, this.bindex] = index_matching_kmers(a, b);
		[indexed_a, this.aindex] = index_matching_kmers(b, a);

		this.linesDiscarded =
			b.length - indexed_b.length > 10 ||
			a.length - indexed_a.length > 10;
		if (this.linesDiscarded) {
			a = indexed_a;
			b = indexed_b;
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
			for (const i of super.initialize()) {
				yield i;
			}
		} else {
			const chunks: [number, number, T[] | string, T[] | string][] = [];
			let ai = 0;
			let bi = 0;
			for (const [aj, bj] of this.syncpoints) {
				chunks.push([
					ai,
					bi,
					this.a.slice(ai, aj),
					this.b.slice(bi, bj),
				]);
				ai = aj;
				bi = bj;
			}
			if (ai < this.a.length || bi < this.b.length) {
				chunks.push([ai, bi, this.a.slice(ai), this.b.slice(bi)]);
			}

			this.splitMatchingBlocks = [];
			this.matchingBlocks = [];
			for (const [chunkAi, chunkBi, a, b] of chunks) {
				const matchingBlocks: [number, number, number][] = [];
				const matcher = new MyersSequenceMatcher<T>(this.isjunk, a, b);
				for (const _ of matcher.initialize()) {
					yield null;
				}
				const blocks = matcher.getMatchingBlocks();
				for (let idx = 0; idx < blocks.length - 1; idx++) {
					const [x, y, length] = blocks[idx]!;
					matchingBlocks.push([chunkAi + x, chunkBi + y, length]);
				}
				this.matchingBlocks.push(...matchingBlocks);
				const a_len = a.length;
				const b_len = b.length;
				this.splitMatchingBlocks.push([
					...matchingBlocks,
					[chunkAi + a_len, chunkBi + b_len, 0],
				]);
			}
			this.matchingBlocks.push([this.a.length, this.b.length, 0]);
			yield 1;
		}
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
		}
		return this.opcodes;
	}
}
