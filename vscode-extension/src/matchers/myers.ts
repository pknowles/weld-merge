export type DiffChunkTag = "replace" | "delete" | "insert" | "conflict" | "equal";

export interface DiffChunk {
    tag: DiffChunkTag;
    start_a: number;
    end_a: number;
    start_b: number;
    end_b: number;
}

export function find_common_prefix<T>(a: T[] | string, b: T[] | string): number {
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

export function find_common_suffix<T>(a: T[] | string, b: T[] | string): number {
    if (!a.length || !b.length) return 0;
    if (a[a.length - 1] === b[b.length - 1]) {
        let pointermax = Math.min(a.length, b.length);
        let pointermid = pointermax;
        let pointermin = 0;
        while (pointermin < pointermid) {
            let matches = true;
            for (let i = 0; i < pointermid - pointermin; i++) {
                if (a[a.length - pointermid + i] !== b[b.length - pointermid + i]) {
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
    matching_blocks: [number, number, number][] | null = null;
    opcodes: DiffChunk[] | null = null;
    aindex: number[] | null = [];
    bindex: number[] | null = [];
    common_prefix: number = 0;
    common_suffix: number = 0;
    lines_discarded: boolean = false;

    constructor(isjunk: ((val: T) => boolean) | null = null, a: T[] | string = [], b: T[] | string = []) {
        if (isjunk !== null) {
            throw new Error("isjunk is not supported yet");
        }
        this.isjunk = isjunk;
        this.a = a.slice();
        this.b = b.slice();
    }

    get_matching_blocks(): [number, number, number][] {
        if (this.matching_blocks === null) {
            for (let i of this.initialise()) {
                // consume generator
            }
        }
        return this.matching_blocks!;
    }

    get_opcodes(): DiffChunk[] {
        if (this.opcodes !== null) {
            return this.opcodes;
        }

        let i = 0, j = 0;
        this.opcodes = [];
        const matching_blocks = this.get_matching_blocks();

        for (const [ai, bj, size] of matching_blocks) {
            let tag: DiffChunkTag | '' = '';
            if (i < ai && j < bj) {
                tag = 'replace';
            } else if (i < ai) {
                tag = 'delete';
            } else if (j < bj) {
                tag = 'insert';
            }
            if (tag) {
                this.opcodes.push({ tag, start_a: i, end_a: ai, start_b: j, end_b: bj });
            }
            i = ai + size;
            j = bj + size;
            if (size) {
                this.opcodes.push({ tag: 'equal', start_a: ai, end_a: i, start_b: bj, end_b: j });
            }
        }
        return this.opcodes;
    }

    get_difference_opcodes(): DiffChunk[] {
        return this.get_opcodes().filter(chunk => chunk.tag !== "equal");
    }

    preprocess_remove_prefix_suffix(a: T[] | string, b: T[] | string): [T[] | string, T[] | string] {
        this.common_prefix = this.common_suffix = 0;
        this.common_prefix = find_common_prefix(a, b);
        if (this.common_prefix > 0) {
            a = a.slice(this.common_prefix);
            b = b.slice(this.common_prefix);
        }

        if (a.length > 0 && b.length > 0) {
            this.common_suffix = find_common_suffix(a, b);
            if (this.common_suffix > 0) {
                a = a.slice(0, a.length - this.common_suffix);
                b = b.slice(0, b.length - this.common_suffix);
            }
        }
        return [a, b];
    }

    preprocess_discard_nonmatching_lines(a: T[] | string, b: T[] | string): [T[] | string, T[] | string] {
        if (a.length === 0 || b.length === 0) {
            this.aindex = [];
            this.bindex = [];
            return [a, b];
        }

        const index_matching = (a_seq: T[] | string, b_seq: T[] | string): [T[] & string, number[]] => {
            const aset = new Set<T | string>();
            for (let i = 0; i < a_seq.length; i++) aset.add(a_seq[i]);
            
            const matches: any[] = [];
            const index: number[] = [];
            for (let i = 0; i < b_seq.length; i++) {
                if (aset.has(b_seq[i])) {
                    matches.push(b_seq[i]);
                    index.push(i);
                }
            }
            return [typeof b_seq === 'string' ? matches.join('') : matches as any, index];
        };

        let indexed_b, indexed_a;
        [indexed_b, this.bindex] = index_matching(a, b);
        [indexed_a, this.aindex] = index_matching(b, a);

        this.lines_discarded = (b.length - indexed_b.length > 10 || a.length - indexed_a.length > 10);
        if (this.lines_discarded) {
            a = indexed_a;
            b = indexed_b;
        }
        return [a, b];
    }

    preprocess(): [T[] | string, T[] | string] {
        const [a, b] = this.preprocess_remove_prefix_suffix(this.a, this.b);
        return this.preprocess_discard_nonmatching_lines(a, b);
    }

    postprocess() {
        const mb = [this.matching_blocks![this.matching_blocks!.length - 1]];
        let i = this.matching_blocks!.length - 2;
        while (i >= 0) {
            let [cur_a, cur_b, cur_len] = this.matching_blocks![i];
            i -= 1;
            while (i >= 0) {
                let [prev_a, prev_b, prev_len] = this.matching_blocks![i];
                if (prev_b + prev_len === cur_b || prev_a + prev_len === cur_a) {
                    const prev_slice_a = this.a.slice(cur_a - prev_len, cur_a);
                    const prev_slice_b = this.b.slice(cur_b - prev_len, cur_b);
                    
                    let slices_match = prev_slice_a.length === prev_slice_b.length;
                    if (slices_match) {
                        for(let k=0; k<prev_slice_a.length; k++) {
                            if (prev_slice_a[k] !== prev_slice_b[k]) { slices_match = false; break; }
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
        this.matching_blocks = mb;
    }

    build_matching_blocks(lastsnake: [number | null, [number, any] | null] | null | any): void {
        const matching_blocks: [number, number, number][] = [];
        this.matching_blocks = matching_blocks;

        const common_prefix = this.common_prefix;
        const common_suffix = this.common_suffix;
        const aindex = this.aindex!;
        const bindex = this.bindex!;

        while (lastsnake !== null) {
            const [prevsnake, x_val, y_val, snake_val] = lastsnake;
            let x = x_val;
            let y = y_val;
            let snake = snake_val;

            if (this.lines_discarded) {
                x += snake - 1;
                y += snake - 1;
                let xprev = aindex[x] + common_prefix;
                let yprev = bindex[y] + common_prefix;
                if (snake > 1) {
                    let newsnake = 1;
                    for (let i = 1; i < snake; i++) {
                        x -= 1;
                        y -= 1;
                        let xnext = aindex[x] + common_prefix;
                        let ynext = bindex[y] + common_prefix;
                        if ((xprev - xnext !== 1) || (yprev - ynext !== 1)) {
                            matching_blocks.unshift([xprev, yprev, newsnake]);
                            newsnake = 0;
                        }
                        xprev = xnext;
                        yprev = ynext;
                        newsnake += 1;
                    }
                    matching_blocks.unshift([xprev, yprev, newsnake]);
                } else {
                    matching_blocks.unshift([xprev, yprev, snake]);
                }
            } else {
                matching_blocks.unshift([x + common_prefix, y + common_prefix, snake]);
            }
            lastsnake = prevsnake;
        }

        if (common_prefix) {
            matching_blocks.unshift([0, 0, common_prefix]);
        }
        if (common_suffix) {
            matching_blocks.push([this.a.length - common_suffix, this.b.length - common_suffix, common_suffix]);
        }
        matching_blocks.push([this.a.length, this.b.length, 0]);

        this.aindex = null;
        this.bindex = null;
    }

    *initialise(): Generator<number | null, void, unknown> {
        let [a, b] = this.preprocess();
        let m = a.length;
        let n = b.length;
        let middle = m + 1;
        let lastsnake: any = null;
        let delta = n - m + middle;
        let dmin = Math.min(middle, delta);
        let dmax = Math.max(middle, delta);
        
        if (n > 0 && m > 0) {
            let size = n + m + 2;
            let fp: [number, any][] = new Array(size).fill([-1, null]);
            let p = -1;
            while (true) {
                p += 1;
                if (p % 100 === 0) {
                    yield null;
                }
                
                let yv = -1;
                let node: any = null;
                for (let km = dmin - p; km < delta; km++) {
                    let t = fp[km + 1];
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
                    let t = fp[km - 1];
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

                if (yv < yh) {
                    let t = fp[delta + 1];
                    var y = t[0];
                    node = t[1];
                } else {
                    let t = fp[delta - 1];
                    var y = t[0] + 1;
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
        this.build_matching_blocks(lastsnake);
        this.postprocess();
        yield 1;
    }
}

export class InlineMyersSequenceMatcher<T> extends MyersSequenceMatcher<T> {
    preprocess_discard_nonmatching_lines(a: T[] | string, b: T[] | string): [T[] | string, T[] | string] {
        if (a.length <= 2 && b.length <= 2) {
            this.aindex = [];
            this.bindex = [];
            return [a, b];
        }

        const index_matching_kmers = (a_seq: T[] | string, b_seq: T[] | string): [T[] & string, number[]] => {
            const aset = new Set<string>();
            for (let i = 0; i < a_seq.length - 2; i++) {
                if (typeof a_seq === 'string') {
                    aset.add(a_seq.substring(i, i + 3));
                } else {
                    aset.add(a_seq.slice(i, i + 3).join(','));
                }
            }

            const matches: any[] = [];
            const index: number[] = [];
            let next_poss_match = 0;

            for (let i = 2; i < b_seq.length; i++) {
                let triplet: string;
                if (typeof b_seq === 'string') {
                    triplet = b_seq.substring(i - 2, i + 1);
                } else {
                    triplet = b_seq.slice(i - 2, i + 1).join(',');
                }
                
                if (!aset.has(triplet)) {
                    continue;
                }

                for (let j = Math.max(next_poss_match, i - 2); j <= i; j++) {
                    matches.push(b_seq[j]);
                    index.push(j);
                }
                next_poss_match = i + 1;
            }
            return [typeof b_seq === 'string' ? matches.join('') : matches as any, index];
        };

        let indexed_b, indexed_a;
        [indexed_b, this.bindex] = index_matching_kmers(a, b);
        [indexed_a, this.aindex] = index_matching_kmers(b, a);

        this.lines_discarded = (b.length - indexed_b.length > 10 || a.length - indexed_a.length > 10);
        if (this.lines_discarded) {
            a = indexed_a;
            b = indexed_b;
        }
        return [a, b];
    }
}

export class SyncPointMyersSequenceMatcher<T> extends MyersSequenceMatcher<T> {
    syncpoints: [number, number][] | null;
    split_matching_blocks: [number, number, number][][] = [];

    constructor(isjunk: ((val: T) => boolean) | null = null, a: T[] | string = [], b: T[] | string = [], syncpoints: [number, number][] | null = null) {
        super(isjunk, a, b);
        this.syncpoints = syncpoints;
    }

    *initialise(): Generator<number | null, void, unknown> {
        if (!this.syncpoints || this.syncpoints.length === 0) {
            for (let i of super.initialise()) {
                yield i;
            }
        } else {
            const chunks: [number, number, T[] | string, T[] | string][] = [];
            let ai = 0;
            let bi = 0;
            for (const [aj, bj] of this.syncpoints) {
                chunks.push([ai, bi, this.a.slice(ai, aj), this.b.slice(bi, bj)]);
                ai = aj;
                bi = bj;
            }
            if (ai < this.a.length || bi < this.b.length) {
                chunks.push([ai, bi, this.a.slice(ai), this.b.slice(bi)]);
            }

            this.split_matching_blocks = [];
            this.matching_blocks = [];
            for (const [ai, bi, a, b] of chunks) {
                const matching_blocks: [number, number, number][] = [];
                const matcher = new MyersSequenceMatcher<T>(this.isjunk, a, b);
                for (let i of matcher.initialise()) {
                    yield null;
                }
                const blocks = matcher.get_matching_blocks();
                const mb_len = matching_blocks.length - 1;
                if (mb_len >= 0 && blocks.length > 1) {
                    const aj = matching_blocks[mb_len][0];
                    const bj = matching_blocks[mb_len][1];
                    const bl = matching_blocks[mb_len][2];
                    if (aj + bl === ai && bj + bl === bi && blocks[0][0] === 0 && blocks[0][1] === 0) {
                        const block = blocks.shift()!;
                        matching_blocks[mb_len] = [aj, bj, bl + block[2]];
                    }
                }
                for (let idx = 0; idx < blocks.length - 1; idx++) {
                    const [x, y, length] = blocks[idx];
                    matching_blocks.push([ai + x, bi + y, length]);
                }
                this.matching_blocks.push(...matching_blocks);
                const a_len = (typeof a === 'string') ? a.length : a.length;
                const b_len = (typeof b === 'string') ? b.length : b.length;
                this.split_matching_blocks.push([...matching_blocks, [ai + a_len, bi + b_len, 0]]);
            }
            this.matching_blocks.push([this.a.length, this.b.length, 0]);
            yield 1;
        }
    }

    get_opcodes(): DiffChunk[] {
        if (this.opcodes !== null) {
            return this.opcodes;
        }
        let i = 0;
        let j = 0;
        this.opcodes = [];
        this.get_matching_blocks();
        for (const matching_blocks of this.split_matching_blocks) {
            for (const [ai, bj, size] of matching_blocks) {
                let tag: DiffChunkTag | '' = '';
                if (i < ai && j < bj) {
                    tag = 'replace';
                } else if (i < ai) {
                    tag = 'delete';
                } else if (j < bj) {
                    tag = 'insert';
                }
                if (tag) {
                    this.opcodes.push({ tag, start_a: i, end_a: ai, start_b: j, end_b: bj });
                }
                i = ai + size;
                j = bj + size;
                if (size) {
                    this.opcodes.push({ tag: 'equal', start_a: ai, end_a: i, start_b: bj, end_b: j });
                }
            }
        }
        return this.opcodes;
    }
}
