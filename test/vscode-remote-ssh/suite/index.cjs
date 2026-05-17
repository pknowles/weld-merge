"use strict";
const path = require("node:path");
const { glob } = require("glob");
const Mocha = require("mocha");

require("tsx/cjs");

async function run() {
	const mocha = new Mocha({
		ui: "bdd",
		color: true,
		timeout: 120_000,
	});
	const testsRoot = path.resolve(__dirname);
	const files = await glob("**/*.test.ts", {
		cwd: testsRoot,
		absolute: true,
	});

	for (const file of files.sort()) {
		mocha.addFile(file);
	}

	return new Promise((resolve, reject) => {
		mocha.run((failures) => {
			if (failures > 0) {
				reject(new Error(`${failures} tests failed`));
				return;
			}
			resolve();
		});
	});
}

module.exports = {
	run,
};
