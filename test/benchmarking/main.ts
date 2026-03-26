import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
	type BenchmarkResult,
	getPreviousResult,
	saveResult,
} from "./database.ts";
import { parseProfile } from "./parser.ts";

const UI_STRESS_REGEX = /UI_STRESS:(\d+)/;

interface BenchmarkStats {
	name: string;
	selfTime: number;
	totalTime: number;
	hitCount: number;
}

interface LogicResults {
	latency: number;
	totalHits: number;
	stats: BenchmarkStats[];
}

function runBenchmarks() {
	const resultsDir = path.resolve(
		process.cwd(),
		"test",
		"benchmarking",
		"results",
	);
	if (!fs.existsSync(resultsDir)) {
		fs.mkdirSync(resultsDir, { recursive: true });
	}

	const dbPath = path.join(resultsDir, "benchmark_results.json");
	const prev = getPreviousResult(dbPath);

	const logicResults = runLogicBenchmark(resultsDir);
	runUIStressTest(resultsDir);

	const perfStatsPath = path.join(resultsDir, "perf_stats.log");
	let uiTime = 0;
	if (fs.existsSync(perfStatsPath)) {
		const log = fs.readFileSync(perfStatsPath, "utf8");
		const match = log.match(UI_STRESS_REGEX);
		if (match) {
			uiTime = Number(match[1]);
		}
	}

	const uiProfilePath = path.join(resultsDir, "ui_stress.cpuprofile");
	const uiStats = parseProfile(uiProfilePath, "meld") as BenchmarkStats[];
	const uiHits = uiStats.reduce((acc, s) => acc + s.selfTime, 0);

	const current = saveResult(dbPath, {
		logicLatency: logicResults.latency,
		logicHits: logicResults.totalHits,
		logicFunctions: logicResults.stats,
		uiTime,
		uiHits,
		uiFunctions: uiStats.slice(0, 20),
	});

	printSummary(current, logicResults.stats, uiStats, prev ?? null);
}

function runLogicBenchmark(resultsDir: string): LogicResults {
	// biome-ignore lint/suspicious/noConsole: report
	console.log("\n[1/2] Running Logic Benchmarks (Node)...");
	const logicResultsPath = path.join(resultsDir, "logic_bench_results.json");
	if (fs.existsSync(logicResultsPath)) {
		fs.unlinkSync(logicResultsPath);
	}
	try {
		execSync("npx tsx test/benchmarking/logic_bench.ts", {
			stdio: "inherit",
			/* biome-ignore lint/style/useNamingConvention: env var */
			env: { ...process.env, BENCH_RESULTS_DIR: resultsDir },
		});
	} catch (e) {
		// biome-ignore lint/suspicious/noConsole: report
		console.error("Logic benchmark failed:", e);
	}

	let logicResults: LogicResults = { latency: 0, totalHits: 0, stats: [] };
	if (fs.existsSync(logicResultsPath)) {
		logicResults = JSON.parse(fs.readFileSync(logicResultsPath, "utf8"));
	}
	return logicResults;
}

function runUIStressTest(resultsDir: string) {
	// biome-ignore lint/suspicious/noConsole: report
	console.log("\n[2/2] Running UI Stress Tests (Playwright)...");
	const perfStatsPath = path.join(resultsDir, "perf_stats.log");
	if (fs.existsSync(perfStatsPath)) {
		fs.unlinkSync(perfStatsPath);
	}
	try {
		execSync("npx playwright test test/benchmarking/ui_stress.test.ts", {
			stdio: "inherit",
			/* biome-ignore lint/style/useNamingConvention: env var */
			env: { ...process.env, BENCH_RESULTS_DIR: resultsDir },
		});
	} catch (e) {
		// biome-ignore lint/suspicious/noConsole: report
		console.error("UI stress test failed:", e);
	}
}

function formatDuration(ns: number): string {
	if (ns < 1000) {
		return `${ns.toFixed(2)} ns`;
	}
	if (ns < 1e6) {
		return `${(ns / 1e3).toFixed(2)} µs`;
	}
	if (ns < 1e9) {
		return `${(ns / 1e6).toFixed(2)} ms`;
	}
	return `${(ns / 1e9).toFixed(2)} s`;
}

