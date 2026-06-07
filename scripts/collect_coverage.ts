/**
 * @file collect_coverage.ts
 * @description Runs both test suites with coverage, merges the results, and
 * ratchets thresholds. This is the only supported entry point for coverage
 * collection — running the individual steps out of order produces stale data.
 *
 * Usage: npm run coverage
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cwd, exit } from "node:process";
import { mergeCoverageReportFiles } from "lcov-result-merger";
import {
	ratchetCombinedCoverage,
	ratchetJestCoverage,
} from "./ratchet_coverage.ts";

const root = cwd();
const JEST_LCOV = join(root, "test-output", "jest", "coverage", "lcov.info");
const VSCODE_LCOV = join(
	root,
	"test-output",
	"coverage",
	"vscode",
	"lcov.info",
);
const COMBINED_DIR = join(root, "test-output", "coverage", "combined");
const COMBINED_LCOV = join(COMBINED_DIR, "lcov.info");

function log(label: string): void {
	// biome-ignore lint/suspicious/noConsole: script output
	console.log(`\n=== ${label} ===`);
}

function runJestCoverage(): void {
	log("Jest coverage");
	rmSync(JEST_LCOV, { force: true });
	execFileSync("npx", ["jest", "--coverage"], {
		stdio: "inherit",
		cwd: root,
	});
	if (!existsSync(JEST_LCOV)) {
		throw new Error(`Jest did not produce ${JEST_LCOV}`);
	}
}

function runVscodeCoverage(): void {
	log("VS Code integration tests");
	rmSync(VSCODE_LCOV, { force: true });

	const rawParent = join(root, "test-output", "coverage");
	mkdirSync(rawParent, { recursive: true });
	const rawDir = mkdtempSync(join(rawParent, "vscode-raw-"));
	try {
		execFileSync(
			"env",
			[
				"-u",
				"ELECTRON_RUN_AS_NODE",
				`NODE_V8_COVERAGE=${rawDir}`,
				"npx",
				"tsx",
				"test/vscode/runTest.ts",
			],
			{ stdio: "inherit", cwd: root },
		);

		const vscodeDir = join(root, "test-output", "coverage", "vscode");
		mkdirSync(vscodeDir, { recursive: true });

		log("c8 LCOV report");
		execFileSync(
			"npx",
			[
				"c8",
				"report",
				"--reporter=lcov",
				`--report-dir=${vscodeDir}`,
				`--temp-directory=${rawDir}`,
				"--include=src/**",
				"--exclude=src/**/*.test.ts",
				"--exclude=src/**/*.d.ts",
			],
			{ stdio: "inherit", cwd: root },
		);
	} finally {
		rmSync(rawDir, { recursive: true, force: true });
	}

	if (!existsSync(VSCODE_LCOV)) {
		throw new Error(`c8 did not produce ${VSCODE_LCOV}`);
	}
}

async function mergeLcov(): Promise<void> {
	log("Merging coverage reports");
	mkdirSync(COMBINED_DIR, { recursive: true });
	const merged = await mergeCoverageReportFiles([JEST_LCOV, VSCODE_LCOV], {
		pattern: "",
	});
	const tmpPath = `${COMBINED_LCOV}.tmp`;
	writeFileSync(tmpPath, merged, "utf8");
	renameSync(tmpPath, COMBINED_LCOV);
	// biome-ignore lint/suspicious/noConsole: script output
	console.log(`Combined LCOV written to ${COMBINED_LCOV}`);
}

async function main(): Promise<void> {
	runJestCoverage();
	runVscodeCoverage();
	await mergeLcov();

	ratchetJestCoverage();
	ratchetCombinedCoverage();
}

main().catch((err: unknown) => {
	// biome-ignore lint/suspicious/noConsole: script error
	console.error(err instanceof Error ? err.message : String(err));
	exit(1);
});
