import { spawnSync } from "node:child_process";
import { exit, stderr, stdout } from "node:process";

function runGit(args: string[]): string {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed with status ${result.status}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

function assertNoUnmergedPaths(label: string): void {
	const unmerged = runGit(["ls-files", "-u"]);
	if (unmerged.trim().length === 0) {
		return;
	}

	throw new Error(
		`${label}: refusing to run with unmerged index entries.\n${unmerged}`,
	);
}

function trackedStatus(): string {
	return runGit(["status", "--porcelain=v1", "--untracked-files=no"]);
}

function runStryker(): number {
	const result = spawnSync("npx", ["stryker", "run"], {
		stdio: "inherit",
	});

	if (result.error !== undefined) {
		throw result.error;
	}
	return result.status ?? 1;
}

function main(): void {
	assertNoUnmergedPaths("preflight");
	const beforeStatus = trackedStatus();

	const strykerStatus = runStryker();

	assertNoUnmergedPaths("postflight");
	const afterStatus = trackedStatus();
	if (afterStatus !== beforeStatus) {
		throw new Error(
			[
				"Stryker changed tracked working-tree state.",
				"Before:",
				beforeStatus.length === 0 ? "(clean)" : beforeStatus,
				"After:",
				afterStatus.length === 0 ? "(clean)" : afterStatus,
			].join("\n"),
		);
	}

	if (strykerStatus !== 0) {
		stdout.write(`Stryker exited with status ${strykerStatus}.\n`);
	}
	exit(strykerStatus);
}

try {
	main();
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	stderr.write(`${message}\n`);
	exit(1);
}
