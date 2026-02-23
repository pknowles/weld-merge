import sys
import os

# Add meld to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../')))

from meld.matchers.merge import Merger

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base_dir, 'test_cases.txt'), 'r') as f:
        content = f.read()

    cases = content.strip().split('---')
    results = []

    for case in cases:
        if not case.strip(): continue
        parts = case.strip().split('===')
        local = [p for p in parts[0].strip().split('\n') if p]
        base = [p for p in parts[1].strip().split('\n') if p]
        remote = [p for p in parts[2].strip().split('\n') if p]

        merger = Merger()
        for _ in merger.initialize([local, base, remote], [local, base, remote]):
            pass

        mergedtext = None
        for res in merger.merge_3_files(mark_conflicts=True):
            if res is not None:
                mergedtext = res

        results.append(mergedtext)

    with open(os.path.join(base_dir, 'expected_outputs.txt'), 'w') as f:
        f.write('\n---\n'.join(results))

if __name__ == '__main__':
    main()