function formatDurationPair(nsPrev: number, nsCurr: number): string {
	const max = Math.max(nsPrev, nsCurr);
	if (max < 1000) {
		return `${nsPrev.toFixed(2)}ns -> ${nsCurr.toFixed(2)}ns`;
	}
	if (max < 1e6) {
		return `${(nsPrev / 1e3).toFixed(2)}µs -> ${(nsCurr / 1e3).toFixed(2)}µs`;
	}
	if (max < 1e9) {
		return `${(nsPrev / 1e6).toFixed(2)}ms -> ${(nsCurr / 1e6).toFixed(2)}ms`;
	}
	return `${(nsPrev / 1e9).toFixed(2)}s -> ${(nsCurr / 1e9).toFixed(2)}s`;
}

function printSummary(
	current: BenchmarkResult,
	logicStats: BenchmarkStats[],
	uiStats: BenchmarkStats[],
	prev: BenchmarkResult | null,
) {
	const LabelLogic = "Logic (Avg):";
	const LabelUi = "UI (Total):";
	const maxLabelWidth = Math.max(LabelLogic.length, LabelUi.length);

	// biome-ignore lint/suspicious/noConsole: report
	console.log("\n=== Benchmark Summary ===");
	// biome-ignore lint/suspicious/noConsole: report
	console.log(`Hash: ${current.hash}`);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`${LabelLogic.padEnd(maxLabelWidth)} ${formatDuration(current.logicLatency).padStart(15)} /run   (Hits: ${current.logicHits})`,
	);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`${LabelUi.padEnd(maxLabelWidth)} ${formatDuration(current.uiTime * 1e6).padStart(15)} simulation   (Hits: ${current.uiHits})`,
	);

	if (logicStats.length > 0) {
		// biome-ignore lint/suspicious/noConsole: report
		console.log("\nTop Profile Hits - Logic (Node):");
		// biome-ignore lint/suspicious/noConsole: report
		console.table(logicStats.slice(0, 5));
	}

	if (uiStats.length > 0) {
		// biome-ignore lint/suspicious/noConsole: report
		console.log("\nTop Profile Hits - UI (Browser):");
		// biome-ignore lint/suspicious/noConsole: report
		console.table(uiStats.slice(0, 5));
	}

	if (prev) {
		const prevHash = prev.hash.slice(0, 7);
		const DlLogic = "Logic speedup";
		const DlUi = "UI stress speedup";
		const maxDlWidth = Math.max(DlLogic.length, DlUi.length);

		// biome-ignore lint/suspicious/noConsole: report
		console.log(`\n=== Performance Delta (vs ${prevHash}) ===`);

		if (prev.logicLatency > 0 && current.logicLatency > 0) {
			const logicS = (prev.logicLatency / current.logicLatency).toFixed(
				2,
			);
			// biome-ignore lint/suspicious/noConsole: report
			console.log(
				`${DlLogic.padEnd(maxDlWidth)} : ${logicS.padStart(6)}x  (${formatDurationPair(prev.logicLatency, current.logicLatency)})`,
			);
		}

		if (prev.uiTime > 0 && current.uiTime > 0) {
			const uiS = (prev.uiTime / current.uiTime).toFixed(2);
			// biome-ignore lint/suspicious/noConsole: report
			console.log(
				`${DlUi.padEnd(maxDlWidth)} : ${uiS.padStart(6)}x  (${formatDurationPair(prev.uiTime * 1e6, current.uiTime * 1e6)})`,
			);
		}
	} else {
		// biome-ignore lint/suspicious/noConsole: report
		console.log("\nFirst run or no previous successful baseline found.");
	}

	// biome-ignore lint/suspicious/noConsole: report
	console.log("\nDone.");
}

function main() {
	// biome-ignore lint/suspicious/noConsole: report
	console.log("=== Meld Performance Benchmarking ===");
	runBenchmarks();
}

main();
