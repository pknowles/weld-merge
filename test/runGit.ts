import { execFileSync } from "node:child_process";

export function runGit(args: string[], cwd: string): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
