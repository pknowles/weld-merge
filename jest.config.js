import { readFileSync } from "node:fs";
import process from "node:process";

const coverageThresholds = JSON.parse(
	readFileSync(
		new URL("./jest.coverage.config.json", import.meta.url),
		"utf8",
	),
);

const focusedTestPathRegex = /^(test|src)\//;
const hasFocusedTestPath = process.argv
	.slice(2)
	.some((arg) => !arg.startsWith("-") && focusedTestPathRegex.test(arg));

export default {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	setupFilesAfterEnv: ["<rootDir>/src/jest.setup.ts"],
	collectCoverage: true,
	coverageDirectory: "test-output/jest/coverage",
	coverageReporters: ["text", "lcov", "clover", "json-summary"],
	collectCoverageFrom: [
		"src/**/*.{ts,tsx}",
		"!src/**/*.d.ts",
		// extension.ts command behavior is covered by Jest through activate()
		// and the mocked VS Code API; VS Code host tests cover integration.
	],
	// Enforce ratcheted global thresholds for full Jest coverage runs. Focused
	// coverage commands still report the target file's lines without failing
	// because unrelated source files were not exercised by that narrow run.
	...(hasFocusedTestPath
		? {}
		: {
				coverageThreshold: {
					global: coverageThresholds,
				},
			}),
	testPathIgnorePatterns: [
		"/node_modules/",
		"/test/benchmarking/",
		"/test/vscode/", // vscode integration tests (not jest)
		"/test/vscode-remote-ssh/", // manual Remote-SSH integration test (not jest)
		"/test/webview-integration/", // playwright browser webview integration tests (not jest)
	],
	// Keep Jest's haste-map out of @vscode/test-electron's downloaded VS Code
	// trees. Each install ships ~70 built-in extensions whose package.json
	// names collide across versions (e.g. "diff"), breaking module resolution.
	modulePathIgnorePatterns: [
		"<rootDir>/.vscode-test/",
		"<rootDir>/test-output/",
	],
	moduleNameMapper: {
		"^vscode$": "<rootDir>/test/mockVscode.ts",
	},
};
