import { Merger } from '../src/matchers/merge';
import { DiffChunk } from '../src/matchers/myers';

describe('Merger', () => {
    let merger: Merger;

    beforeEach(() => {
        merger = new Merger();
    });

    it('can initialize', () => {
        const sequences = [
            ["line1\n", "line2\n", "line3\n"], // LOCAL
            ["line1\n", "line2\n", "line3\n"], // BASE
            ["line1\n", "line2\n", "line3\n"]  // REMOTE
        ];
        
        const init = merger.initialize(sequences, sequences);
        let val = init.next();
        let lastVal = val.value;
        while (!val.done) {
            lastVal = val.value;
            val = init.next();
        }
        
        expect(lastVal).toBe(1);
    });

    it('handles Delete/Delete splitting heuristics', () => {
        const local = ["A\n", "B\n", "C\n"];
        const base = ["A\n", "B\n", "C\n"];
        const remote = ["A\n", "C\n"]; // B deleted
        
        const sequences = [local, base, remote];
        const init = merger.initialize(sequences, sequences);
        let val = init.next();
        while (!val.done && val.value === null) {
            val = init.next();
        }
        
        const mergeGen = merger.merge_3_files(true);
        let finalMergedText: string | null = null;
        for (const res of mergeGen) {
            if (res !== null && typeof res === 'string') {
                finalMergedText = res;
            }
        }
        
        expect(finalMergedText).not.toBeNull();
    });
});
