import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { expect, test } from "@playwright/test";

test.describe("Webview UI Stress Benchmark", () => {
	test("runs 150 random edits on a large document", async ({ page }) => {
		/* biome-ignore lint/complexity/useLiteralKeys: environment variable access */
		const resultsDir = process.env["BENCH_RESULTS_DIR"] || process.cwd();
		// Avoid __dirname/import.meta to stay compatible with Playwright's default loader in this project
		const htmlPath = `file://${path.resolve(process.cwd(), "test", "benchmarking", "benchmark.html")}`;
		await page.goto(htmlPath);

		// Wait for React to load
		await expect(page.locator("#root")).toBeVisible();

		const generateText = (lines: number) => {
			let text = "";
			for (let i = 0; i < lines; i++) {
				text += `Line ${i}: ${Math.random().toString(36).substring(7)}\n`;
			}
			return text;
		};

		const local = generateText(500);
		const base = generateText(500);
		const remote = generateText(500);

		// Initialize the app with data
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
							diffs: [
								[], // Let the app calculate diffs
								[],
							],
							config: {
								debounceDelay: 0, // For benchmarking responsiveness
							},
						},
					},
					"*",
				);
			},
			{ local, base, remote },
		);

		// Wait for Monaco editors to appear
		await expect(page.locator(".monaco-editor").first()).toBeVisible();

		console.log("Starting stress simulation...");
		const client = await page.context().newCDPSession(page);
		await client.send("Profiler.enable");
		await client.send("Profiler.start");

		const start = Date.now();

		for (let i = 0; i < 150; i++) {
			/* biome-ignore lint/performance/noAwaitInLoops: stress test simulation */
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

		// Output result for database
		fs.appendFileSync(
			path.join(resultsDir, "perf_stats.log"),
			`UI_STRESS:${duration}\n`,
		);
		fs.appendFileSync(
			path.join(resultsDir, "perf_stats.log"),
			`UI_PROFILE:${uiProfilePath}\n`,
		);
	});
});
