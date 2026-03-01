const _assert = require("node:assert");
const text = "1\n3\n";
const lines = text.split("\n");
const mapped1 = lines.map((line, i) =>
	i === lines.length - 1 ? line : `${line}\n`,
);
console.log("Original js split:", mapped1);

function pythonSplitLines(text) {
	if (!text) return [];
	const lines = text.split("\n");
	const res = [];
	for (let i = 0; i < lines.length; i++) {
		if (i === lines.length - 1) {
			if (lines[i] !== "") res.push(lines[i]);
		} else {
			res.push(`${lines[i]}\n`);
		}
	}
	return res;
}
console.log("pythonSplitLines:", pythonSplitLines(text));
