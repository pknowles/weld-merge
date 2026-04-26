import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Uri } from "vscode";
import { getGitApi } from "../../../src/repoContext.ts";

function runGit(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
	}).trim();
}

async function makeRepo(prefix: string): Promise<string> {
	const repoPath = await mkdtemp(join(tmpdir(), prefix));
	runGit(["init"], repoPath);
	runGit(["config", "user.name", "Weld Test"], repoPath);
	runGit(["config", "user.email", "weld-test@example.com"], repoPath);
	await writeFile(join(repoPath, "tracked.txt"), "base\n");
	runGit(["add", "--", "tracked.txt"], repoPath);
	runGit(["commit", "-m", "init"], repoPath);
	return repoPath;
}

async function makeRepoFile(
	repoPath: string,
	relativePath: string,
): Promise<Uri> {
	const filePath = join(repoPath, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, "content\n");
	return Uri.file(filePath);
}

async function openRepoInGitExtension(repoPath: string): Promise<void> {
	const gitApi = await getGitApi();
	const opened = await gitApi.openRepository(Uri.file(repoPath));
	if (!opened) {
		throw new Error(
			`Expected Git extension to open repository at ${repoPath}`,
		);
	}
}

export { makeRepo, makeRepoFile, openRepoInGitExtension, runGit };
