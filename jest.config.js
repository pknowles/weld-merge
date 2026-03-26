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
			branches: 59,
			functions: 65,
			lines: 67,
			statements: 68,
		},
	},
};
