import {
    MyersSequenceMatcher,
    InlineMyersSequenceMatcher,
    SyncPointMyersSequenceMatcher,
    find_common_prefix,
    find_common_suffix
} from '../src/matchers/myers';

describe('MyersSequenceMatcher', () => {
    describe('Prefix/Suffix matching', () => {
        it('finds common prefix', () => {
            expect(find_common_prefix("abcdef", "abcfed")).toBe(3);
            expect(find_common_prefix("abcdef", "abcdef")).toBe(6);
            expect(find_common_prefix("abcdef", "")).toBe(0);
        });

        it('finds common suffix', () => {
            expect(find_common_suffix("abcdef", "feddef")).toBe(3);
            expect(find_common_suffix("abcdef", "abcdef")).toBe(6);
            expect(find_common_suffix("abcdef", "")).toBe(0);
        });
    });

    describe('Sequence matching', () => {
        it('matches identical sequences', () => {
            const matcher = new MyersSequenceMatcher(null, "abcdef", "abcdef");
            expect(matcher.get_opcodes()).toEqual([
                { tag: 'equal', start_a: 0, end_a: 6, start_b: 0, end_b: 6 }
            ]);
        });

        it('handles complete replacements', () => {
            const matcher = new MyersSequenceMatcher(null, "abc", "def");
            expect(matcher.get_opcodes()).toEqual([
                { tag: 'replace', start_a: 0, end_a: 3, start_b: 0, end_b: 3 }
            ]);
        });
    });
});

describe('InlineMyersSequenceMatcher', () => {
    it('uses k-mers for better inline matching', () => {
        const matcher = new InlineMyersSequenceMatcher(null, "hello world", "hello brave world");
        const opcodes = matcher.get_opcodes();
        expect(opcodes).toContainEqual({ tag: 'equal', start_a: 0, end_a: 6, start_b: 0, end_b: 6 });
    });
});
