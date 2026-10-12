/**
 * @file ratchet_coverage.ts
 * @description Ratchets coverage and mutation thresholds upward from fresh
 * report files. Called internally by other scripts — not a standalone user
 * command.
 *
 * Exports three independent ratchet functions so callers can invoke only the
 * ones relevant to what just ran:
 *   ratchetJestCoverage()     — Jest coverage-summary.json → jest.config.js
 *   ratchetCombinedCoverage() — combined LCOV → coverage.config.json
 *   ratchetStrykerScore()     — Stryker JSON  → stryker.config.json
 *
 * All functions throw on failure; callers are responsible for catching.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { calculateMetrics } from "mutation-testing-metrics";
import type { MutationTestResult } from "mutation-testing-report-schema";

interface JestCoverageSummary {
	total: {
		lines: { pct: number };
		statements: { pct: number };
		functions: { pct: number };
		branches: { pct: number };
	};
}

interface CoverageConfig {
	combined: {
		branches: number;
		functions: number;
		lines: number;
	};
}

interface JestCoverageThresholds {
	branches: number;
	functions: number;
	lines: number;
	statements: number;
}

interface LcovAccum {
	lf: number;
	lh: number;
	fnf: number;
	fnh: number;
	brf: number;
	brh: number;
}

interface StrykerConfig {
	thresholds?: {
		high: number;
		low: number;
		break: number;
	};
}

interface StrykerReport extends MutationTestResult {}

const SLACK = 1;

const LCOV_COUNTERS: Record<string, keyof LcovAccum> = {
	"LF:": "lf",
	"LH:": "lh",
	"FNF:": "fnf",
	"FNH:": "fnh",
	"BRF:": "brf",
	"BRH:": "brh",
};
const lcovAccumInit: LcovAccum = {
	lf: 0,
	lh: 0,
	fnf: 0,
	fnh: 0,
	brf: 0,
	brh: 0,
};

function writeAtomic(path: string, content: string): void {
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, content);
	renameSync(tmpPath, path);
}

function parseLcovTotals(lcov: string): CoverageConfig["combined"] {
	const acc = { ...lcovAccumInit };
	for (const line of lcov.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) {
			continue;
		}
		const key = LCOV_COUNTERS[`${line.slice(0, colon)}:`];
		if (key !== undefined) {
			acc[key] += Number(line.slice(colon + 1));
		}
	}
	return {
		branches: acc.brf > 0 ? Math.floor((acc.brh / acc.brf) * 100) : 0,
		functions: acc.fnf > 0 ? Math.floor((acc.fnh / acc.fnf) * 100) : 0,
		lines: acc.lf > 0 ? Math.floor((acc.lh / acc.lf) * 100) : 0,
	};
}

export function ratchetJestCoverage(): void {
	const summaryPath = join(
		cwd(),
		"test-output",
		"jest",
		"coverage",
		"coverage-summary.json",
	);
	if (!existsSync(summaryPath)) {
		throw new Error(
			`Jest coverage summary not found at ${summaryPath}. Run 'npm run coverage' to generate it.`,
		);
	}

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("Ratcheting Jest thresholds from Jest-only coverage...");
	const summary: JestCoverageSummary = JSON.parse(
		readFileSync(summaryPath, "utf8"),
	);
	const { total } = summary;

	const thresholdsPath = join(cwd(), "jest.coverage.config.json");
	const current: JestCoverageThresholds = JSON.parse(
		readFileSync(thresholdsPath, "utf8"),
	);

	const next = {
		branches: Math.max(
			current.branches,
			Math.floor(total.branches.pct) - SLACK,
		),
		functions: Math.max(
			current.functions,
			Math.floor(total.functions.pct) - SLACK,
		),
		lines: Math.max(current.lines, Math.floor(total.lines.pct) - SLACK),
		statements: Math.max(
			current.statements,
			Math.floor(total.statements.pct) - SLACK,
		),
	};

	if (
		next.branches === current.branches &&
		next.functions === current.functions &&
		next.lines === current.lines &&
		next.statements === current.statements
	) {
		// biome-ignore lint/suspicious/noConsole: script output
		console.log("Jest thresholds unchanged:", next);
		return;
	}

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("New Jest thresholds:", next);
	writeAtomic(thresholdsPath, `${JSON.stringify(next, null, "\t")}\n`);
}

export function ratchetCombinedCoverage(): void {
	const lcovPath = join(
		cwd(),
		"test-output",
		"coverage",
		"combined",
		"lcov.info",
	);
	if (!existsSync(lcovPath)) {
		throw new Error(
			`Combined coverage LCOV not found at ${lcovPath}. Run 'npm run coverage' to generate it.`,
		);
	}

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("Checking combined coverage thresholds...");
	const actual = parseLcovTotals(readFileSync(lcovPath, "utf8"));

	const configPath = join(cwd(), "coverage.config.json");
	const config: CoverageConfig = JSON.parse(readFileSync(configPath, "utf8"));

	const failures = (Object.keys(actual) as Array<keyof typeof actual>).filter(
		(k) => actual[k] < config.combined[k],
	);

	if (failures.length > 0) {
		throw new Error(
			`Combined coverage below threshold:\n${failures
				.map(
					(k) =>
						`  ${k}: ${actual[k]}% < ${config.combined[k]}% required`,
				)
				.join("\n")}`,
		);
	}

	const next = {
		branches: Math.max(config.combined.branches, actual.branches - SLACK),
		functions: Math.max(
			config.combined.functions,
			actual.functions - SLACK,
		),
		lines: Math.max(config.combined.lines, actual.lines - SLACK),
	};

	if (
		next.branches === config.combined.branches &&
		next.functions === config.combined.functions &&
		next.lines === config.combined.lines
	) {
		// biome-ignore lint/suspicious/noConsole: script output
		console.log("Combined coverage passed. Thresholds unchanged:", next);
		return;
	}

	config.combined = next;
	// biome-ignore lint/suspicious/noConsole: script output
	console.log("Combined coverage passed. New thresholds:", next);
	writeAtomic(configPath, `${JSON.stringify(config, null, "\t")}\n`);
}

export function ratchetStrykerScore(): void {
	const mutationSummaryPath = join(
		cwd(),
		"test-output",
		"stryker",
		"reports",
		"mutation.json",
	);
	if (!existsSync(mutationSummaryPath)) {
		throw new Error(
			`Stryker report not found at ${mutationSummaryPath}. Run 'npm run test:mutate' first.`,
		);
	}

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("Ratcheting Stryker mutation score...");
	const data = JSON.parse(
		readFileSync(mutationSummaryPath, "utf8"),
	) as StrykerReport;

	if (!data.files) {
		throw new Error(
			"Stryker report missing 'files'. Ensure the 'json' reporter is enabled and mutants were generated.",
		);
	}

	const { metrics } = calculateMetrics(data.files);
	if (metrics.mutationScore <= 0) {
		return;
	}

	const strykerConfigPath = join(cwd(), "stryker.config.json");
	const strykerConfig: StrykerConfig = JSON.parse(
		readFileSync(strykerConfigPath, "utf8"),
	);

	const breakScore = Math.max(
		strykerConfig.thresholds?.break ?? 0,
		Math.floor(metrics.mutationScore) - SLACK,
	);

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("New Stryker break threshold:", breakScore);

	if (strykerConfig.thresholds) {
		strykerConfig.thresholds.break = breakScore;
		writeAtomic(
			strykerConfigPath,
			`${JSON.stringify(strykerConfig, null, "\t")}\n`,
		);
	}
}
