// Copyright (C) 2009-2010 Piotr Piastucki <the_leech@users.berlios.de>
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

import { Differ } from "./diffutil";
import {
	MyersSequenceMatcher,
	type DiffChunk,
	type DiffChunkTag,
} from "./myers";

class AutoMergeDiffer extends Differ {
	auto_merge: boolean = false;
	unresolved: number[] = [];

	constructor() {
		super();
		this._matcher = MyersSequenceMatcher;
	}

	*_auto_merge(
		using: DiffChunk[][],
		texts: string[][],
	): Generator<[DiffChunk, DiffChunk]> {
		for (const [out0_orig, out1_orig] of super._auto_merge(using, texts)) {
			let out0 = out0_orig;
			let out1 = out1_orig;

			if (this.auto_merge && out0.tag === "conflict") {
				const l0 = out0.start_b,
					h0 = out0.end_b;
				const l1 = out0.start_a,
					h1 = out0.end_a;
				const l2 = out1.start_b,
					h2 = out1.end_b;

				const len0 = h0 - l0;
				const len1 = h1 - l1;
				const len2 = h2 - l2;

				if (
					len0 > 0 &&
					len2 > 0 &&
					(len0 === len1 || len2 === len1 || len1 === 0)
				) {
					const matcher = new this._matcher(
						null,
						texts[0].slice(l0, h0),
						texts[2].slice(l2, h2),
					);
					for (const chunk of matcher.get_opcodes()) {
						let s1 = l1;
						let e1 = l1;
						if (len0 === len1) {
							s1 += chunk.start_a;
							e1 += chunk.end_a;
						} else if (len2 === len1) {
							s1 += chunk.start_b;
							e1 += chunk.end_b;
						}

						const out0_bounds = {
							start_a: s1,
							end_a: e1,
							start_b: l0 + chunk.start_a,
							end_b: l0 + chunk.end_a,
						};
						const out1_bounds = {
							start_a: s1,
							end_a: e1,
							start_b: l2 + chunk.start_b,
							end_b: l2 + chunk.end_b,
						};

						if (chunk.tag === "equal") {
							out0 = { tag: "replace", ...out0_bounds };
							out1 = { tag: "replace", ...out1_bounds };
						} else {
							out0 = { tag: "conflict", ...out0_bounds };
							out1 = { tag: "conflict", ...out1_bounds };
						}
						yield [out0, out1];
					}
					continue;
				} else {
					let chunktype: DiffChunkTag | null = using[0][0].tag;
					for (const chunkarr of using) {
						for (const chunk of chunkarr) {
							if (chunk.tag !== chunktype) {
								chunktype = null;
								break;
							}
						}
						if (!chunktype) break;
					}

					if (chunktype === "delete") {
						let seq0: DiffChunk | null = null;
						let seq1: DiffChunk | null = null;
						let i0 = 0,
							i1 = 0,
							end0 = 0,
							end1 = 0;
						const using0 = using[0].slice();
						const using1 = using[1].slice();

						while (true) {
							if (!seq0) {
								seq0 = using0.shift() || null;
								if (!seq0) break;
								i0 = seq0.start_a;
								end0 = seq0.end_b;
							}
							if (!seq1) {
								seq1 = using1.shift() || null;
								if (!seq1) break;
								i1 = seq1.start_a;
								end1 = seq1.end_b;
							}

							const highstart = Math.max(i0, i1);
							if (i0 !== i1) {
								yield [
									{
										tag: "conflict",
										start_a: i0 - highstart + i1,
										end_a: highstart,
										start_b: seq0.start_b - highstart + i1,
										end_b: seq0.start_b,
									},
									{
										tag: "conflict",
										start_a: i1 - highstart + i0,
										end_a: highstart,
										start_b: seq1.start_b - highstart + i0,
										end_b: seq1.start_b,
									},
								];
							}

							const lowend = Math.min(seq0.end_a, seq1.end_a);
							if (highstart !== lowend) {
								yield [
									{
										tag: "delete",
										start_a: highstart,
										end_a: lowend,
										start_b: seq0.start_b,
										end_b: seq0.end_b,
									},
									{
										tag: "delete",
										start_a: highstart,
										end_a: lowend,
										start_b: seq1.start_b,
										end_b: seq1.end_b,
									},
								];
							}

							i0 = i1 = lowend;
							if (lowend === seq0.end_a) seq0 = null;
							if (lowend === seq1.end_a) seq1 = null;
						}

						if (seq0) {
							yield [
								{
									tag: "conflict",
									start_a: i0,
									end_a: seq0.end_a,
									start_b: seq0.start_b,
									end_b: seq0.end_b,
								},
								{
									tag: "conflict",
									start_a: i0,
									end_a: seq0.end_a,
									start_b: end1,
									end_b: end1 + seq0.end_a - i0,
								},
							];
						} else if (seq1) {
							yield [
								{
									tag: "conflict",
									start_a: i1,
									end_a: seq1.end_a,
									start_b: end0,
									end_b: end0 + seq1.end_a - i1,
								},
								{
									tag: "conflict",
									start_a: i1,
									end_a: seq1.end_a,
									start_b: seq1.start_b,
									end_b: seq1.end_b,
								},
							];
						}
						continue;
					}
				}
			}
			yield [out0, out1];
		}
	}

