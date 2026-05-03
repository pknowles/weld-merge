import { describe, it } from "@jest/globals";
import { Differ } from "../src/matchers/diffutil.ts";

describe("Ctrl+A delete", () => {
	it("does not crash when deleting everything", () => {
		const oldLeft = ["A", "B", "C", "D"];
		const oldMid = [
			"<<<<<<< HEAD",
			"A",
			"B",
			"X",
			"=======",
			"A",
			"B",
			"C",
			"D",
			">>>>>>> branch",
		];
		const oldRight = ["A", "B", "X"];

		const differ = new Differ();
		differ.setSequences([oldLeft, oldMid, oldRight]);

		const newMid = [""]; // Ctrl+A, Delete

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
	});
});
