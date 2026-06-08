import { readFileSync } from "node:fs";

const coverageThresholds = JSON.parse(
	readFileSync(
		new URL("./jest.coverage.config.json", import.meta.url),
		"utf8",
	),
);

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
		"!src/extension.ts", // Extension entry point often hard to test without vscode-test
	],
	coverageThreshold: {
		global: coverageThresholds,
	},
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
