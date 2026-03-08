// biome-ignore-all lint: Legacy ported logic
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
	type DiffChunk,
	type DiffChunkTag,
	MyersSequenceMatcher,
} from "./myers";

class AutoMergeDiffer extends Differ {
	autoMerge = false;
	unresolved: number[] = [];

	constructor() {
		super();
		this._matcher = MyersSequenceMatcher;
	}

	override *_autoMerge(
		using: [DiffChunk[], DiffChunk[]],
		texts: string[][],
	): Generator<[DiffChunk, DiffChunk]> {
		for (const [out0Orig, out1Orig] of super._autoMerge(using, texts)) {
			let out0 = out0Orig;
			let out1 = out1Orig;

			if (this.autoMerge && (out0.tag as string) === "conflict") {
				const l0 = out0.startB,
					h0 = out0.endB;
				const l1 = out0.startA,
					h1 = out0.endA;
				const l2 = out1.startB,
					h2 = out1.endB;

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
						texts[0]!.slice(l0, h0),
						texts[2]!.slice(l2, h2),
					);
					for (const chunk of matcher.getOpcodes()) {
						let s1 = l1;
						let e1 = l1;
						if (len0 === len1) {
							s1 += chunk.startA;
							e1 += chunk.endA;
						} else if (len2 === len1) {
							s1 += chunk.startB;
							e1 += chunk.endB;
						}

						const out0Bounds = {
							startA: s1,
							endA: e1,
							startB: l0 + chunk.startA,
							endB: l0 + chunk.endA,
						};
						const out1Bounds = {
							startA: s1,
							endA: e1,
							startB: l2 + chunk.startB,
							endB: l2 + chunk.endB,
						};

						if (chunk.tag === "equal") {
							out0 = { tag: "replace", ...out0Bounds };
							out1 = { tag: "replace", ...out1Bounds };
						} else {
							out0 = { tag: "conflict", ...out0Bounds };
							out1 = { tag: "conflict", ...out1Bounds };
						}
						yield [out0, out1];
					}
					continue;
				} else {
					let chunktype: DiffChunkTag | null =
						using[0][0]?.tag ?? null;
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
								i0 = seq0.startA;
								end0 = seq0.endB;
							}
							if (!seq1) {
								seq1 = using1.shift() || null;
								if (!seq1) break;
								i1 = seq1.startA;
								end1 = seq1.endB;
							}

							const highstart = Math.max(i0, i1);
							if (i0 !== i1) {
								yield [
									{
										tag: "conflict",
										startA: i0 - highstart + i1,
										endA: highstart,
										startB: seq0.startB - highstart + i1,
										endB: seq0.startB,
									},
									{
										tag: "conflict",
										startA: i1 - highstart + i0,
										endA: highstart,
										startB: seq1.startB - highstart + i0,
										endB: seq1.startB,
									},
								];
							}

							const lowend = Math.min(seq0.endA, seq1.endA);
							if (highstart !== lowend) {
								yield [
									{
										tag: "delete",
										startA: highstart,
										endA: lowend,
										startB: seq0.startB,
										endB: seq0.endB,
									},
									{
										tag: "delete",
										startA: highstart,
										endA: lowend,
										startB: seq1.startB,
										endB: seq1.endB,
									},
								];
							}

							i0 = i1 = lowend;
							if (lowend === seq0.endA) seq0 = null;
							if (lowend === seq1.endA) seq1 = null;
						}

						if (seq0) {
							yield [
								{
									tag: "conflict",
									startA: i0,
									endA: seq0.endA,
									startB: seq0.startB,
									endB: seq0.endB,
								},
								{
									tag: "conflict",
									startA: i0,
									endA: seq0.endA,
									startB: end1,
									endB: end1 + seq0.endA - i0,
								},
							];
						} else if (seq1) {
							yield [
								{
									tag: "conflict",
									startA: i1,
									endA: seq1.endA,
									startB: end0,
									endB: end0 + seq1.endA - i1,
								},
								{
									tag: "conflict",
									startA: i1,
									endA: seq1.endA,
									startB: seq1.startB,
									endB: seq1.endB,
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

	override changeSequence(
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
				} else if (
					sizechange === 0 &&
					startidx === this.unresolved[lo]
				) {
					hi++;
				}

				if (hi < this.unresolved.length) {
					const shifted = this.unresolved
						.slice(hi)
						.map((c) => c + sizechange);
					this.unresolved.splice(
						hi,
						this.unresolved.length - hi,
						...shifted,
					);
				}
				this.unresolved.splice(lo, hi - lo);
			}
		}
		super.changeSequence(sequence, startidx, sizechange, texts);
	}

