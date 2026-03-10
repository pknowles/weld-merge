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

import { Differ } from "./diffutil.ts";
import {
	type DiffChunk,
	type DiffChunkTag,
	MyersSequenceMatcher,
} from "./myers.ts";

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
				const l0 = out0.startB;
				const h0 = out0.endB;
				const l1 = out0.startA;
				const h1 = out0.endA;
				const l2 = out1.startB;
				const h2 = out1.endB;

				const len0 = h0 - l0;
				const len1 = h1 - l1;
				const len2 = h2 - l2;

				if (
					len0 > 0 &&
					len2 > 0 &&
					(len0 === len1 || len2 === len1 || len1 === 0)
				) {
					const baseLines = texts[0];
					const incomingLines = texts[2];
					if (baseLines && incomingLines) {
						const matcher = new this._matcher(
							null,
							baseLines.slice(l0, h0),
							incomingLines.slice(l2, h2),
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
					}
				}

				let chunkType: DiffChunkTag | null = using[0][0]?.tag ?? null;
				for (const chunkArr of using) {
					for (const chunk of chunkArr) {
						if (chunk.tag !== chunkType) {
							chunkType = null;
							break;
						}
					}
					if (!chunkType) {
						break;
					}
				}

				if (chunkType === "delete") {
					let seq0: DiffChunk | null = null;
					let seq1: DiffChunk | null = null;
					let i0 = 0;
					let i1 = 0;
					let end0 = 0;
					let end1 = 0;
					const using0 = using[0].slice();
					const using1 = using[1].slice();

					while (true) {
						if (!seq0) {
							seq0 = using0.shift() || null;
							if (!seq0) {
								break;
							}
							i0 = seq0.startA;
							end0 = seq0.endB;
						}
						if (!seq1) {
							seq1 = using1.shift() || null;
							if (!seq1) {
								break;
							}
							i1 = seq1.startA;
							end1 = seq1.endB;
						}

						const highStart = Math.max(i0, i1);
						if (i0 !== i1) {
							yield [
								{
									tag: "conflict",
									startA: i0 - highStart + i1,
									endA: highStart,
									startB: seq0.startB - highStart + i1,
									endB: seq0.startB,
								},
								{
									tag: "conflict",
									startA: i1 - highStart + i0,
									endA: highStart,
									startB: seq1.startB - highStart + i0,
									endB: seq1.startB,
								},
							];
						}

						const lowEnd = Math.min(seq0.endA, seq1.endA);
						if (highStart !== lowEnd) {
							yield [
								{
									tag: "delete",
									startA: highStart,
									endA: lowEnd,
									startB: seq0.startB,
									endB: seq0.endB,
								},
								{
									tag: "delete",
									startA: highStart,
									endA: lowEnd,
									startB: seq1.startB,
									endB: seq1.endB,
								},
							];
						}

						i0 = i1 = lowEnd;
						if (lowEnd === seq0.endA) {
							seq0 = null;
						}
						if (lowEnd === seq1.endA) {
							seq1 = null;
						}
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
			yield [out0, out1];
		}
	}

	override changeSequence(
		sequence: number,
		startIdx: number,
		sizeChange: number,
		texts: string[][],
	) {
		if (sequence === 1) {
			let lo = 0;
			for (const c of this.unresolved) {
				if (startIdx <= c) {
					break;
				}
				lo++;
			}
			if (lo < this.unresolved.length) {
				let hi = lo;
				if (sizeChange < 0) {
					for (const c of this.unresolved.slice(lo)) {
						if (startIdx - sizeChange <= c) {
							break;
						}
						hi++;
					}
				} else if (
					sizeChange === 0 &&
					startIdx === this.unresolved[lo]
				) {
					hi++;
				}

				if (hi < this.unresolved.length) {
					const shifted = this.unresolved
						.slice(hi)
						.map((c) => c + sizeChange);
					this.unresolved.splice(
						hi,
						this.unresolved.length - hi,
						...shifted,
					);
				}
				this.unresolved.splice(lo, hi - lo);
			}
		}
		super.changeSequence(sequence, startIdx, sizeChange, texts);
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
			if (result.done) {
				break;
			}
			if (result.value === null) {
				yield null;
			}
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
				const line = text[i];
				mergedtext.push(line ?? "");
			}
			return 0;
		}

		if (change.tag === "replace" || (change.tag as string) === "conflict") {
			for (let i = change.startB; i < change.endB; i++) {
				const line = text[i];
				mergedtext.push(line ?? "");
			}
			return change.endA - change.startA;
		}

		return change.endA - change.startA;
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

			if (ch0 !== null) {
				lowMark = ch0.startA;
			}
			if (ch1 !== null && ch1.startA > lowMark) {
				lowMark = ch1.startA;
			}

			const lines = this.texts[1];
			if (lines) {
				for (let i = lastline; i < lowMark; i++) {
					const line = lines[i];
					mergedtext.push(line ?? "");
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
						const lines = this.texts[1];
						if (lines) {
							for (let i = lowMark; i < highMark; i++) {
								const line = lines[i];
								mergedtext.push(`(??)${line ?? ""}`);
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

		const baseLines = this.texts[1];
		if (baseLines) {
			for (let i = lastline; i < baseLines.length; i++) {
				const line = baseLines[i];
				mergedtext.push(line ?? "");
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
