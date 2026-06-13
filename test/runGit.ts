import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export function assertSafeGitCwd(cwd: string): void {
	const absoluteCwd = resolve(cwd);
	const absoluteTempRoot = resolve(tmpdir());
	const tempRelativePath = relative(absoluteTempRoot, absoluteCwd);
	if (
		tempRelativePath.length > 0 &&
		!tempRelativePath.startsWith("..") &&
		!isAbsolute(tempRelativePath)
	) {
		return;
	}

	throw new Error(
		`Refusing to run test Git command outside temp dir: ${cwd}`,
	);
}

export function runGit(args: string[], cwd: string): string {
	assertSafeGitCwd(cwd);
	return execFileSync("git", ["-C", cwd, ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
