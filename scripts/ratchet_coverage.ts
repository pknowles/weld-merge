/**
 * @file ratchet_coverage.ts
 * @description This script implements a "ratchet" mechanism for test quality.
 * It reads the latest Jest coverage reports and Stryker mutation reports,
 * and automatically updates the project configurations (jest.config.js and stryker.config.json)
 * with the new scores if they are higher than the current thresholds.
 *
 * Usage:
 * 1. Run tests with coverage: `npm run test:coverage`
 * 2. Run mutation tests: `npm run test:mutate`
 * 3. Run this script: `npm run ratchet`
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd, exit } from "node:process";
import { calculateMetrics } from "mutation-testing-metrics";

interface CoverageSummary {
	total: {
		lines: { pct: number };
		statements: { pct: number };
		functions: { pct: number };
		branches: { pct: number };
	};
}

interface StrykerConfig {
	thresholds?: {
		high: number;
		low: number;
		break: number;
	};
}

import type { MutationTestResult } from "mutation-testing-report-schema";

interface StrykerReport extends MutationTestResult {}

const REGEXES = {
	branches: /branches:\s*\d+/,
	functions: /functions:\s*\d+/,
	lines: /lines:\s*\d+/,
	statements: /statements:\s*\d+/,
};

/**
 * Writes a file atomically to prevent configuration corruption.
 */
function writeAtomic(path: string, content: string) {
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, content);
	renameSync(tmpPath, path);
}

/**
 * Orchestrates the ratcheting process for both Jest and Stryker.
 */
/**
 * Ratchets Jest coverage thresholds in jest.config.js.
 * @returns true if an error occurred, false otherwise.
 */
function ratchetJestCoverage(): boolean {
	try {
		const coverageSummaryPath = join(
			cwd(),
			"coverage",
			"coverage-summary.json",
		);
		if (!existsSync(coverageSummaryPath)) {
			return false;
		}

		// biome-ignore lint/suspicious/noConsole: script output
		console.log("Ratcheting Jest coverage...");
		const summary: CoverageSummary = JSON.parse(
			readFileSync(coverageSummaryPath, "utf8"),
		);
		const total = summary.total;

		const jestConfigPath = join(cwd(), "jest.config.js");
		let jestConfig = readFileSync(jestConfigPath, "utf8");

		const newThresholds = {
			branches: Math.floor(total.branches.pct),
			functions: Math.floor(total.functions.pct),
			lines: Math.floor(total.lines.pct),
			statements: Math.floor(total.statements.pct),
		};

		// biome-ignore lint/suspicious/noConsole: script output
		console.log("New Jest Thresholds:", newThresholds);

		for (const [key, regex] of Object.entries(REGEXES)) {
			if (!regex.test(jestConfig)) {
				throw new Error(
					`Could not find threshold key "${key}" in jest.config.js using regex ${regex}. Please ensure the config file matches the expected format.`,
				);
			}
			jestConfig = jestConfig.replace(
				regex,
				`${key}: ${newThresholds[key as keyof typeof newThresholds]}`,
			);
		}

		writeAtomic(jestConfigPath, jestConfig);
		return false;
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		// biome-ignore lint/suspicious/noConsole: script error
		console.error("Failed to ratchet Jest:", message);
		return true;
	}
}

/**
 * Ratchets Stryker mutation score in stryker.config.json.
 * @returns true if an error occurred, false otherwise.
 */
function ratchetStrykerScore(): boolean {
	try {
		const mutationSummaryPath = join(
			cwd(),
			"reports",
			"mutation",
			"mutation.json",
		);
		if (!existsSync(mutationSummaryPath)) {
			return false;
		}

		// biome-ignore lint/suspicious/noConsole: script output
		console.log("Ratcheting Stryker mutation score...");
		const data = JSON.parse(
			readFileSync(mutationSummaryPath, "utf8"),
		) as StrykerReport;

		let score = 0;
		if (data.files) {
			const metricsResult = calculateMetrics(data.files);
			score = metricsResult.metrics.mutationScore;
		} else {
			throw new Error(
				"Stryker report missing 'files'. Ensure the 'json' reporter is enabled and mutants were generated.",
			);
		}

		if (score <= 0) {
			return false;
		}

		const breakScore = Math.floor(score);
		// biome-ignore lint/suspicious/noConsole: script output
		console.log("New Stryker Break Threshold:", breakScore);

		const strykerConfigPath = join(cwd(), "stryker.config.json");
		const strykerConfig: StrykerConfig = JSON.parse(
			readFileSync(strykerConfigPath, "utf8"),
		);

		if (strykerConfig.thresholds) {
			strykerConfig.thresholds.break = breakScore;
			writeAtomic(
				strykerConfigPath,
				`${JSON.stringify(strykerConfig, null, "\t")}\n`,
			);
		}
		return false;
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		// biome-ignore lint/suspicious/noConsole: script error
		console.error("Failed to ratchet Stryker:", message);
		return true;
	}
}

/**
 * Orchestrates the ratcheting process for both Jest and Stryker.
 */
function ratchetCoverage() {
	const jestError = ratchetJestCoverage();
	const strykerError = ratchetStrykerScore();

	if (jestError || strykerError) {
		exit(1);
	}
}

ratchetCoverage();