	change_sequence(
		sequence: number,
		startidx: number,
		sizechange: number,
		texts: string[][],
	) {
		if (sequence === 1) {
			let lo = 0;
			for (const c of this.unresolved) {
				if (startidx <= c) break;
				lo++;
			}
			if (lo < this.unresolved.length) {
				let hi = lo;
				if (sizechange < 0) {
					for (const c of this.unresolved.slice(lo)) {
						if (startidx - sizechange <= c) break;
						hi++;
					}
				} else if (sizechange === 0 && startidx === this.unresolved[lo]) {
					hi++;
				}

				if (hi < this.unresolved.length) {
					const shifted = this.unresolved.slice(hi).map((c) => c + sizechange);
					this.unresolved.splice(hi, this.unresolved.length - hi, ...shifted);
				}
				this.unresolved.splice(lo, hi - lo);
			}
		}
		super.change_sequence(sequence, startidx, sizechange, texts);
	}

	get_unresolved_count(): number {
		return this.unresolved.length;
	}
}

export class Merger extends Differ {
	differ: AutoMergeDiffer;
	texts: string[][] = [];

	constructor() {
		super();
		this.differ = new AutoMergeDiffer();
		this.differ.auto_merge = true;
		this.differ.unresolved = [];
	}

	*initialize(
		sequences: string[][],
		texts: string[][],
	): Generator<number | null, void, unknown> {
		const step = this.differ.set_sequences_iter(sequences);
		while (true) {
			const result = step.next();
			if (result.done) break;
			if (result.value === null) yield null;
		}
		this.texts = texts;
		yield 1;
	}

	_apply_change(
		text: ReadonlyArray<string>,
		change: DiffChunk,
		mergedtext: string[],
	): number {
		if (change.tag === "insert") {
			for (let i = change.start_b; i < change.end_b; i++) {
				mergedtext.push(text[i]);
			}
			return 0;
		} else if (change.tag === "replace") {
			for (let i = change.start_b; i < change.end_b; i++) {
				mergedtext.push(text[i]);
			}
			return change.end_a - change.start_a;
		} else {
			return change.end_a - change.start_a;
		}
	}

	*merge_3_files(
		mark_conflicts: boolean = true,
	): Generator<string | null, string | undefined, unknown> {
		this.differ.unresolved = [];
		let lastline = 0;
		let mergedline = 0;
		const mergedtext: string[] = [];
		for (const change of this.differ.all_changes()) {
			yield null;
			let low_mark = lastline;
			const ch0 = change[0];
			const ch1 = change[1];

			if (ch0 !== null) low_mark = ch0.start_a;
			if (ch1 !== null && ch1.start_a > low_mark) {
				low_mark = ch1.start_a;
			}

			for (let i = lastline; i < low_mark; i++) {
				mergedtext.push(this.texts[1][i]);
			}
			mergedline += low_mark - lastline;
			lastline = low_mark;

			if (
				ch0 !== null &&
				ch1 !== null &&
				(ch0.tag === "conflict" ||
					ch1.tag === "conflict" ||
					ch0.end_a !== ch1.end_a)
			) {
				const high_mark = Math.max(ch0.end_a, ch1.end_a);
				if (mark_conflicts) {
					if (low_mark < high_mark) {
						for (let i = low_mark; i < high_mark; i++) {
							mergedtext.push(`(??)${this.texts[1][i]}`);
							this.differ.unresolved.push(mergedline);
							mergedline += 1;
						}
					} else {
						mergedtext.push("(??)");
						this.differ.unresolved.push(mergedline);
						mergedline += 1;
					}
					lastline = high_mark;
				}
			} else if (ch0 !== null) {
				lastline += this._apply_change(this.texts[0], ch0, mergedtext);
				mergedline += ch0.end_b - ch0.start_b;
			} else if (ch1 !== null) {
				lastline += this._apply_change(this.texts[2], ch1, mergedtext);
				mergedline += ch1.end_b - ch1.start_b;
			}
		}

		const baselen = this.texts[1].length;
		for (let i = lastline; i < baselen; i++) {
			mergedtext.push(this.texts[1][i]);
		}

		yield mergedtext.join("\n");
		return undefined;
	}
}
