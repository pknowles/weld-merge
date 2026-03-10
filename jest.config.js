// biome-ignore lint/style/noDefaultExport: config files often require default export
export default {
	preset: "ts-jest",
	testEnvironment: "jsdom",
	setupFilesAfterEnv: ["<rootDir>/src/jest.setup.ts"],
};
