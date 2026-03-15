// biome-ignore lint/style/noDefaultExport: config files often require default export
export default {
	preset: "ts-jest",
	testEnvironment: "node",
	testRunner: "@jazzer.js/jest-runner",
	testMatch: ["**/*.fuzz.ts"],
	collectCoverage: false,
};
