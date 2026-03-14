import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

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

interface StrykerMetrics {
	mutationScore: number;
}

interface StrykerReport {
	metrics?: StrykerMetrics;
	files?: Record<string, { mutants: Array<{ status: string }> }>;
}

const BRANCHES_REGEX = /branches: \d+/;
const FUNCTIONS_REGEX = /functions: \d+/;
const LINES_REGEX = /lines: \d+/;
const STATEMENTS_REGEX = /statements: \d+/;

/**
 * Updates testing thresholds based on the latest coverage and mutation reports.
 * This implements a "ratchet" mechanism to prevent quality regressions.
 */
function ratchet() {
	// 1. Ratchet Jest Coverage
	try {
		const coverageSummaryPath = join(
			cwd(),
			"coverage",
			"coverage-summary.json",
		);
		if (existsSync(coverageSummaryPath)) {
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

			jestConfig = jestConfig.replace(
				BRANCHES_REGEX,
				`branches: ${newThresholds.branches}`,
			);
			jestConfig = jestConfig.replace(
				FUNCTIONS_REGEX,
				`functions: ${newThresholds.functions}`,
			);
			jestConfig = jestConfig.replace(
				LINES_REGEX,
				`lines: ${newThresholds.lines}`,
			);
			jestConfig = jestConfig.replace(
				STATEMENTS_REGEX,
				`statements: ${newThresholds.statements}`,
			);

			writeFileSync(jestConfigPath, jestConfig);
		}
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		// biome-ignore lint/suspicious/noConsole: script error
		console.error("Failed to ratchet Jest:", message);
	}

	// 2. Ratchet Stryker Mutation Score
	try {
		const mutationSummaryPath = join(
			cwd(),
			"reports",
			"mutation",
			"mutation.json",
		);
		if (existsSync(mutationSummaryPath)) {
			const data: StrykerReport = JSON.parse(
				readFileSync(mutationSummaryPath, "utf8"),
			);

			let score = 0;
			if (data.metrics) {
				score = data.metrics.mutationScore;
			} else if (data.files) {
				let killed = 0;
				let total = 0;
				for (const [_, fileData] of Object.entries(data.files)) {
					for (const mutant of fileData.mutants) {
						total++;
						if (["Killed", "Timeout"].includes(mutant.status)) {
							killed++;
						}
					}
				}
				score = total > 0 ? (killed / total) * 100 : 0;
			}

			if (score > 0) {
				const breakScore = Math.floor(score);
				// biome-ignore lint/suspicious/noConsole: script output
				console.log("New Stryker Break Threshold:", breakScore);

				const strykerConfigPath = join(cwd(), "stryker.config.json");
				const strykerConfig: StrykerConfig = JSON.parse(
					readFileSync(strykerConfigPath, "utf8"),
				);

				if (strykerConfig.thresholds) {
					strykerConfig.thresholds.break = breakScore;
					writeFileSync(
						strykerConfigPath,
						`${JSON.stringify(strykerConfig, null, "\t")}\n`,
					);
				}
			}
		}
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		// biome-ignore lint/suspicious/noConsole: script error
		console.error("Failed to ratchet Stryker:", message);
	}
}

ratchet();
