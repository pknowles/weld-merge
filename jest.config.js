export default {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	setupFilesAfterEnv: ["<rootDir>/src/jest.setup.ts"],
	collectCoverage: true,
	coverageDirectory: "coverage",
	coverageReporters: ["text", "lcov", "clover", "json-summary"],
	collectCoverageFrom: [
		"src/**/*.{ts,tsx}",
		"!src/**/*.d.ts",
		"!src/extension.ts", // Extension entry point often hard to test without vscode-test
	],
	coverageThreshold: {
		global: {
			branches: 61,
			functions: 64,
			lines: 66,
			statements: 66,
		},
	},
	testPathIgnorePatterns: [
		"/node_modules/",
		"/test/benchmarking/",
		"/test/vscode/",
		"/test/repo_context.test.ts",
		"/test/git_utils_gitdir.test.ts",
	],
	// Keep Jest's haste-map out of @vscode/test-electron's downloaded VS Code
	// trees. Each install ships ~70 built-in extensions whose package.json
	// names collide across versions (e.g. "diff"), breaking module resolution.
	modulePathIgnorePatterns: ["<rootDir>/.vscode-test/"],
};
