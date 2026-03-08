import { Differ } from "../src/matchers/diffutil.ts";

describe("Differ algorithm robustness", () => {
	it("does not produce NaN when deleting a massive chunk from the middle", () => {
		const oldLeft = Array.from({ length: 1000 }, (_, i) => `Line L${i}`);
		const oldMid = Array.from({ length: 1000 }, (_, i) => `Line M${i}`);
		const oldRight = Array.from({ length: 1000 }, (_, i) => `Line R${i}`);

		const differ = new Differ();
		const it = differ.setSequencesIter([oldLeft, oldMid, oldRight]);
		for (const _step of it) {
			// consume iterator
		}

		const newMid = [...oldMid];
		newMid.splice(100, 800); // delete 800 lines!

		const minLen = Math.min(oldMid.length, newMid.length);
		let startidx = 0;
		while (startidx < minLen && oldMid[startidx] === newMid[startidx]) {
			startidx++;
		}
		const sizechange = newMid.length - oldMid.length;

		differ.changeSequence(1, startidx, sizechange, [
			oldLeft,
			newMid,
			oldRight,
		]);

		const nans = differ.diffs[0].filter(
			(c) =>
				Number.isNaN(c.startA) ||
				Number.isNaN(c.endA) ||
				Number.isNaN(c.startB) ||
				Number.isNaN(c.endB),
		);
		expect(nans.length).toBe(0);
	});

	it("does not produce NaN when deleting the entire middle file", () => {
		const oldLeft = Array.from({ length: 100 }, (_, i) => `Line L${i}`);
		const oldMid = Array.from({ length: 100 }, (_, i) => `Line M${i}`);
		const oldRight = Array.from({ length: 100 }, (_, i) => `Line R${i}`);

		const differ = new Differ();
		const it = differ.setSequencesIter([oldLeft, oldMid, oldRight]);
		for (const _step of it) {
			// consume iterator
		}

		const newMid: string[] = [];

		const minLen = Math.min(oldMid.length, newMid.length);
		let startidx = 0;
		while (startidx < minLen && oldMid[startidx] === newMid[startidx]) {
			startidx++;
		}
		const sizechange = newMid.length - oldMid.length;

		differ.changeSequence(1, startidx, sizechange, [
			oldLeft,
			newMid,
			oldRight,
		]);

		const nans = differ.diffs[0].filter(
			(c) =>
				Number.isNaN(c.startA) ||
				Number.isNaN(c.endA) ||
				Number.isNaN(c.startB) ||
				Number.isNaN(c.endB),
		);
		expect(nans.length).toBe(0);
	});
});
