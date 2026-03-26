import { execSync } from "node:child_process";
import fs from "node:fs";

export interface BenchmarkResult {
	hash: string;
	timestamp: string;
	logicLatency: number; // Average latency in ns
	logicHits: number;
	logicFunctions: { name: string; hitCount: number }[];
	uiTime: number; // Duration of stress simulation (ms)
	uiHits: number;
	uiFunctions: { name: string; hitCount: number }[];
}

export function saveResult(
	dbPath: string,
	data: {
		logicLatency: number;
		logicHits: number;
		logicFunctions: { name: string; hitCount: number }[];
		uiTime: number;
		uiHits: number;
		uiFunctions: { name: string; hitCount: number }[];
	},
) {
	const hash = execSync("git rev-parse HEAD").toString().trim();
	const result: BenchmarkResult = {
		hash,
		timestamp: new Date().toISOString(),
		...data,
	};

	let db: BenchmarkResult[] = [];
	if (fs.existsSync(dbPath)) {
		db = JSON.parse(fs.readFileSync(dbPath, "utf8")) as BenchmarkResult[];
	}

	db.push(result);
	fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
	return result;
}

export function getPreviousResult(dbPath: string) {
	if (!fs.existsSync(dbPath)) {
		return null;
	}
	const db = JSON.parse(fs.readFileSync(dbPath, "utf8")) as BenchmarkResult[];
	if (db.length < 2) {
		return null;
	}
	// Return the most recent entry (excluding current) that has valid data for either metric
	for (let i = db.length - 2; i >= 0; i--) {
		const entry = db[i];
		if (entry && (entry.logicLatency > 0 || entry.uiTime > 0)) {
			return entry;
		}
	}
	return db.at(-2) ?? null;
}
