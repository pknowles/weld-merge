import path from "node:path";
import process from "node:process";

export const RESULTS_DIR = path.resolve(
	process.cwd(),
	"test-output",
	"benchmarking",
	"results",
);

export const BENCHMARK_HTML_URL = `file://${path.resolve(
	process.cwd(),
	"test",
	"benchmarking",
	"benchmark.html",
)}`;
