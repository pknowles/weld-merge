import sys
import os
import json
import random
import traceback
import pdb

# Ensure we can import meld-python
sys.path.insert(0, os.path.abspath(os.path.join(os.getcwd(), "meld-python")))

from meld.matchers.diffutil import Differ
from meld.matchers.merge import Merger

class StringTable:
    def __init__(self):
        self.table = []
        self.map = {}

    def get_index(self, s):
        if s not in self.map:
            self.map[s] = len(self.table)
            self.table.append(s)
        return self.map[s]

    def get_indices(self, lines):
        return [self.get_index(l) for l in lines]

def diff_to_compact(diffs):
    """Convert DiffChunk objects to plain arrays for JSON compactness."""
    return [[c[0], c[1], c[2], c[3], c[4]] for c in diffs]

def run_trace(initial_text, edits):
    """
    initial_text: list of lines for base in all 3 panes
    edits: list of (pane, start, sizechange, new_pane_text_list)
    """
    st = StringTable()
    
    # Texts in each of the 3 panes
    texts = [initial_text[:], initial_text[:], initial_text[:]]
    
    merger = Merger()
    for _ in merger.initialize(texts, texts):
        pass
        
    trace_steps = []
    
    for i, (pane, start, sizechange, new_pane_texts) in enumerate(edits):
        texts[pane] = new_pane_texts
        merger.texts = texts # Update references
        
        # Apply to Meld Python Differ
        merger.differ.change_sequence(pane, start, sizechange, texts)
        
        # Capture state
        output = ""
        for res in merger.merge_3_files(True):
            if res is not None:
                output = res
        
        # Compact Schema: [pane, start, sizechange, [indices], [[diffs0], [diffs1]], output_index, unresolved]
        step_data = [
            pane, 
            start, 
            sizechange, 
            st.get_indices(new_pane_texts),
            [diff_to_compact(d) for d in merger.differ.diffs],
            st.get_index(output),
            len(getattr(merger, 'unresolved', []))
        ]
        trace_steps.append(step_data)
        
    return {
        "t": st.table,             # String Table
        "it": st.get_indices(initial_text), # Initial Text Indices
        "s": trace_steps            # Steps
    }

def generate_validation_trace():
    base = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]
    edits = []
    
    # Manual targeted edits
    manual = [
        (0, 0, 1, ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]),
        (2, 2, 0, ["Line 1", "Line 2", "Line 2 mod", "Line 4", "Line 5"]),
        (1, 1, -1, ["Line 1", "Line 3", "Line 4", "Line 5"]),
        (0, 3, 2, ["Line 0", "Line 1", "Line 2", "A", "B", "Line 3", "Line 4", "Line 5"]),
        (2, 0, -2, ["Line 2 mod", "Line 4", "Line 5"]),
        (1, 0, 5, ["I1", "I2", "I3", "I4", "I5", "Line 1", "Line 3", "Line 4", "Line 5"]),
    ]
    
    current_texts = [base[:], base[:], base[:]]
    for p, s, sc, nt in manual:
        edits.append((p, s, sc, nt))
        current_texts[p] = nt

    # Add random edits
    random.seed(42)
    for _ in range(500):
        pane = random.randint(0, 2)
        txt = current_texts[pane]
        if not txt:
            op = "insert"
        else:
            op = random.choice(["insert", "delete", "replace"])
            
        if op == "insert":
            pos = random.randint(0, len(txt))
            count = random.randint(1, 3)
            new_stuff = [f"Fuzz {random.randint(0, 1000)}" for _ in range(count)]
            new_txt = txt[:pos] + new_stuff + txt[pos:]
            edits.append((pane, pos, count, new_txt))
            current_texts[pane] = new_txt
        elif op == "delete":
            pos = random.randint(0, len(txt) - 1)
            count = random.randint(1, min(3, len(txt) - pos))
            new_txt = txt[:pos] + txt[pos+count:]
            edits.append((pane, pos, -count, new_txt))
            current_texts[pane] = new_txt
        elif op == "replace":
            pos = random.randint(0, len(txt) - 1)
            count = random.randint(1, min(3, len(txt) - pos))
            new_stuff = [f"Mod {random.randint(0, 1000)}" for _ in range(count)]
            new_txt = txt[:pos] + new_stuff + txt[pos+count:]
            edits.append((pane, pos, 0, new_txt))
            current_texts[pane] = new_txt

    try:
        trace = run_trace(base, edits)
        with open("test/parity_trace.json", "w") as f:
            json.dump(trace, f, separators=(",", ":"))
        print(f"Generated test/parity_trace.json with {len(trace['s'])} steps.")
    except Exception:
        extype, value, tb = sys.exc_info()
        traceback.print_exc()
        pdb.post_mortem(tb)

if __name__ == "__main__":
    generate_validation_trace()
