// ============================================================================
// BENCHMARK SPECIFICATION — DO NOT REMOVE, REWORD, OR SUMMARISE THIS BLOCK
// ============================================================================
//
// This file exists to measure real performance so that optimisation patches can
// be verified as actually effective. The requirements below are verbatim from
// the product owner and must remain here permanently as the authoritative spec.
// Any agent or developer who edits a test MUST check that the test still
// satisfies the requirement it is listed under.
//
// REQUIREMENTS (verbatim):
//   1. Measure real end-to-end perf for typing into a document without any
//      overhead.  Do this TWICE:
//        1a. Once via Playwright (page.keyboard.type) — goes through the full
//            Monaco model, diff pipeline, highlight and curtain update.
//        1b. Once via direct document modifications (document.execCommand
//            "insertText" inside page.evaluate) — bypasses Playwright's CDP
//            round-trip overhead so we can isolate rendering cost from RPC
//            cost.  NOTE: execCommand does NOT enter Monaco's virtual model,
//            so metrics 2-5 will be zero for this variant; that is expected
//            and intentional — the point is to establish a lower bound on
//            typing speed with no pipeline overhead.
//   2. Measure the time taken to compute the delta of the diff
//      (changeSequence in diffutil.ts → diffTimes telemetry).
//   3. Measure the time taken to update Monaco highlighting
//      (deltaDecorations in CodePane.tsx → highlightJsTimes telemetry).
//   4. Measure the JS time to filter which diff chunks are visible for each
//      curtain instance (useFilteredDiffs in DiffCurtain.tsx →
//      curtainFilterTimes telemetry). NOTE: this is the React/JS filtering
//      step, not the SVG bezier-path drawing — the actual connector rendering
//      happens in the browser graphics pipeline and is not JS-measurable here.
//   5. Measure the time taken for the browser to render the result
//      (rAF after deltaDecorations in CodePane.tsx → fullRenderTimes
//      telemetry).
//
// TELEMETRY GATE:
//   The app only records metrics 2-5 when window.__WELD_PERF_STATS__ exists.
//   That object is injected by the Playwright test immediately before the
//   typing loop and must never be initialised by production app code (to
//   prevent memory leaks in normal usage).
//
// TWO TYPING METHODS — WHY BOTH MATTER:
//   page.keyboard.type  → Playwright CDP round-trip per key (~1-2 ms overhead
//                          per keystroke); reaches Monaco's model; triggers the
//                          full diff/highlight/curtain pipeline; metrics 2-5
//                          are populated.
//   document.execCommand → Runs entirely inside the browser process; no CDP
//                          overhead; does NOT reach Monaco's model; metrics 2-5
//                          will be 0; useful as a lower-bound baseline.
//   Comparing the two isolates how much of the per-keystroke wall time is
//   Monaco/React pipeline cost vs browser-process overhead.
//
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { RESULTS_DIR } from "./config.ts";

interface PerfStats {
	diffTimes: number[];
	highlightJsTimes: number[];
	curtainFilterTimes: number[];
	fullRenderTimes: number[];
}

interface CpuNode {
	id: number;
	callFrame: { functionName: string };
	hitCount: number;
	children?: number[];
}

interface CpuProfile {
	nodes: CpuNode[];
	samples: number[];
	timeDeltas: number[];
	samplingInterval?: number;
}

function generateText(lines: number): string {
	let text = "";
	for (let i = 0; i < lines; i++) {
		text += `Line ${i}: ${Math.random().toString(36).slice(7)}\n`;
	}
	return text;
}

function avg(arr: number[]): number {
	return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function max(arr: number[]): number {
	return arr.length > 0 ? Math.max(...arr) : 0;
}

async function loadDiffInPage(
	page: Page,
	local: string,
	base: string,
	remote: string,
): Promise<void> {
	await page.evaluate(
		({ local, base, remote }) => {
			window.postMessage(
				{
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: local },
							{ label: "Base", content: base },
							{ label: "Remote", content: remote },
						],
						diffs: [[], []],
						config: {},
					},
				},
				"*",
			);
		},
		{ local, base, remote },
	);
}

