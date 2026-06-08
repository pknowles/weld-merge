/**
 * @file collect_coverage.ts
 * @description Runs every coverage-producing test suite, merges the results,
 * and ratchets thresholds. This is the only supported entry point for coverage
 * collection — running the individual steps out of order produces stale data.
 *
 * Usage: npm run coverage
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { cwd, exit, env as processEnv } from "node:process";
import { Report } from "c8";
import {
	type CoverageMap,
	type CoverageMapData,
	createCoverageMap,
} from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";
import { mergeCoverageReportFiles } from "lcov-result-merger";
import {
	ratchetCombinedCoverage,
	ratchetJestCoverage,
} from "./ratchet_coverage.ts";

const root = cwd();
const require = createRequire(import.meta.url);
const JEST_LCOV = join(root, "test-output", "jest", "coverage", "lcov.info");
const VSCODE_LCOV = join(
	root,
	"test-output",
	"coverage",
	"vscode",
	"lcov.info",
);
const RESTORED_TABS_LCOV = join(
	root,
	"test-output",
	"coverage",
	"restored-tabs",
	"lcov.info",
);
const WEBVIEW_BROWSER_LCOV = join(
	root,
	"test-output",
	"coverage",
	"webview-browser",
	"lcov.info",
);
const COMBINED_DIR = join(root, "test-output", "coverage", "combined");
const COMBINED_LCOV = join(COMBINED_DIR, "lcov.info");
const REQUIRED_VSCODE_COVERAGE_FILE = "src/webview/meldWebviewPanel.ts";
const REQUIRED_WEBVIEW_BROWSER_COVERAGE_FILE = "src/webview/ui/App.tsx";
const WEBVIEW_ENTRY = join(root, "out", "webview", "index.js");
const WEBVIEW_ENTRY_MAP = `${WEBVIEW_ENTRY}.map`;
const HIT_LINES_REGEX = /^LH:(\d+)$/m;
const WEBVIEW_COVERAGE_ENV_VAR = "WELD_WEBVIEW_COVERAGE_DIR";

interface Instrumenter {
	instrumentSync(
		code: string,
		filename: string,
		inputSourceMap: unknown,
	): string;
	lastSourceMap(): unknown;
}

interface IstanbulLibInstrument {
	createInstrumenter(options: {
		compact: boolean;
		produceSourceMap: boolean;
	}): Instrumenter;
}

interface SourceMapStore {
	registerMap(filename: string, sourceMap: unknown): void;
	transformCoverage(coverageMap: CoverageMap): Promise<CoverageMap>;
}

interface IstanbulLibSourceMaps {
	createSourceMapStore(): SourceMapStore;
}

const { createInstrumenter } =
	require("istanbul-lib-instrument") as IstanbulLibInstrument;
const { createSourceMapStore } =
	require("istanbul-lib-source-maps") as IstanbulLibSourceMaps;

function log(label: string): void {
	// biome-ignore lint/suspicious/noConsole: script output
	console.log(`\n=== ${label} ===`);
}

function runJestCoverage(): void {
	log("Jest coverage");
	rmSync(JEST_LCOV, { force: true });
	execFileSync("npx", ["jest", "--coverage"], {
		stdio: "inherit",
		cwd: root,
	});
	if (!existsSync(JEST_LCOV)) {
		throw new Error(`Jest did not produce ${JEST_LCOV}`);
	}
}

function buildCoverageBundles(): void {
	log("Coverage bundles");
	execFileSync("npm", ["run", "build:webview"], {
		stdio: "inherit",
		cwd: root,
	});
	execFileSync("npm", ["run", "build:extension"], {
		stdio: "inherit",
		cwd: root,
	});
}

async function runVscodeCoverage(): Promise<void> {
	log("VS Code integration tests");
	rmSync(VSCODE_LCOV, { force: true });

	await runNodeV8Coverage({
		command: ["npx", "tsx", "test/vscode/runTest.ts"],
		reportDir: join(root, "test-output", "coverage", "vscode"),
		rawPrefix: "vscode-raw-",
	});

	if (!existsSync(VSCODE_LCOV)) {
		throw new Error(`c8 did not produce ${VSCODE_LCOV}`);
	}
	assertLcovHasHitLines(
		VSCODE_LCOV,
		REQUIRED_VSCODE_COVERAGE_FILE,
		`VS Code coverage did not include ${REQUIRED_VSCODE_COVERAGE_FILE}. c8 must include out/extension.js so source maps can remap the extension-host bundle back to src/.`,
		`VS Code coverage included ${REQUIRED_VSCODE_COVERAGE_FILE} but recorded 0 covered lines. Extension-host coverage is not being captured.`,
	);
}

async function runRestoredTabsCoverage(): Promise<void> {
	log("Restored-tabs VS Code integration test");
	rmSync(RESTORED_TABS_LCOV, { force: true });

	await runNodeV8Coverage({
		command: ["npx", "tsx", "scripts/test_restored_tabs.ts"],
		reportDir: join(root, "test-output", "coverage", "restored-tabs"),
		rawPrefix: "restored-tabs-raw-",
	});

	if (!existsSync(RESTORED_TABS_LCOV)) {
		throw new Error(`c8 did not produce ${RESTORED_TABS_LCOV}`);
	}
	assertLcovHasHitLines(
		RESTORED_TABS_LCOV,
		REQUIRED_VSCODE_COVERAGE_FILE,
		`Restored-tabs coverage did not include ${REQUIRED_VSCODE_COVERAGE_FILE}.`,
		`Restored-tabs coverage included ${REQUIRED_VSCODE_COVERAGE_FILE} but recorded 0 covered lines.`,
	);
}

async function runNodeV8Coverage(options: {
	command: readonly [string, ...string[]];
	reportDir: string;
	rawPrefix: string;
}): Promise<void> {
	const rawParent = join(root, "test-output", "coverage");
	mkdirSync(rawParent, { recursive: true });
	const rawDir = mkdtempSync(join(rawParent, options.rawPrefix));
	try {
		const { ELECTRON_RUN_AS_NODE: _, ...env } = processEnv;
		const [file, ...args] = options.command;
		execFileSync(file, args, {
			stdio: "inherit",
			cwd: root,
			// biome-ignore lint/style/useNamingConvention: env var name is dictated by Node/V8
			env: { ...env, NODE_V8_COVERAGE: rawDir },
		});

		mkdirSync(options.reportDir, { recursive: true });

		log("c8 LCOV report");
		const report = new Report({
			reporter: ["lcov"],
			reportsDirectory: options.reportDir,
			tempDirectory: rawDir,
			include: ["out/extension.js"],
		});
		await report.run();
	} finally {
		rmSync(rawDir, { recursive: true, force: true });
	}
}

async function runWebviewBrowserCoverage(): Promise<void> {
	log("Browser webview integration tests");
	rmSync(WEBVIEW_BROWSER_LCOV, { force: true });

	const rawParent = join(root, "test-output", "coverage");
	mkdirSync(rawParent, { recursive: true });
	const rawDir = mkdtempSync(join(rawParent, "webview-browser-raw-"));
	try {
		buildInstrumentedWebviewBundle();
		execFileSync(
			"npx",
			[
				"playwright",
				"test",
				"test/webview-integration",
				"--output=test-output/playwright/webview-integration-results",
			],
			{
				stdio: "inherit",
				cwd: root,
				env: { ...processEnv, [WEBVIEW_COVERAGE_ENV_VAR]: rawDir },
			},
		);

		const webviewDir = join(
			root,
			"test-output",
			"coverage",
			"webview-browser",
		);
		mkdirSync(webviewDir, { recursive: true });

		log("Istanbul browser LCOV report");
		await writeIstanbulLcov(rawDir, webviewDir);
	} finally {
		rmSync(rawDir, { recursive: true, force: true });
		execFileSync("npm", ["run", "build:webview"], {
			stdio: "inherit",
			cwd: root,
		});
	}

	if (!existsSync(WEBVIEW_BROWSER_LCOV)) {
		throw new Error(`Istanbul did not produce ${WEBVIEW_BROWSER_LCOV}`);
	}
	assertLcovHasHitLines(
		WEBVIEW_BROWSER_LCOV,
		REQUIRED_WEBVIEW_BROWSER_COVERAGE_FILE,
		`Browser webview coverage did not include ${REQUIRED_WEBVIEW_BROWSER_COVERAGE_FILE}. The webview bundle must be Istanbul-instrumented before running Playwright coverage.`,
		`Browser webview coverage included ${REQUIRED_WEBVIEW_BROWSER_COVERAGE_FILE} but recorded 0 covered lines.`,
	);
}

function buildInstrumentedWebviewBundle(): void {
	log("Instrumented browser webview bundle");
	execFileSync(
		"npx",
		[
			"esbuild",
			"./src/webview/ui/index.tsx",
			"--bundle",
			"--outfile=./out/webview/index.js",
			"--format=iife",
			"--platform=browser",
			"--loader:.ttf=file",
			"--sourcemap",
			'--define:process.env.NODE_ENV="production"',
		],
		{ stdio: "inherit", cwd: root },
	);

	const code = readFileSync(WEBVIEW_ENTRY, "utf8");
	const sourceMap = JSON.parse(
		readFileSync(WEBVIEW_ENTRY_MAP, "utf8"),
	) as unknown;
	const instrumenter = createInstrumenter({
		compact: false,
		produceSourceMap: true,
	});
	const instrumented = instrumenter.instrumentSync(
		code,
		WEBVIEW_ENTRY,
		sourceMap,
	);
	writeFileSync(WEBVIEW_ENTRY, instrumented, "utf8");
	writeFileSync(
		WEBVIEW_ENTRY_MAP,
		JSON.stringify(instrumenter.lastSourceMap()),
		"utf8",
	);
}

async function writeIstanbulLcov(
	rawDir: string,
	reportDir: string,
): Promise<void> {
	const coverageMap = createCoverageMap({});
	for (const fileName of readdirSync(rawDir)) {
		const coverageJson = JSON.parse(
			readFileSync(join(rawDir, fileName), "utf8"),
		) as CoverageMapData;
		coverageMap.merge(coverageJson);
	}
	const sourceMap = JSON.parse(
		readFileSync(WEBVIEW_ENTRY_MAP, "utf8"),
	) as unknown;
	const sourceMapStore = createSourceMapStore();
	sourceMapStore.registerMap(WEBVIEW_ENTRY, sourceMap);
	const transformed = await sourceMapStore.transformCoverage(coverageMap);
	transformed.filter((filePath) =>
		relative(root, filePath).startsWith("src/webview/ui/"),
	);
	const context = createContext({
		dir: reportDir,
		coverageMap: transformed,
	});
	reports.create("lcov").execute(context);
	normalizeLcovPaths(join(reportDir, "lcov.info"));
}

function normalizeLcovPaths(lcovPath: string): void {
	const lcov = readFileSync(lcovPath, "utf8");
	writeFileSync(lcovPath, lcov.replaceAll(`SF:${root}/`, "SF:"), "utf8");
}

function assertLcovHasHitLines(
	lcovPath: string,
	requiredFile: string,
	missingMessage: string,
	zeroHitMessage: string,
): void {
	const lcov = readFileSync(lcovPath, "utf8");
	const record = lcov
		.split("end_of_record")
		.find((entry) => entry.split("\n").includes(`SF:${requiredFile}`));
	if (record === undefined) {
		throw new Error(missingMessage);
	}

	const hitLines = Number(record.match(HIT_LINES_REGEX)?.[1] ?? "0");
	if (hitLines === 0) {
		throw new Error(zeroHitMessage);
	}
}

async function mergeLcov(): Promise<void> {
	log("Merging coverage reports");
	mkdirSync(COMBINED_DIR, { recursive: true });
	const merged = await mergeCoverageReportFiles(
		[JEST_LCOV, VSCODE_LCOV, RESTORED_TABS_LCOV, WEBVIEW_BROWSER_LCOV],
		{
			pattern: "",
		},
	);
	const tmpPath = `${COMBINED_LCOV}.tmp`;
	writeFileSync(tmpPath, merged, "utf8");
	renameSync(tmpPath, COMBINED_LCOV);
	// biome-ignore lint/suspicious/noConsole: script output
	console.log(`Combined LCOV written to ${COMBINED_LCOV}`);
}

async function main(): Promise<void> {
	buildCoverageBundles();
	runJestCoverage();
	await runVscodeCoverage();
	await runRestoredTabsCoverage();
	await runWebviewBrowserCoverage();
	await mergeLcov();

	ratchetJestCoverage();
	ratchetCombinedCoverage();
}

main().catch((err: unknown) => {
	// biome-ignore lint/suspicious/noConsole: script error
	console.error(err instanceof Error ? err.message : String(err));
	exit(1);
});
