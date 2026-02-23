import { DiffChunk, DiffChunkTag, MyersSequenceMatcher, SyncPointMyersSequenceMatcher } from './myers';

export const LO = 1;
export const HI = 2;

const opcode_reverse: Record<DiffChunkTag | string, DiffChunkTag> = {
    "replace": "replace",
    "insert": "delete",
    "delete": "insert",
    "conflict": "conflict",
    "equal": "equal"
};

export function merged_chunk_order(merged_chunk: [DiffChunk | null, DiffChunk | null] | null): number {
    if (!merged_chunk) return 0;
    const chunk = merged_chunk[0] || merged_chunk[1];
    return chunk ? chunk.start_a : 0;
}

export function reverse_chunk(chunk: DiffChunk): DiffChunk {
    const tag = opcode_reverse[chunk.tag];
    return { tag, start_a: chunk.start_b, end_a: chunk.end_b, start_b: chunk.start_a, end_b: chunk.end_a };
}

export function consume_blank_lines(chunk: DiffChunk | null, texts: string[][], pane1: number, pane2: number): DiffChunk | null {
    if (!chunk) return null;

    const _find_blank_lines = (txt: string[], lo: number, hi: number): [number, number] => {
        while (lo < hi && !txt[lo]) lo++;
        while (lo < hi && !txt[hi - 1]) hi--;
        return [lo, hi];
    };

    let tag = chunk.tag;
    const [c1, c2] = _find_blank_lines(texts[pane1], chunk.start_a, chunk.end_a);
    const [c3, c4] = _find_blank_lines(texts[pane2], chunk.start_b, chunk.end_b);

    if (c1 === c2 && c3 === c4) return null;
    if (c1 === c2 && tag === "replace") tag = "insert";
    else if (c3 === c4 && tag === "replace") tag = "delete";

    return { tag, start_a: c1, end_a: c2, start_b: c3, end_b: c4 };
}

type ChunkChangesTuple = [Set<[DiffChunk | null, DiffChunk | null]>, Set<[DiffChunk | null, DiffChunk | null]>, [DiffChunk | null, DiffChunk | null] | []];

export class Differ {
    _matcher = MyersSequenceMatcher;
    _sync_matcher = SyncPointMyersSequenceMatcher;

    num_sequences = 0;
    seqlength: number[] = [0, 0, 0];
    diffs: DiffChunk[][] = [[], []];
    syncpoints: Array<[() => number, () => number]>[] = [];
    conflicts: number[] = [];
    _old_merge_cache = new Set<string>(); // Use stringified JSON for sets in TS or manage differently
    _changed_chunks: [DiffChunk | null, DiffChunk | null] | [] = [];
    _merge_cache: [DiffChunk | null, DiffChunk | null][] = [];
    _line_cache: [number | null, number | null, number | null][][] = [[], [], []];
    ignore_blanks = false;
    _initialised = false;
    _has_mergeable_changes: [boolean, boolean, boolean, boolean] = [false, false, false, false];

    listeners: Map<string, Function[]> = new Map();

    constructor() {}

