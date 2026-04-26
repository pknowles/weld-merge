import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
// @ts-expect-error xvfb has no type definitions
import Xvfb from "xvfb";

async function main(): Promise<void> {
	const currentFile = fileURLToPath(import.meta.url);
	const currentDir = path.dirname(currentFile);
	const extensionDevelopmentPath = path.resolve(currentDir, "../..");
	const extensionTestsPath = path.resolve(currentDir, "suite/index.cjs");

	const xvfb =
		process.platform === "linux" ? new Xvfb({ silent: true }) : null;
	if (xvfb) {
		xvfb.startSync();
	}

	const userDataDir = mkdtempSync(path.join(tmpdir(), "weld-vscode-test-"));

	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				`--user-data-dir=${userDataDir}`,
				"--disable-extensions",
				"--skip-welcome",
				"--skip-release-notes",
			],
		});
	} finally {
		if (xvfb) {
			xvfb.stopSync();
		}
		rmSync(userDataDir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write("VS Code integration tests failed\n");
	const details =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${details}\n`);
	process.exitCode = 1;
});