	getUnresolvedCount(): number {
		return this.unresolved.length;
	}
}

export class Merger extends Differ {
	differ: AutoMergeDiffer;
	texts: string[][] = [];

	constructor() {
		super();
		this.differ = new AutoMergeDiffer();
		this.differ.autoMerge = true;
		this.differ.unresolved = [];
	}

	*initialize(
		sequences: string[][],
		texts: string[][],
	): Generator<number | null, void, unknown> {
		const step = this.differ.setSequencesIter(sequences);
		while (true) {
			const result = step.next();
			if (result.done) break;
			if (result.value === null) yield null;
		}
		this.texts = texts;
		yield 1;
	}

	_applyChange(
		text: readonly string[],
		change: DiffChunk,
		mergedtext: string[],
	): number {
		if (change.tag === "insert") {
			for (let i = change.startB; i < change.endB; i++) {
				mergedtext.push(text[i]!);
			}
			return 0;
		} else if (
			change.tag === "replace" ||
			(change.tag as string) === "conflict"
		) {
			for (let i = change.startB; i < change.endB; i++) {
				mergedtext.push(text[i]!);
			}
			return change.endA - change.startA;
		} else {
			return change.endA - change.startA;
		}
	}

	*merge3Files(
		markConflicts = true,
	): Generator<string | null, string | undefined, unknown> {
		this.differ.unresolved = [];
		let lastline = 0;
		let mergedline = 0;
		const mergedtext: string[] = [];
		for (const change of this.differ.allChanges()) {
			yield null;
			let lowMark = lastline;
			const ch0 = change[0];
			const ch1 = change[1];

			if (ch0 !== null) lowMark = ch0.startA;
			if (ch1 !== null && ch1.startA > lowMark) {
				lowMark = ch1.startA;
			}

			if (this.texts[1]) {
				for (let i = lastline; i < lowMark; i++) {
					mergedtext.push(this.texts[1][i]!);
				}
			}
			mergedline += lowMark - lastline;
			lastline = lowMark;

			if (
				ch0 !== null &&
				ch1 !== null &&
				((ch0.tag as string) === "conflict" ||
					(ch1.tag as string) === "conflict" ||
					ch0.endA !== ch1.endA)
			) {
				const highMark = Math.max(ch0.endA, ch1.endA);
				if (markConflicts) {
					if (lowMark < highMark) {
						if (this.texts[1]) {
							for (let i = lowMark; i < highMark; i++) {
								mergedtext.push(`(??)${this.texts[1][i]}`);
								this.differ.unresolved.push(mergedline);
								mergedline += 1;
							}
						}
					} else {
						mergedtext.push("(??)");
						this.differ.unresolved.push(mergedline);
						mergedline += 1;
					}
					lastline = highMark;
				}
			} else if (ch0 !== null) {
				lastline += this._applyChange(
					this.texts[0] || [],
					ch0,
					mergedtext,
				);
				mergedline += ch0.endB - ch0.startB;
			} else if (ch1 !== null) {
				lastline += this._applyChange(
					this.texts[2] || [],
					ch1,
					mergedtext,
				);
				mergedline += ch1.endB - ch1.startB;
			}
		}

		if (this.texts[1]) {
			const baselen = this.texts[1].length;
			for (let i = lastline; i < baselen; i++) {
				mergedtext.push(this.texts[1][i]!);
			}
		}

		return mergedtext.join("\n");
	}

	protected _calculateLowMark(
		ch0: DiffChunk | null,
		ch1: DiffChunk | null,
		lastline: number,
	): number {
		let lowMark = lastline;
		if (ch0 !== null) {
			lowMark = ch0.startA;
		}
		if (ch1 !== null && ch1.startA > lowMark) {
			lowMark = ch1.startA;
		}
		return lowMark;
	}

	protected _appendLines(
		start: number,
		end: number,
		text: readonly string[],
		mergedtext: string[],
	) {
		for (let i = start; i < end; i++) {
			const line = text[i];
			if (line !== undefined) {
				mergedtext.push(line);
			}
		}
	}

	protected _appendRemainingLines(
		lastline: number,
		text: string[],
		mergedtext: string[],
	) {
		if (lastline < text.length) {
			this._appendLines(lastline, text.length, text, mergedtext);
		}
	}
}