// Inject the telemetry gate. The app only records metrics 2-5 when this object
// exists. It must never be initialised by production code (memory leak risk).
async function injectPerfStats(page: Page): Promise<void> {
	await page.evaluate(() => {
		// biome-ignore lint/complexity/useLiteralKeys: TypeScript's noPropertyAccessFromIndexSignature requires bracket notation for Record<string,unknown>; dot notation would need a named interface which would require useNamingConvention to accept __UPPER_SNAKE__
		(window as unknown as Record<string, unknown>)["__WELD_PERF_STATS__"] =
			{
				diffTimes: [] as number[],
				highlightJsTimes: [] as number[],
				curtainFilterTimes: [] as number[],
				fullRenderTimes: [] as number[],
			};
	});
}

function readPerfStats(page: Page): Promise<PerfStats> {
	return page.evaluate(() => {
		const w = window as unknown as Record<string, unknown>;
		// biome-ignore lint/complexity/useLiteralKeys: same constraint as injectPerfStats above
		return w["__WELD_PERF_STATS__"] as PerfStats;
	});
}

// Yield two animation frames so React's useEffect has flushed and the browser
// has painted before the next Playwright action fires.
async function yieldBrowserFrames(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() => resolve()),
				),
			),
	);
}

function logPerfStats(
	logPath: string,
	stats: PerfStats,
	uiProfilePath: string,
): void {
	fs.appendFileSync(
		logPath,
		`DIFF_AVG_MS:${avg(stats.diffTimes).toFixed(3)}\n`,
	);
	fs.appendFileSync(
		logPath,
		`DIFF_MAX_MS:${max(stats.diffTimes).toFixed(3)}\n`,
	);
	// 3 CodePane instances per keystroke → avg/max are per-pane values
	fs.appendFileSync(
		logPath,
		`HIGHLIGHT_JS_AVG_MS:${avg(stats.highlightJsTimes).toFixed(3)}\n`,
	);
	fs.appendFileSync(
		logPath,
		`HIGHLIGHT_JS_MAX_MS:${max(stats.highlightJsTimes).toFixed(3)}\n`,
	);
	// 2 curtain instances per keystroke → avg/max are per-instance values
	fs.appendFileSync(
		logPath,
		`CURTAIN_FILTER_AVG_MS:${avg(stats.curtainFilterTimes).toFixed(3)}\n`,
	);
	fs.appendFileSync(
		logPath,
		`CURTAIN_FILTER_MAX_MS:${max(stats.curtainFilterTimes).toFixed(3)}\n`,
	);
	fs.appendFileSync(
		logPath,
		`FULL_RENDER_AVG_MS:${avg(stats.fullRenderTimes).toFixed(3)}\n`,
	);
	fs.appendFileSync(
		logPath,
		`FULL_RENDER_MAX_MS:${max(stats.fullRenderTimes).toFixed(3)}\n`,
	);
	fs.appendFileSync(logPath, `UI_PROFILE:${uiProfilePath}\n`);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tree traversal
function processCpuProfile(
	uiProfilePath: string,
	logPath: string,
	stats: PerfStats,
): void {
	const cpuProfile = JSON.parse(
		fs.readFileSync(uiProfilePath, "utf8"),
	) as CpuProfile;

	const parentMap = new Map<number, number>();
	for (const node of cpuProfile.nodes) {
		for (const childId of node.children ?? []) {
			parentMap.set(childId, node.id);
		}
	}

	const targetFunctions = [
		"changeSequence",
		"useFilteredDiffs",
		"deltaDecorations",
	] as const;
	const targetNodeNames = new Map<number, string>();
	for (const node of cpuProfile.nodes) {
		if (
			(targetFunctions as readonly string[]).includes(
				node.callFrame.functionName,
			)
		) {
			targetNodeNames.set(node.id, node.callFrame.functionName);
		}
	}

	const profileTimesMap = new Map<string, number>(
		targetFunctions.map((name) => [name, 0]),
	);
	const samples = cpuProfile.samples ?? [];
	const timeDeltas = cpuProfile.timeDeltas ?? [];
	for (let i = 0; i < samples.length; i++) {
		// timeDeltas are in microseconds
		const deltaMs = (timeDeltas[i] ?? 100) / 1000;
		let nodeId: number | undefined = samples[i];
		while (nodeId !== undefined) {
			const fn = targetNodeNames.get(nodeId);
			if (fn !== undefined) {
				profileTimesMap.set(
					fn,
					(profileTimesMap.get(fn) ?? 0) + deltaMs,
				);
			}
			nodeId = parentMap.get(nodeId);
		}
	}

	const pTime = (name: string) => (profileTimesMap.get(name) ?? 0).toFixed(3);
	fs.appendFileSync(logPath, `PROFILE_DIFF_MS:${pTime("changeSequence")}\n`);
	fs.appendFileSync(
		logPath,
		`PROFILE_CURTAIN_MS:${pTime("useFilteredDiffs")}\n`,
	);
	fs.appendFileSync(
		logPath,
		`PROFILE_HIGHLIGHT_MS:${pTime("deltaDecorations")}\n`,
	);

	console.log("CPU profile inclusive times (verification):");
	console.log(`  changeSequence:         ${pTime("changeSequence")}ms`);
	console.log(`  useFilteredDiffs:       ${pTime("useFilteredDiffs")}ms`);
	console.log(`  deltaDecorations:       ${pTime("deltaDecorations")}ms`);

	console.log("Per-keystroke telemetry (150 keystrokes on 50k-line doc):");
	console.log(
		`  Differ avg/max (1/keystroke):        ${avg(stats.diffTimes).toFixed(2)}ms / ${max(stats.diffTimes).toFixed(2)}ms`,
	);
	console.log(
		`  Highlight JS avg/max (per pane ×3):  ${avg(stats.highlightJsTimes).toFixed(2)}ms / ${max(stats.highlightJsTimes).toFixed(2)}ms`,
	);
	console.log(
		`  Curtain filter avg/max (per inst ×2): ${avg(stats.curtainFilterTimes).toFixed(2)}ms / ${max(stats.curtainFilterTimes).toFixed(2)}ms`,
	);
	console.log(
		`  Full render avg/max (1/keystroke):   ${avg(stats.fullRenderTimes).toFixed(2)}ms / ${max(stats.fullRenderTimes).toFixed(2)}ms`,
	);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: multiple tests
test.describe("Webview UI Stress Benchmark", () => {
	// SPEC: general smoke / stress test — not tied to a specific numbered
	// requirement. Uses page.keyboard.type on a small (500-line) doc. Does NOT
	// collect granular telemetry — it is a broad check that editing doesn't lock
	// up, not a precise per-metric measurement.
	test("runs 150 random edits on a large document", async ({ page }) => {
		const resultsDir = RESULTS_DIR;
		// Avoid __dirname/import.meta to stay compatible with Playwright's
		// default loader in this project.
		const htmlPath = `file://${path.resolve(resultsDir, "..", "benchmark.html")}`;
		await page.goto(htmlPath);
		await expect(page.locator("#root")).toBeVisible();

		const local = generateText(500);
		const base = generateText(500);
		const remote = generateText(500);

		await loadDiffInPage(page, local, base, remote);
		await expect(page.locator(".monaco-editor").first()).toBeVisible();

		console.log("Starting stress simulation...");
		const client = await page.context().newCDPSession(page);
		await client.send("Profiler.enable");
		await client.send("Profiler.start");

		const start = Date.now();
		for (let i = 0; i < 150; i++) {
			/* biome-ignore lint/performance/noAwaitInLoops: sequential keystrokes required */
			await page.keyboard.type(`Stress Edit ${i}\n`);
			if (i % 10 === 0) {
				await page.mouse.click(100, 100 + (i % 3) * 200);
			}
		}

		const duration = Date.now() - start;
		const { profile } = await client.send("Profiler.stop");
		const uiProfilePath = path.join(resultsDir, "ui_stress.cpuprofile");
		fs.writeFileSync(uiProfilePath, JSON.stringify(profile));
		console.log(`Stress simulation completed in ${duration}ms`);

		fs.appendFileSync(
			path.join(resultsDir, "perf_stats.log"),
			`UI_STRESS:${duration}\n`,
		);
		fs.appendFileSync(
			path.join(resultsDir, "perf_stats.log"),
			`UI_PROFILE:${uiProfilePath}\n`,
		);
	});

	// SPEC REQ 1a + 2 + 3 + 4 + 5 — page.keyboard.type path on a 50,000-line
	// doc. This test satisfies:
	//   Req 1a: end-to-end typing perf via Playwright (CDP path, full Monaco
	//           model).
	//   Req 2:  diffTimes        — changeSequence wall time per keystroke.
	//   Req 3:  highlightJsTimes — deltaDecorations JS cost per keystroke.
	//   Req 4:  curtainFilterTimes — useFilteredDiffs JS filtering cost per curtain instance.
	//   Req 5:  fullRenderTimes  — rAF wall time from input event to paint.
	// The CPU profile (ui_massive_stress.cpuprofile) provides independent
	// inclusive-time verification via processCpuProfile().
	test("runs typing edits on a massive 50,000 line document", async ({
		page,
	}) => {
		// Each of the 150 keystrokes yields two rAF cycles (~32ms each) plus
		// React's render time. 150 * 50ms = 7.5s headroom; set 60s to be safe.
		test.setTimeout(60_000);
		const resultsDir = RESULTS_DIR;
		const htmlPath = `file://${path.resolve(resultsDir, "..", "benchmark.html")}`;
		await page.goto(htmlPath);
		await expect(page.locator("#root")).toBeVisible();

		const massiveText = generateText(100).repeat(500); // 50,000 lines
		await loadDiffInPage(page, massiveText, massiveText, massiveText);

		// Wait for all 3 Monaco editors, click the middle (editable) pane.
		// nth(1) = middle pane (0=left, 2=right).
		const editors = page.locator(".monaco-editor");
		await expect(editors).toHaveCount(3);
		await editors.nth(1).click();

		// Navigate to mid-document for a realistic scroll position.
		await page.keyboard.press("Control+g");
		await page.keyboard.type("25000");
		await page.keyboard.press("Enter");

		const client = await page.context().newCDPSession(page);
		await client.send("Profiler.enable");
		await client.send("Profiler.start");

		await injectPerfStats(page);

		// Type 150 keystrokes via Playwright CDP (Req 1a). Each keystroke is
		// followed by a double rAF yield so React's useEffect has flushed and
		// the browser has painted before the next key fires, giving true
		// per-keystroke measurements.
		const typeAndYield = async () => {
			await page.keyboard.type("X");
			await yieldBrowserFrames(page);
		};
		for (let i = 0; i < 150; i++) {
			/* biome-ignore lint/performance/noAwaitInLoops: sequential per-keystroke timing is the point */
			await typeAndYield();
		}

		const { profile } = await client.send("Profiler.stop");
		const uiProfilePath = path.join(
			resultsDir,
			"ui_massive_stress.cpuprofile",
		);
		fs.writeFileSync(uiProfilePath, JSON.stringify(profile));

		const stats = await readPerfStats(page);
		const logPath = path.join(resultsDir, "perf_stats.log");

		// Fail loudly if Monaco was never reached — silent zero results are
		// worse than a test failure because they look like valid measurements.
		if (stats.diffTimes.length === 0) {
			throw new Error(
				"No diffTimes recorded — Monaco model was not reached. " +
					"Check that the middle editor has focus before the typing loop.",
			);
		}

		logPerfStats(logPath, stats, uiProfilePath);
		processCpuProfile(uiProfilePath, logPath, stats);
	});

	// SPEC REQ 1b — document.execCommand path on a 50,000-line doc.
	// Runs the typing loop entirely inside page.evaluate so there is zero
	// Playwright CDP round-trip overhead per keystroke. execCommand does NOT
	// enter Monaco's virtual model, so metrics 2-5 will be 0 — that is
	// expected and intentional. Only EXECCOMMAND_TOTAL_MS is meaningful here.
	// Comparing it with DIFF_AVG_MS from Req 1a reveals Monaco pipeline cost.
	test("runs typing edits on a massive 50,000 line document via document.execCommand (Req 1b)", async ({
		page,
	}) => {
		// Each keystroke runs a double rAF inside page.evaluate.
		// ~32ms × 150 = 4.8s minimum; 30s is generous headroom.
		test.setTimeout(30_000);
		const resultsDir = RESULTS_DIR;
		const htmlPath = `file://${path.resolve(resultsDir, "..", "benchmark.html")}`;
		await page.goto(htmlPath);
		await expect(page.locator("#root")).toBeVisible();

		const massiveText = generateText(100).repeat(500); // 50,000 lines
		await loadDiffInPage(page, massiveText, massiveText, massiveText);

		const editors = page.locator(".monaco-editor");
		await expect(editors).toHaveCount(3);
		await editors.nth(1).click();

		await page.keyboard.press("Control+g");
		await page.keyboard.type("25000");
		await page.keyboard.press("Enter");

		await injectPerfStats(page);

		const client = await page.context().newCDPSession(page);
		await client.send("Profiler.enable");
		await client.send("Profiler.start");

		// Run entirely inside the browser — zero Playwright CDP cost per
		// keystroke. This is the Req 1b lower-bound baseline.
		const totalMs = await page.evaluate(async () => {
			const yieldToRenderer = () =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => resolve()),
					),
				);
			const typeAndYield = async () => {
				document.execCommand("insertText", false, "X");
				await yieldToRenderer();
			};
			const t0 = performance.now();
			for (let i = 0; i < 150; i++) {
				/* biome-ignore lint/performance/noAwaitInLoops: sequential per-keystroke timing is the point */
				await typeAndYield();
			}
			return performance.now() - t0;
		});

		const { profile } = await client.send("Profiler.stop");
		const uiProfilePath = path.join(
			resultsDir,
			"ui_massive_execcommand.cpuprofile",
		);
		fs.writeFileSync(uiProfilePath, JSON.stringify(profile));

		const logPath = path.join(resultsDir, "perf_stats.log");
		fs.appendFileSync(
			logPath,
			`EXECCOMMAND_TOTAL_MS:${totalMs.toFixed(3)}\n`,
		);
		fs.appendFileSync(
			logPath,
			`EXECCOMMAND_AVG_MS:${(totalMs / 150).toFixed(3)}\n`,
		);
		fs.appendFileSync(logPath, `UI_EXECCOMMAND_PROFILE:${uiProfilePath}\n`);

		console.log(
			"Req 1b — execCommand baseline (150 keystrokes on 50k-line doc):",
		);
		console.log(`  Total wall time:   ${totalMs.toFixed(1)}ms`);
		console.log(`  Avg per keystroke: ${(totalMs / 150).toFixed(2)}ms`);
		console.log(
			"  (metrics 2-5 are 0 by design — execCommand bypasses Monaco)",
		);
	});

	// SPEC: paste stress test — not tied to a specific numbered requirement.
	// Measures how long a 10,000-line clipboard paste takes end-to-end.
	// Uses a synthetic ClipboardEvent dispatched to Monaco's textarea.
	test("handles large content pasting without locking up", async ({
		page,
	}) => {
		const resultsDir = RESULTS_DIR;
		const htmlPath = `file://${path.resolve(resultsDir, "..", "benchmark.html")}`;
		await page.goto(htmlPath);
		await expect(page.locator("#root")).toBeVisible();

		const base = generateText(500);
		await loadDiffInPage(page, base, base, base);
		await expect(page.locator(".monaco-editor").first()).toBeVisible();

		const pasteChunk = generateText(10_000);

		const client = await page.context().newCDPSession(page);
		await client.send("Profiler.enable");
		await client.send("Profiler.start");

		const start = Date.now();

		await page.evaluate((text) => {
			const activeElement = document.activeElement;
			if (activeElement && activeElement.tagName === "TEXTAREA") {
				const dt = new DataTransfer();
				dt.setData("text/plain", text);
				const event = new ClipboardEvent("paste", {
					clipboardData: dt,
					bubbles: true,
					cancelable: true,
				});
				activeElement.dispatchEvent(event);
			}
		}, pasteChunk);

		await page.waitForTimeout(500);

		const duration = Date.now() - start;
		const { profile } = await client.send("Profiler.stop");
		const uiProfilePath = path.join(
			resultsDir,
			"ui_paste_stress.cpuprofile",
		);
		fs.writeFileSync(uiProfilePath, JSON.stringify(profile));

		fs.appendFileSync(
			path.join(resultsDir, "perf_stats.log"),
			`UI_PASTE_STRESS:${duration}\n`,
		);
	});
});
