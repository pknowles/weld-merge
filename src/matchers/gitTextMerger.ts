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

import type { DiffChunk } from "./myers.ts";
import { Merger } from "./merge.ts";

const CONFLICT_MARKER_LINES = 4;

export class GitTextMerger extends Merger {
	*merge3FilesGit(markConflicts = true) {
		this.differ.unresolved = [];
		const mergedText: string[] = [];

		const sequences = this._getValidTexts();
		if (!sequences) {
			yield "";
			return;
		}
		const [_, t1] = sequences;

		let state = { lastLine: 0, mergedLine: 0 };

		for (const change of this.differ.allChanges()) {
			yield null;
			state = this._processChange({
				change,
				state,
				mergedText,
				texts: sequences,
				markConflicts,
			});
		}

		this._appendRemainingLines(state.lastLine, t1, mergedText);

		yield mergedText.join("\n");
	}

	private _getValidTexts(): [string[], string[], string[]] | null {
		const t0 = this.texts[0];
		const t1 = this.texts[1];
		const t2 = this.texts[2];
		if (!(t0 && t1 && t2)) {
			return null;
		}
		return [t0, t1, t2];
	}

	private _processChange(params: {
		change: [DiffChunk | null, DiffChunk | null];
		state: { lastLine: number; mergedLine: number };
		mergedText: string[];
		texts: [string[], string[], string[]];
		markConflicts: boolean;
	}) {
		const { change, state, mergedText, texts, markConflicts } = params;
		const [t0, t1, t2] = texts;
		const [ch0, ch1] = change;
		let { lastLine, mergedLine } = state;

		const lowMark = this._calculateLowMark(ch0, ch1, lastLine);

		if (lowMark > lastLine) {
			this._appendLines(lastLine, lowMark, t1, mergedText);
		}

		mergedLine += lowMark - lastLine;
		lastLine = lowMark;

		if (ch0 !== null && ch1 !== null && ch0.tag === "conflict") {
			if (markConflicts) {
				const result = this._handleConflict({
					ch0,
					ch1,
					mergedLine,
					mergedText,
					texts,
				});
				mergedLine = result.mergedLine;
				lastLine = result.lastLine;
			}
		} else if (ch0 !== null) {
			lastLine += this._applyChange(t0, ch0, mergedText);
			mergedLine += ch0.endB - ch0.startB;
		} else if (ch1 !== null) {
			lastLine += this._applyChange(t2, ch1, mergedText);
			mergedLine += ch1.endB - ch1.startB;
		}

		return { lastLine, mergedLine };
	}

	private _handleConflict(params: {
		ch0: DiffChunk;
		ch1: DiffChunk;
		mergedLine: number;
		mergedText: string[];
		texts: [string[], string[], string[]];
	}) {
		const { ch0, ch1, mergedLine, mergedText, texts } = params;
		const [t0, t1, t2] = texts;
		const minMark = Math.min(ch0.startA, ch1.startA);
		const highMark = Math.max(ch0.endA, ch1.endA);

		mergedText.push("<<<<<<< HEAD");
		this._appendLines(ch0.startB, ch0.endB, t0, mergedText);

		mergedText.push("||||||| BASE");
		this._appendLines(minMark, highMark, t1, mergedText);

		mergedText.push("=======");
		this._appendLines(ch1.startB, ch1.endB, t2, mergedText);

		mergedText.push(">>>>>>> REMOTE");

		const conflictAddedLines =
			ch0.endB -
			ch0.startB +
			(highMark - minMark) +
			(ch1.endB - ch1.startB) +
			CONFLICT_MARKER_LINES;

		let currentMergedLine = mergedLine;
		for (let i = 0; i < conflictAddedLines; i++) {
			this.differ.unresolved.push(currentMergedLine);
			currentMergedLine += 1;
		}

		return { mergedLine: currentMergedLine, lastLine: highMark };
	}
}
