import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import Xvfb from "xvfb";

function createTestWorkspace(): string {
	const workspacePath = mkdtempSync(
		path.join(tmpdir(), "weld-vscode-workspace-"),
	);
	execFileSync("git", ["init"], { cwd: workspacePath });
	execFileSync("git", ["config", "user.name", "Weld Test"], {
		cwd: workspacePath,
	});
	execFileSync("git", ["config", "user.email", "weld-test@example.com"], {
		cwd: workspacePath,
	});
	writeFileSync(path.join(workspacePath, "README.md"), "# Test Workspace\n");
	execFileSync("git", ["add", "--", "README.md"], { cwd: workspacePath });
	execFileSync("git", ["commit", "-m", "init"], { cwd: workspacePath });
	return workspacePath;
}

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
	const workspacePath = createTestWorkspace();

	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				workspacePath,
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
		rmSync(workspacePath, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write("VS Code integration tests failed\n");
	const details =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${details}\n`);
	process.exitCode = 1;
});
