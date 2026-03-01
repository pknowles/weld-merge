import { Merger } from "./merge";

export class GitTextMerger extends Merger {
	*merge_3_files_git(mark_conflicts: boolean = true) {
		this.differ.unresolved = [];
		let lastline = 0;
		let mergedline = 0;
		const mergedtext: string[] = [];

		for (const change of this.differ.all_changes()) {
			yield null;
			let low_mark = lastline;
			if (change[0] !== null) low_mark = change[0].start_a;
			if (change[1] !== null && change[1].start_a > low_mark) {
				low_mark = change[1].start_a;
			}

			for (let i = lastline; i < low_mark; i++) {
				mergedtext.push(this.texts[1][i]);
			}
			mergedline += low_mark - lastline;
			lastline = low_mark;

			if (
				change[0] !== null &&
				change[1] !== null &&
				change[0].tag === "conflict"
			) {
				const min_mark = Math.min(change[0].start_a, change[1].start_a);
				const high_mark = Math.max(change[0].end_a, change[1].end_a);
				if (mark_conflicts) {
					mergedtext.push("<<<<<<< HEAD");
					for (let i = change[0].start_b; i < change[0].end_b; i++) {
						mergedtext.push(this.texts[0][i]);
					}
					mergedtext.push("||||||| BASE");
					for (let i = min_mark; i < high_mark; i++) {
						mergedtext.push(this.texts[1][i]);
					}
					mergedtext.push("=======");
					for (let i = change[1].start_b; i < change[1].end_b; i++) {
						mergedtext.push(this.texts[2][i]);
					}
					mergedtext.push(">>>>>>> REMOTE");

					const added_lines =
						change[0].end_b -
						change[0].start_b +
						(high_mark - min_mark) +
						(change[1].end_b - change[1].start_b) +
						4;
					for (let i = 0; i < added_lines; i++) {
						this.differ.unresolved.push(mergedline);
						mergedline += 1;
					}
					lastline = high_mark;
				}
			} else if (change[0] !== null) {
				lastline += this._apply_change(this.texts[0], change[0], mergedtext);
				mergedline += change[0].end_b - change[0].start_b;
			} else if (change[1] !== null) {
				lastline += this._apply_change(this.texts[2], change[1], mergedtext);
				mergedline += change[1].end_b - change[1].start_b;
			}
		}

		const baselen = this.texts[1].length;
		for (let i = lastline; i < baselen; i++) {
			mergedtext.push(this.texts[1][i]);
		}

		yield mergedtext.join("\n");
	}
}