    on(event: string, callback: Function) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(callback);
    }

    emit(event: string, ...args: any[]) {
        if (this.listeners.has(event)) {
            for (const cb of this.listeners.get(event)!) {
                cb(...args);
            }
        }
    }

    _update_merge_cache(texts: string[][]) {
        if (this.num_sequences === 3) {
            this._merge_cache = Array.from(this._merge_diffs(this.diffs[0], this.diffs[1], texts));
        } else {
            this._merge_cache = this.diffs[0].map(c => [c, null]);
        }

        if (this.ignore_blanks) {
            for (let i = 0; i < this._merge_cache.length; i++) {
                const c = this._merge_cache[i];
                this._merge_cache[i] = [
                    consume_blank_lines(c[0], texts, 1, 0),
                    consume_blank_lines(c[1], texts, 1, 2)
                ];
            }
            this._merge_cache = this._merge_cache.filter(x => x[0] !== null || x[1] !== null);
        }

        let mergeable0 = false, mergeable1 = false;
        for (const [c0, c1] of this._merge_cache) {
            mergeable0 = mergeable0 || (c0 !== null && c0.tag !== 'conflict');
            mergeable1 = mergeable1 || (c1 !== null && c1.tag !== 'conflict');
            if (mergeable0 && mergeable1) break;
        }
        this._has_mergeable_changes = [false, mergeable0, mergeable1, false];

        this.conflicts = [];
        for (let i = 0; i < this._merge_cache.length; i++) {
            const [c1, c2] = this._merge_cache[i];
            if ((c1 !== null && c1.tag === 'conflict') || (c2 !== null && c2.tag === 'conflict')) {
                this.conflicts.push(i);
            }
        }

        this._update_line_cache();
        // Skip emitting chunk_changes for now or serialize them since TS Sets of arrays need deep equality handling
        this.emit("diffs-changed", null /* chunk_changes stub */);
    }

    _update_line_cache() {
        for (let i = 0; i < this.seqlength.length; i++) {
            this._line_cache[i] = new Array(this.seqlength[i] + 1).fill([null, null, null]);
        }

        const last_chunk = this._merge_cache.length;

        const find_next = (diff: number, seq: number, current: number): number | null => {
            let next_chunk: number | null = null;
            if (seq === 1 && current + 1 < last_chunk) {
                next_chunk = current + 1;
            } else {
                for (let j = current + 1; j < last_chunk; j++) {
                    if (this._merge_cache[j][diff] !== null) {
                        next_chunk = j;
                        break;
                    }
                }
            }
            return next_chunk;
        };

        const prev: (number | null)[] = [null, null, null];
        const next: (number | null)[] = [find_next(0, 0, -1), find_next(0, 1, -1), find_next(1, 2, -1)];
        const old_end = [0, 0, 0];

        for (let i = 0; i < this._merge_cache.length; i++) {
            const c = this._merge_cache[i];
            const seq_params = [
                {diff: 0, seq: 0, getKey: (x: DiffChunk) => [x.start_b, x.end_b]},
                {diff: 0, seq: 1, getKey: (x: DiffChunk) => [x.start_a, x.end_a]},
                {diff: 1, seq: 2, getKey: (x: DiffChunk) => [x.start_b, x.end_b]},
            ];

            for (const {diff, seq, getKey} of seq_params) {
                let actualDiff = diff;
                let chunk = c[diff];
                if (chunk === null) {
                    if (seq === 1) {
                        actualDiff = 1;
                        chunk = c[1];
                    } else continue;
                }
                if (!chunk) continue;

                let [start, end] = getKey(chunk);
                if (seq === 1 && actualDiff === 1) {
                    start = chunk.start_a;
                    end = chunk.end_a;
                }

                let last = old_end[seq];
                if (start > last) {
                    for(let k=last; k<start; k++) {
                        this._line_cache[seq][k] = [null, prev[seq], next[seq]];
                    }
                }

                if (start === end) end++;
                next[seq] = find_next(actualDiff, seq, i);
                
                for(let k=start; k<end; k++) {
                    this._line_cache[seq][k] = [i, prev[seq], next[seq]];
                }
                
                prev[seq] = i;
                old_end[seq] = end;
            }
        }

        for (let seq = 0; seq < 3; seq++) {
            const last = old_end[seq];
            const end = this._line_cache[seq].length;
            if (last < end) {
                for(let k=last; k<end; k++) {
                    this._line_cache[seq][k] = [null, prev[seq], next[seq]];
                }
            }
        }
    }

    change_sequence(sequence: number, startidx: number, sizechange: number, texts: string[][]) {
        if (sequence === 0 || sequence === 1) {
            this._change_sequence(0, sequence, startidx, sizechange, texts);
        }
        if (sequence === 2 || (sequence === 1 && this.num_sequences === 3)) {
            this._change_sequence(1, sequence, startidx, sizechange, texts);
        }
        this.seqlength[sequence] += sizechange;

        const offset = (c: DiffChunk | null, start: number, o1: number, o2: number): DiffChunk | null => {
            if (!c) return null;
            return {
                tag: c.tag,
                start_a: c.start_a + (c.start_a > start ? o1 : 0),
                end_a: c.end_a + (c.end_a > start ? o1 : 0),
                start_b: c.start_b + (c.start_b > start ? o2 : 0),
                end_b: c.end_b + (c.end_b > start ? o2 : 0)
            };
        };

        this._old_merge_cache.clear();
        this._changed_chunks = [];
        let chunk_changed = false;
        
        for (let i=0; i<this._merge_cache.length; i++) {
            let [c1, c2] = this._merge_cache[i];
            
            if (sequence === 0) {
                if (c1 && c1.start_b <= startidx && startidx < c1.end_b) chunk_changed = true;
                c1 = offset(c1, startidx, 0, sizechange);
            } else if (sequence === 2) {
                if (c2 && c2.start_b <= startidx && startidx < c2.end_b) chunk_changed = true;
                c2 = offset(c2, startidx, 0, sizechange);
            } else {
                if (c1 && c1.start_a <= startidx && startidx < c1.end_a) chunk_changed = true;
                c1 = offset(c1, startidx, sizechange, 0);
                if (this.num_sequences === 3) {
                    c2 = offset(c2, startidx, sizechange, 0);
                }
            }
            if (chunk_changed) {
                this._changed_chunks = [c1, c2];
                chunk_changed = false;
            }
        }
        this._update_merge_cache(texts);
    }

    _locate_chunk(whichdiffs: number, sequence: number, line: number): number {
        for (let i = 0; i < this.diffs[whichdiffs].length; i++) {
            const c = this.diffs[whichdiffs][i];
            const highIndexVal = sequence !== 1 ? c.end_b : c.end_a;
            if (line < highIndexVal) {
                return i;
            }
        }
        return this.diffs[whichdiffs].length;
    }

    get_chunk(index: number, from_pane: number, to_pane: number | null = null): DiffChunk | null {
        const sequence = (from_pane === 2 || to_pane === 2) ? 1 : 0;
        let chunk = this._merge_cache[index][sequence];
        if (from_pane === 0 || from_pane === 2) {
            return chunk ? reverse_chunk(chunk) : null;
        } else {
            if (to_pane === null && !chunk) {
                chunk = this._merge_cache[index][1];
            }
            return chunk;
        }
    }

    locate_chunk(pane: number, line: number): [number | null, number | null, number | null] {
        return this._line_cache[pane] && this._line_cache[pane][line] ? this._line_cache[pane][line] : [null, null, null];
    }

    all_changes() {
        return this._merge_cache.slice();
    }

    *pair_changes(fromindex: number, toindex: number, lines: (number | null)[] = [null, null, null, null]) {
        let merge_cache = this._merge_cache;
        if (!lines.includes(null)) {
            const [start1, end1] = this._range_from_lines(fromindex, [lines[0] as number, lines[1] as number]);
            const [start2, end2] = this._range_from_lines(toindex, [lines[2] as number, lines[3] as number]);
            if ((start1 === null || end1 === null) && (start2 === null || end2 === null)) return;
            const starts = [start1, start2].filter(x => x !== null) as number[];
            const ends = [end1, end2].filter(x => x !== null) as number[];
            const start = Math.min(...starts);
            const end = Math.max(...ends);
            merge_cache = this._merge_cache.slice(start, end + 1);
        }

        if (fromindex === 1) {
            const seq = Math.floor(toindex / 2);
            for (const c of merge_cache) {
                if (c[seq]) yield c[seq]!;
            }
        } else {
            const seq = Math.floor(fromindex / 2);
            for (const c of merge_cache) {
                if (c[seq]) yield reverse_chunk(c[seq]!);
            }
        }
    }

    _range_from_lines(textindex: number, lines: number[]): [number | null, number | null] {
        const [lo_line, hi_line] = lines;
        const top_chunk = this.locate_chunk(textindex, lo_line);
        let start = top_chunk[0];
        if (start === null) start = top_chunk[2];
        const bottom_chunk = this.locate_chunk(textindex, hi_line);
        let end = bottom_chunk[0];
        if (end === null) end = bottom_chunk[1];
        return [start, end];
    }

    _change_sequence(which: number, sequence: number, startidx: number, sizechange: number, texts: string[][]) {
        const diffs = this.diffs[which];
        const lines_added = [0, 0, 0];
        lines_added[sequence] = sizechange;
        let loidx = this._locate_chunk(which, sequence, startidx);
        let hiidx = sizechange < 0 ? this._locate_chunk(which, sequence, startidx - sizechange) : loidx;
        
        let lorange: [number, number];
        if (loidx > 0) {
            loidx--;
            lorange = [diffs[loidx].start_b, diffs[loidx].start_a];
        } else {
            lorange = [0, 0];
        }

        const x = which * 2;
        let hirange: [number, number];
        if (hiidx < diffs.length) {
            hiidx++;
            hirange = [diffs[hiidx - 1].end_b, diffs[hiidx - 1].end_a];
        } else {
            hirange = [this.seqlength[x], this.seqlength[1]];
        }

        const rangex: [number, number] = [lorange[0], hirange[0] + lines_added[x]];
        const range1: [number, number] = [lorange[1], hirange[1] + lines_added[1]];
        
        const linesx = texts[x].slice(rangex[0], rangex[1]);
        const lines1 = texts[1].slice(range1[0], range1[1]);

        const offset = (c: DiffChunk, o1: number, o2: number): DiffChunk => ({
            tag: c.tag, start_a: c.start_a + o1, end_a: c.end_a + o1, start_b: c.start_b + o2, end_b: c.end_b + o2
        });

        let newdiffs = new this._matcher(null, lines1, linesx).get_difference_opcodes();
        newdiffs = newdiffs.map(c => offset(c, range1[0], rangex[0]));

        if (hiidx < diffs.length) {
            const offset_diffs = diffs.slice(hiidx).map(c => offset(c, lines_added[1], lines_added[x]));
            this.diffs[which].splice(hiidx, diffs.length - hiidx, ...offset_diffs);
        }
        this.diffs[which].splice(loidx, hiidx - loidx, ...newdiffs);
    }

    _merge_blocks(using: DiffChunk[][]): [number, number, number, number, number, number] {
        const lowc = Math.min(using[0][0].start_a, using[1][0].start_a);
        const highc = Math.max(using[0][using[0].length - 1].end_a, using[1][using[1].length - 1].end_a);
        
        const low: number[] = [];
        const high: number[] = [];
        for (const i of [0, 1]) {
            const dFirst = using[i][0];
            low.push(lowc - dFirst.start_a + dFirst.start_b);
            const dLast = using[i][using[i].length - 1];
            high.push(highc - dLast.end_a + dLast.end_b);
        }
        return [low[0], high[0], lowc, highc, low[1], high[1]];
    }

    *_auto_merge(using: DiffChunk[][], texts: string[][]): Generator<[DiffChunk, DiffChunk]> {
        const [l0, h0, l1, h1, l2, h2] = this._merge_blocks(using);
        let tag: DiffChunkTag;
        
        let matches = (h0 - l0) === (h2 - l2);
        if (matches) {
            for(let i=0; i < (h0 - l0); i++) {
                if (texts[0][l0 + i] !== texts[2][l2 + i]) { matches = false; break; }
            }
        }

        if (matches) {
            if (l1 !== h1 && l0 === h0) {
                tag = "delete";
            } else if (l1 !== h1) {
                tag = "replace";
            } else {
                tag = "insert";
            }
        } else {
            tag = "conflict";
        }

        const out0: DiffChunk = {tag, start_a: l1, end_a: h1, start_b: l0, end_b: h0};
        const out1: DiffChunk = {tag, start_a: l1, end_a: h1, start_b: l2, end_b: h2};
        yield [out0, out1];
    }

    *_merge_diffs(seq0: DiffChunk[], seq1: DiffChunk[], texts: string[][]): Generator<[DiffChunk | null, DiffChunk | null]> {
        const s0 = seq0.slice();
        const s1 = seq1.slice();
        const seq = [s0, s1];

        while (s0.length || s1.length) {
            let high_seq = 0;
            if (!s0.length) high_seq = 1;
            else if (!s1.length) high_seq = 0;
            else {
                high_seq = s0[0].start_a > s1[0].start_a ? 1 : 0;
                if (s0[0].start_a === s1[0].start_a) {
                    if (s0[0].tag === "insert") high_seq = 0;
                    else if (s1[0].tag === "insert") high_seq = 1;
                }
            }

            const high_diff = seq[high_seq].shift()!;
            let high_mark = high_diff.end_a;
            let other_seq = high_seq === 1 ? 0 : 1;

            const using: DiffChunk[][] = [[], []];
            using[high_seq].push(high_diff);

            while (seq[other_seq].length) {
                const other_diff = seq[other_seq][0];
                if (high_mark < other_diff.start_a) break;
                if (high_mark === other_diff.start_a && !(high_diff.tag === 'insert' && other_diff.tag === 'insert')) break;

                using[other_seq].push(other_diff);
                seq[other_seq].shift();

                if (high_mark < other_diff.end_a) {
                    const temp = high_seq; high_seq = other_seq; other_seq = temp;
                    high_mark = other_diff.end_a;
                }
            }

            if (using[0].length === 0) {
                yield [null, using[1][0]];
            } else if (using[1].length === 0) {
                yield [using[0][0], null];
            } else {
                for (const c of this._auto_merge(using, texts)) {
                    yield c;
                }
            }
        }
    }

    *set_sequences_iter(sequences: string[][]): Generator<number | null> {
        this.diffs = [[], []];
        this.num_sequences = sequences.length;
        this.seqlength = sequences.map(s => s.length);

        for (let i = 0; i < this.num_sequences - 1; i++) {
            let matcher;
            if (this.syncpoints.length) {
                const syncpoints: [number, number][] = this.syncpoints.map(s => [s[i][0](), s[i][1]()]);
                matcher = new this._sync_matcher(null, sequences[1], sequences[i * 2], syncpoints);
            } else {
                matcher = new this._matcher(null, sequences[1], sequences[i * 2]);
            }
            
            const work = matcher.initialise();
            while (true) {
                const step = work.next();
                if (step.done) break;
                if (step.value === null) yield null;
            }
            this.diffs[i] = matcher.get_difference_opcodes();
        }
        this._initialised = true;
        this._update_merge_cache(sequences);
        yield 1;
    }

    clear() {
        this.diffs = [[], []];
        this.seqlength = new Array(this.num_sequences).fill(0);
        this._initialised = false;
        this._old_merge_cache.clear();
        this._update_merge_cache(new Array(this.num_sequences).fill([]));
    }
}
