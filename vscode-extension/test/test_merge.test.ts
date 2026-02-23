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

import * as fs from 'fs';
import * as path from 'path';

describe('End-to-End Meld Parity', () => {
    it('matches exact output of the original Python Meld backend', () => {
        const testCasesPath = path.join(__dirname, 'test_cases.txt');
        const expectedOutputsPath = path.join(__dirname, 'expected_outputs.txt');

        const casesContent = fs.readFileSync(testCasesPath, 'utf-8');
        const expectedContent = fs.readFileSync(expectedOutputsPath, 'utf-8');

        // Split exact same way python does
        const cases = casesContent.trim().split('---').filter(c => c.trim() !== '');
        const expected = expectedContent.trim().split('\n---\n');

        expect(cases.length).toBe(expected.length);

        for (let i = 0; i < cases.length; i++) {
            const rawCase = cases[i];
            const parts = rawCase.trim().split('===');
            
            // Replicate the python reading logic EXACTLY
            const extract = (part: string) => part.trim().split('\n').filter(p => p !== '');
            const local = extract(parts[0]);
            const base = extract(parts[1]);
            const remote = extract(parts[2]);

            const merger = new Merger();
            const sequences = [local, base, remote];
            
            const initGen = merger.initialize(sequences, sequences);
            let val = initGen.next();
            while (!val.done && val.value === null) {
                val = initGen.next();
            }

            const mergeGen = merger.merge_3_files(true);
            let finalMergedText: string | null = null;
            for (const res of mergeGen) {
                if (res !== null && typeof res === 'string') {
                    finalMergedText = res;
                }
            }

            // Note: Since our version drops trailing newlines from lines and expected includes them (because of "\n".join())
            expect(finalMergedText).toBe(expected[i]);
        }
    });
});


