import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./config.ts";
import {
	type BenchmarkResult,
	getPreviousResult,
	saveResult,
} from "./database.ts";
import { parseProfile } from "./parser.ts";

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

interface PerfStatsData {
	uiStressMs: number;
	diffAvgMs: number;
	diffMaxMs: number;
	fullRenderAvgMs: number;
	fullRenderMaxMs: number;
	execCommandAvgMs: number;
	profileDiffMs: number;
	profileHighlightMs: number;
	profileCurtainMs: number;
}

function runBenchmarks() {
	const resultsDir = RESULTS_DIR;
	if (!fs.existsSync(resultsDir)) {
		fs.mkdirSync(resultsDir, { recursive: true });
	}

	const dbPath = path.join(resultsDir, "benchmark_results.json");
	const prev = getPreviousResult(dbPath);

	const logicResults = runLogicBenchmark(resultsDir);
	runUIStressTest(resultsDir);

	const perfStatsPath = path.join(resultsDir, "perf_stats.log");
	const perf = parsePerfStatsLog(perfStatsPath);

	const uiProfilePath = path.join(resultsDir, "ui_stress.cpuprofile");
	const uiStats = parseProfile(uiProfilePath, "meld") as BenchmarkStats[];
	const uiHits = uiStats.reduce((acc, s) => acc + s.selfTime, 0);

	const current = saveResult(dbPath, {
		logicLatency: logicResults.latency,
		logicHits: logicResults.totalHits,
		logicFunctions: logicResults.stats,
		uiTime: perf.uiStressMs,
		uiHits,
		uiFunctions: uiStats.slice(0, 20),
		diffAvgMs: perf.diffAvgMs,
		diffMaxMs: perf.diffMaxMs,
		fullRenderAvgMs: perf.fullRenderAvgMs,
		fullRenderMaxMs: perf.fullRenderMaxMs,
		execCommandAvgMs: perf.execCommandAvgMs,
		profileDiffMs: perf.profileDiffMs,
		profileHighlightMs: perf.profileHighlightMs,
		profileCurtainMs: perf.profileCurtainMs,
	});

	printSummary(current, prev ?? null);
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
		// Build a non-minified dev bundle so function names are preserved in
		// the .cpuprofile and the in-browser telemetry gate (__WELD_PERF_STATS__)
		// can record correctly without minification mangling.
		// biome-ignore lint/suspicious/noConsole: report
		console.log(
			"  Building dev webview bundle (preserves function names)...",
		);
		execSync("npm run build:webview:dev", { stdio: "inherit" });
		execSync("npx playwright test test/benchmarking/ui_stress.test.ts", {
			stdio: "inherit",
		});
	} catch (e) {
		// biome-ignore lint/suspicious/noConsole: report
		console.error("UI stress test failed:", e);
	} finally {
		// Restore the production bundle so the extension is not left in a dev state.
		// biome-ignore lint/suspicious/noConsole: report
		console.log("  Restoring production webview bundle...");
		execSync("npm run build:webview", { stdio: "inherit" });
	}
}

function parsePerfStatsLog(logPath: string): PerfStatsData {
	const raw: Record<string, number> = {};
	if (fs.existsSync(logPath)) {
		for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
			const sep = line.indexOf(":");
			if (sep < 0) {
				continue;
			}
			const val = Number(line.slice(sep + 1));
			if (!Number.isNaN(val)) {
				raw[line.slice(0, sep)] = val;
			}
		}
	}
	const num = (key: string) => raw[key] ?? 0;
	return {
		uiStressMs: num("UI_STRESS"),
		diffAvgMs: num("DIFF_AVG_MS"),
		diffMaxMs: num("DIFF_MAX_MS"),
		fullRenderAvgMs: num("FULL_RENDER_AVG_MS"),
		fullRenderMaxMs: num("FULL_RENDER_MAX_MS"),
		execCommandAvgMs: num("EXECCOMMAND_AVG_MS"),
		profileDiffMs: num("PROFILE_DIFF_MS"),
		profileHighlightMs: num("PROFILE_HIGHLIGHT_MS"),
		profileCurtainMs: num("PROFILE_CURTAIN_MS"),
	};
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

// Format a prev->current pair where values are already in milliseconds.
function fmtMsPair(prevMs: number, currMs: number): string {
	return `${prevMs.toFixed(2)}ms -> ${currMs.toFixed(2)}ms`;
}

