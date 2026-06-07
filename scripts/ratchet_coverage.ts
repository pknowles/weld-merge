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

interface StrykerConfig {
	thresholds?: {
		high: number;
		low: number;
		break: number;
	};
}

interface StrykerReport extends MutationTestResult {}

const SLACK = 1;

const JEST_REGEXES = {
	branches: /branches:\s*(\d+)/,
	functions: /functions:\s*(\d+)/,
	lines: /lines:\s*(\d+)/,
	statements: /statements:\s*(\d+)/,
};

const LCOV_COUNTERS: Record<string, [keyof typeof lcovAccumInit, number]> = {
	"LF:": ["lf", 3],
	"LH:": ["lh", 3],
	"FNF:": ["fnf", 4],
	"FNH:": ["fnh", 4],
	"BRF:": ["brf", 4],
	"BRH:": ["brh", 4],
};
const lcovAccumInit = { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0 };

function writeAtomic(path: string, content: string): void {
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, content);
	renameSync(tmpPath, path);
}

function parseLcovTotals(lcov: string): CoverageConfig["combined"] {
	const acc = { ...lcovAccumInit };
	for (const line of lcov.split("\n")) {
		for (const [prefix, [key, offset]] of Object.entries(LCOV_COUNTERS)) {
			if (line.startsWith(prefix)) {
				acc[key] += Number(line.slice(offset));
				break;
			}
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

	const jestConfigPath = join(cwd(), "jest.config.js");
	let jestConfig = readFileSync(jestConfigPath, "utf8");

	const current: Record<keyof typeof JEST_REGEXES, number> = {
		branches: Number.parseInt(
			jestConfig.match(JEST_REGEXES.branches)?.[1] ?? "0",
			10,
		),
		functions: Number.parseInt(
			jestConfig.match(JEST_REGEXES.functions)?.[1] ?? "0",
			10,
		),
		lines: Number.parseInt(
			jestConfig.match(JEST_REGEXES.lines)?.[1] ?? "0",
			10,
		),
		statements: Number.parseInt(
			jestConfig.match(JEST_REGEXES.statements)?.[1] ?? "0",
			10,
		),
	};

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

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("New Jest thresholds:", next);

	for (const [key, regex] of Object.entries(JEST_REGEXES)) {
		if (!regex.test(jestConfig)) {
			throw new Error(
				`Could not find threshold key "${key}" in jest.config.js. Ensure the config matches the expected format.`,
			);
		}
		jestConfig = jestConfig.replace(
			regex,
			`${key}: ${next[key as keyof typeof next]}`,
		);
	}

	writeAtomic(jestConfigPath, jestConfig);
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

	config.combined.branches = Math.max(
		config.combined.branches,
		actual.branches - SLACK,
	);
	config.combined.functions = Math.max(
		config.combined.functions,
		actual.functions - SLACK,
	);
	config.combined.lines = Math.max(
		config.combined.lines,
		actual.lines - SLACK,
	);

	// biome-ignore lint/suspicious/noConsole: script output
	console.log("Combined coverage passed. New thresholds:", config.combined);
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
