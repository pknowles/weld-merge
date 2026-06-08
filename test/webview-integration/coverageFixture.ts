import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { test as base } from "@playwright/test";

declare global {
	interface Window {
		__coverage__?: unknown;
	}
}

const WEBVIEW_COVERAGE_ENV_VAR = "WELD_WEBVIEW_COVERAGE_DIR";

function safeFileName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 180);
}

export const test = base.extend({
	page: async ({ page }, use, testInfo) => {
		const rawDir = env[WEBVIEW_COVERAGE_ENV_VAR];
		if (rawDir === undefined) {
			await use(page);
			return;
		}

		await use(page);

		const coverage = await page.evaluate(() => window.__coverage__);
		if (coverage === undefined) {
			throw new Error(
				"Browser webview coverage was not found. The webview bundle must be Istanbul-instrumented before running this suite with WELD_WEBVIEW_COVERAGE_DIR.",
			);
		}

		mkdirSync(rawDir, { recursive: true });
		writeFileSync(
			join(
				rawDir,
				`coverage-${testInfo.workerIndex}-${safeFileName(testInfo.titlePath.join("-"))}.json`,
			),
			JSON.stringify(coverage),
			"utf8",
		);
	},
});
