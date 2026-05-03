import path from "node:path";
import process from "node:process";

export const RESULTS_DIR = path.resolve(
	process.cwd(),
	"test",
	"benchmarking",
	"results",
);
