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
		for (const [out0, out1] of super._autoMerge(using, texts)) {
			if (this.autoMerge && (out0.tag as string) === "conflict") {
				if (this._shouldTryFineGrained(out0, out1)) {
					yield* this._handleFineGrainedConflict(out0, out1, texts);
					continue;
				}

				if (this._getCommonTag(using) === "delete") {
					yield* this._handleSameTagConflict(using);
					continue;
				}
			}
			yield [out0, out1];
		}
	}

	protected _shouldTryFineGrained(out0: DiffChunk, out1: DiffChunk): boolean {
		const len0 = out0.endB - out0.startB;
		const len1 = out0.endA - out0.startA;
		const len2 = out1.endB - out1.startB;
		return (
			len0 > 0 &&
			len2 > 0 &&
			(len0 === len1 || len2 === len1 || len1 === 0)
		);
	}

	protected _getCommonTag(
		using: [DiffChunk[], DiffChunk[]],
	): DiffChunkTag | null {
		const chunkType: DiffChunkTag | null = using[0][0]?.tag ?? null;
		for (const chunkArr of using) {
			for (const chunk of chunkArr) {
				if (chunk.tag !== chunkType) {
					return null;
				}
			}
		}
		return chunkType;
	}

	protected *_handleFineGrainedConflict(
		out0: DiffChunk,
		out1: DiffChunk,
		texts: string[][],
	): Generator<[DiffChunk, DiffChunk]> {
		const l0 = out0.startB;
		const h0 = out0.endB;
		const l1 = out0.startA;
		const l2 = out1.startB;
		const h2 = out1.endB;

		const len0 = h0 - l0;
		const len1 = out0.endA - l1;
		const len2 = h2 - l2;

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

				let out0Res: DiffChunk;
				let out1Res: DiffChunk;
				if (chunk.tag === "equal") {
					out0Res = { tag: "replace", ...out0Bounds };
					out1Res = { tag: "replace", ...out1Bounds };
				} else {
					out0Res = { tag: "conflict", ...out0Bounds };
					out1Res = { tag: "conflict", ...out1Bounds };
				}
				yield [out0Res, out1Res];
			}
		}
	}

	override changeSequence(
		sequence: number,
		startIdx: number,
		sizeChange: number,
		texts: string[][],
	) {
		if (sequence === 1) {
			this._updateUnresolved(startIdx, sizeChange);
		}
		super.changeSequence(sequence, startIdx, sizeChange, texts);
	}

	protected _updateUnresolved(startIdx: number, sizeChange: number) {
		const lo = this.unresolved.findIndex((c) => startIdx <= c);
		if (lo === -1 || lo >= this.unresolved.length) {
			return;
		}

		let hi = lo;
		if (sizeChange < 0) {
			const endRange = startIdx - sizeChange;
			for (let i = lo; i < this.unresolved.length; i++) {
				const val = this.unresolved[i];
				if (val === undefined || endRange <= val) {
					break;
				}
				hi++;
			}
		} else if (sizeChange === 0 && startIdx === this.unresolved[lo]) {
			hi++;
		}

		if (hi < this.unresolved.length) {
			const shifted = this.unresolved
				.slice(hi)
				.map((c) => c + sizeChange);
			this.unresolved.splice(hi, this.unresolved.length - hi, ...shifted);
		}
		this.unresolved.splice(lo, hi - lo);
	}

	getUnresolvedCount(): number {
		return this.unresolved.length;
	}
	protected *_handleSameTagConflict(
		using: [DiffChunk[], DiffChunk[]],
	): Generator<[DiffChunk, DiffChunk]> {
		const cursors = { i0: 0, i1: 0, end0: 0, end1: 0 };
		const using0 = using[0].slice();
		const using1 = using[1].slice();
		let seq0: DiffChunk | null = null;
		let seq1: DiffChunk | null = null;

		while (true) {
			const populated = this._populateSequences(
				using0,
				using1,
				seq0,
				seq1,
				cursors,
			);
			if (!populated) {
				break;
			}
			seq0 = populated.seq0;
			seq1 = populated.seq1;

			yield* this._yieldOverlappingConflict(seq0, seq1, cursors);

			const lowEnd = Math.min(seq0.endA, seq1.endA);
			yield* this._yieldOverlappingDelete(seq0, seq1, cursors, lowEnd);

			const advanced = this._advanceCursors(seq0, seq1, lowEnd);
			seq0 = advanced.seq0;
			seq1 = advanced.seq1;
			cursors.i0 = cursors.i1 = lowEnd;
		}

		yield* this._yieldRemainingSameTagConflicts(seq0, seq1, cursors);
	}

	protected _populateSequences(
		using0: DiffChunk[],
		using1: DiffChunk[],
		seq0: DiffChunk | null,
		seq1: DiffChunk | null,
		cursors: { i0: number; i1: number; end0: number; end1: number },
	): { seq0: DiffChunk; seq1: DiffChunk } | null {
		let s0 = seq0;
		let s1 = seq1;
		if (!s0) {
			s0 = using0.shift() || null;
			if (!s0) {
				return null;
			}
			cursors.i0 = s0.startA;
			cursors.end0 = s0.endB;
		}
		if (!s1) {
			s1 = using1.shift() || null;
			if (!s1) {
				return null;
			}
			cursors.i1 = s1.startA;
			cursors.end1 = s1.endB;
		}
		return { seq0: s0, seq1: s1 };
	}

	protected _advanceCursors(
		seq0: DiffChunk,
		seq1: DiffChunk,
		lowEnd: number,
	): { seq0: DiffChunk | null; seq1: DiffChunk | null } {
		return {
			seq0: lowEnd === seq0.endA ? null : seq0,
			seq1: lowEnd === seq1.endA ? null : seq1,
		};
	}

	protected *_yieldOverlappingConflict(
		seq0: DiffChunk,
		seq1: DiffChunk,
		cursors: { i0: number; i1: number },
	): Generator<[DiffChunk, DiffChunk]> {
		const highStart = Math.max(cursors.i0, cursors.i1);
		if (cursors.i0 !== cursors.i1) {
			yield [
				{
					tag: "conflict",
					startA: cursors.i0 - highStart + cursors.i1,
					endA: highStart,
					startB: seq0.startB - highStart + cursors.i1,
					endB: seq0.startB,
				},
				{
					tag: "conflict",
					startA: cursors.i1 - highStart + cursors.i0,
					endA: highStart,
					startB: seq1.startB - highStart + cursors.i0,
					endB: seq1.startB,
				},
			];
		}
	}

	protected *_yieldOverlappingDelete(
		seq0: DiffChunk,
		seq1: DiffChunk,
		cursors: { i0: number; i1: number },
		lowEnd: number,
	): Generator<[DiffChunk, DiffChunk]> {
		const highStart = Math.max(cursors.i0, cursors.i1);
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
	}

	protected *_yieldRemainingSameTagConflicts(
		seq0: DiffChunk | null,
		seq1: DiffChunk | null,
		cursors: { i0: number; i1: number; end0: number; end1: number },
	): Generator<[DiffChunk, DiffChunk]> {
		const { i0, i1, end0, end1 } = cursors;
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
			const ch0 = change[0];
			const ch1 = change[1];
			const lowMark = this._calculateLowMark(ch0, ch1, lastline);

			const syncResult = this._syncWithBase(
				lastline,
				lowMark,
				mergedtext,
				mergedline,
			);
			mergedline = syncResult.mergedline;
			lastline = lowMark;

			if (this._isConflicting(ch0, ch1)) {
				const highMark = Math.max(ch0?.endA ?? 0, ch1?.endA ?? 0);
				if (markConflicts) {
					const conflictResult = this._handleConflictInMerger(
						lowMark,
						highMark,
						mergedtext,
						mergedline,
					);
					mergedline = conflictResult.mergedline;
					lastline = highMark;
				}
			} else {
				const applyResult = this._applyChangeInMerger(
					ch0,
					ch1,
					lastline,
					mergedtext,
					mergedline,
				);
				lastline = applyResult.lastline;
				mergedline = applyResult.mergedline;
			}
		}

		this._appendRemainingLines(lastline, this.texts[1] || [], mergedtext);
		return mergedtext.join("\n");
	}

	protected _syncWithBase(
		lastline: number,
		lowMark: number,
		mergedtext: string[],
		mergedline: number,
	): { mergedline: number } {
		const lines = this.texts[1];
		if (lines) {
			for (let i = lastline; i < lowMark; i++) {
				mergedtext.push(lines[i] ?? "");
			}
		}
		return { mergedline: mergedline + (lowMark - lastline) };
	}

	protected _isConflicting(
		ch0: DiffChunk | null,
		ch1: DiffChunk | null,
	): boolean {
		return (
			ch0 !== null &&
			ch1 !== null &&
			((ch0.tag as string) === "conflict" ||
				(ch1.tag as string) === "conflict" ||
				ch0.endA !== ch1.endA)
		);
	}

	protected _handleConflictInMerger(
		lowMark: number,
		highMark: number,
		mergedtext: string[],
		mergedline: number,
	): { mergedline: number } {
		let currentMergedLine = mergedline;
		if (lowMark < highMark) {
			const lines = this.texts[1];
			if (lines) {
				for (let i = lowMark; i < highMark; i++) {
					mergedtext.push(`(??)${lines[i] ?? ""}`);
					this.differ.unresolved.push(currentMergedLine);
					currentMergedLine += 1;
				}
			}
		} else {
			mergedtext.push("(??)");
			this.differ.unresolved.push(currentMergedLine);
			currentMergedLine += 1;
		}
		return { mergedline: currentMergedLine };
	}

	protected _applyChangeInMerger(
		ch0: DiffChunk | null,
		ch1: DiffChunk | null,
		lastline: number,
		mergedtext: string[],
		mergedline: number,
	): { lastline: number; mergedline: number } {
		let currentLastLine = lastline;
		let currentMergedLine = mergedline;
		if (ch0 !== null) {
			currentLastLine += this._applyChange(
				this.texts[0] || [],
				ch0,
				mergedtext,
			);
			currentMergedLine += ch0.endB - ch0.startB;
		} else if (ch1 !== null) {
			currentLastLine += this._applyChange(
				this.texts[2] || [],
				ch1,
				mergedtext,
			);
			currentMergedLine += ch1.endB - ch1.startB;
		}
		return { lastline: currentLastLine, mergedline: currentMergedLine };
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
