import { Differ } from "../src/matchers/diffutil";

describe("Differ with conflict markers", () => {
	it("does not crash when deleting all conflict markers", () => {
		const oldLeft = [
			"A", "B", "C", "D"
		];
		const oldMid = [
			"<<<<<<< HEAD",
			"A", "B", "X",
			"=======",
			"A", "B", "C", "D",
			">>>>>>> branch"
		];
		const oldRight = [
			"A", "B", "X"
		];

		const differ = new Differ();
		const it = differ.set_sequences_iter([oldLeft, oldMid, oldRight]);
		for (const _step of it);

		const newMid = [
			"A", "B", "C", "D" // user resolves conflict by deleting markers and X block
		];

		const minLen = Math.min(oldMid.length, newMid.length);
		let startidx = 0;
		while (startidx < minLen && oldMid[startidx] === newMid[startidx]) {
			startidx++;
		}
		const sizechange = newMid.length - oldMid.length;

		differ.change_sequence(1, startidx, sizechange, [oldLeft, newMid, oldRight]);

		const nans = differ.diffs[1].filter(c => Number.isNaN(c.start_a) || Number.isNaN(c.end_a) || Number.isNaN(c.start_b) || Number.isNaN(c.end_b));
		expect(nans.length).toBe(0);
	});
});