function printTypingPipeline(current: BenchmarkResult): void {
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		"\nTyping pipeline — keyboard.type, 50k-line doc, 150 keystrokes:",
	);
	const fr = current.fullRenderAvgMs;
	if (!fr) {
		// biome-ignore lint/suspicious/noConsole: report
		console.log("  (no data — run the full benchmark to populate)");
		return;
	}
	const p = (n: number) => n.toFixed(1).padStart(5);
	const frMax = current.fullRenderMaxMs ?? 0;
	const diffAvg = current.diffAvgMs ?? 0;
	const diffMax = current.diffMaxMs ?? 0;
	const floor = current.execCommandAvgMs ?? 0;
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`  Full render  avg/max: ${p(fr)} / ${p(frMax)} ms` +
			"  ← keystroke-to-paint proxy",
	);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(`  Diff compute avg/max: ${p(diffAvg)} / ${p(diffMax)} ms`);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`  rAF floor (execCommand): ${p(floor)} ms avg  ← minimum possible`,
	);
}

function printDeltaSection(
	current: BenchmarkResult,
	prev: BenchmarkResult,
): void {
	const prevHash = prev.hash.slice(0, 7);
	const LFull = "Full render avg";
	const LDiff = "Diff avg";
	const LLogic = "Logic latency";
	const LSmoke = "Smoke stress";
	const w = Math.max(
		LFull.length,
		LDiff.length,
		LLogic.length,
		LSmoke.length,
	);

	// biome-ignore lint/suspicious/noConsole: report
	console.log(`\n=== Delta vs ${prevHash} ===`);

	const prevFr = prev.fullRenderAvgMs ?? 0;
	const currFr = current.fullRenderAvgMs ?? 0;
	if (prevFr > 0 && currFr > 0) {
		const s = (prevFr / currFr).toFixed(2);
		// biome-ignore lint/suspicious/noConsole: report
		console.log(
			`${LFull.padEnd(w)} : ${s.padStart(6)}x  (${fmtMsPair(prevFr, currFr)})`,
		);
	}

	const prevDiff = prev.diffAvgMs ?? 0;
	const currDiff = current.diffAvgMs ?? 0;
	if (prevDiff > 0 && currDiff > 0) {
		const s = (prevDiff / currDiff).toFixed(2);
		// biome-ignore lint/suspicious/noConsole: report
		console.log(
			`${LDiff.padEnd(w)} : ${s.padStart(6)}x  (${fmtMsPair(prevDiff, currDiff)})`,
		);
	}

	if (prev.logicLatency > 0 && current.logicLatency > 0) {
		const s = (prev.logicLatency / current.logicLatency).toFixed(2);
		// biome-ignore lint/suspicious/noConsole: report
		console.log(
			`${LLogic.padEnd(w)} : ${s.padStart(6)}x` +
				`  (${formatDurationPair(prev.logicLatency, current.logicLatency)})`,
		);
	}

	if (prev.uiTime > 0 && current.uiTime > 0) {
		const s = (prev.uiTime / current.uiTime).toFixed(2);
		// biome-ignore lint/suspicious/noConsole: report
		console.log(
			`${LSmoke.padEnd(w)} : ${s.padStart(6)}x` +
				`  (${formatDurationPair(prev.uiTime * 1e6, current.uiTime * 1e6)})`,
		);
	}
}

function printProfileSection(current: BenchmarkResult): void {
	const diff = current.profileDiffMs ?? 0;
	const hl = current.profileHighlightMs ?? 0;
	const curtain = current.profileCurtainMs ?? 0;
	if (diff === 0 && hl === 0 && curtain === 0) {
		return;
	}
	// biome-ignore lint/suspicious/noConsole: report
	console.log("\nCPU profile — inclusive time, 150 keystrokes:");
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`  changeSequence:   ${diff.toFixed(1).padStart(7)} ms total` +
			`  (${(diff / 150).toFixed(2)} ms/keystroke)`,
	);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`  deltaDecorations: ${hl.toFixed(1).padStart(7)} ms total` +
			`  (${(hl / 450).toFixed(2)} ms/call, ×3 panes)`,
	);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`  useFilteredDiffs: ${curtain.toFixed(1).padStart(7)} ms total` +
			`  (${(curtain / 300).toFixed(2)} ms/call, ×2 curtains)`,
	);
}

function printSummary(
	current: BenchmarkResult,
	prev: BenchmarkResult | null,
): void {
	// biome-ignore lint/suspicious/noConsole: report
	console.log("\n=== Benchmark Summary ===");
	// biome-ignore lint/suspicious/noConsole: report
	console.log(`Hash: ${current.hash}`);

	printTypingPipeline(current);
	printProfileSection(current);

	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`\nLogic latency (headless): ${formatDuration(current.logicLatency)} avg`,
	);
	// biome-ignore lint/suspicious/noConsole: report
	console.log(
		`Smoke stress  (500 lines): ${formatDuration(current.uiTime * 1e6)} total`,
	);

	if (prev) {
		printDeltaSection(current, prev);
	} else {
		// biome-ignore lint/suspicious/noConsole: report
		console.log("\nFirst run — no previous baseline to compare.");
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
