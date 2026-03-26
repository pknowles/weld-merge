import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Bench } from "tinybench";
import { Differ } from "../../src/matchers/diffutil.ts";
import { Merger } from "../../src/matchers/merge.ts";
import { parseProfile } from "./parser.ts";
import { withProfiling } from "./profiler.ts";

async function runLogicBenchmark() {
	const resultsDir =
		/* biome-ignore lint/complexity/useLiteralKeys: environment variable access */
		process.env["BENCH_RESULTS_DIR"] ||
		path.resolve(process.cwd(), "test", "benchmarking", "results");
	if (!fs.existsSync(resultsDir)) {
		fs.mkdirSync(resultsDir, { recursive: true });
	}

	const profilePath = path.join(resultsDir, "logic.cpuprofile");

	// Increased workload: 50,000 lines instead of 5,000
	const lineCount = 50_000;
	const linesA = Array.from(
		{ length: lineCount },
		(_, i) => `Line ${i} original content`,
	);
	const linesB = Array.from({ length: lineCount }, (_, i) =>
		i % 10 === 0
			? `Line ${i} modified content`
			: `Line ${i} original content`,
	);
	const linesC = Array.from({ length: lineCount }, (_, i) =>
		i % 15 === 0
			? `Line ${i} remote content`
			: `Line ${i} original content`,
	);

	const bench = new Bench();

	bench.add(`Differ.setSequencesIter (${lineCount / 1000}k lines)`, () => {
		const differ = new Differ();
		const iter = differ.setSequencesIter([linesA, linesB, linesC]);
		let s = iter.next();
		while (!s.done) {
			s = iter.next();
		}
	});

	bench.add(`Merger.merge3Files (${lineCount / 1000}k lines)`, () => {
		const merger = new Merger();
		// Initialize the merger with data
		const init = merger.initialize(
			[linesA, linesB, linesC],
			[linesA, linesB, linesC],
		);
		let r1 = init.next();
		while (!r1.done) {
			r1 = init.next();
		}

		// Run the merge
		const merge = merger.merge3Files();
		let r2 = merge.next();
		while (!r2.done) {
			r2 = merge.next();
		}
	});

	// Use our withProfiling utility which correctly handles the CPU profile
	await withProfiling("logic", async () => {
		await bench.run();
		return bench;
	});

	// Move the profile to the correct location
	const tempProfile = path.resolve(process.cwd(), "logic.cpuprofile");
	if (fs.existsSync(tempProfile)) {
		fs.renameSync(tempProfile, profilePath);
	}

	// biome-ignore lint/suspicious/noConsole: benchmark reporter
	console.table(bench.table());

	const stats = parseProfile(profilePath, "meld");
	const tasks = bench.tasks;
	const differTask = tasks.find(
		(t) =>
			t.name === `Differ.setSequencesIter (${lineCount / 1000}k lines)`,
	);
	// tinybench task period is in MILLISECONDS.
	/* biome-ignore lint/suspicious/noExplicitAny: tinybench TaskResult union type issue */
	const latencyNs = ((differTask?.result as any)?.period ?? 0) * 1_000_000;
	// Calculate total hits before slicing for the summary
	const totalHits = stats.reduce((acc, s) => acc + s.selfTime, 0);

	const results = {
		latency: latencyNs,
		totalHits,
		stats: stats.slice(0, 20),
	};

	fs.writeFileSync(
		path.join(resultsDir, "logic_bench_results.json"),
		JSON.stringify(results, null, 2),
	);
}

// biome-ignore lint/suspicious/noConsole: benchmark reporter
runLogicBenchmark().catch(console.error);
