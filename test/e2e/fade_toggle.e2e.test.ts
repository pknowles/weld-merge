import path from "node:path";
import process from "node:process";
import { expect, type Page, test } from "@playwright/test";

const loadInitialDiff = async (
	page: Page,
	config: { baseCompareHighlighting: boolean },
) => {
	const htmlPath = `file://${path.resolve(process.cwd(), "test", "benchmarking", "benchmark.html")}`;
	await page.goto(htmlPath);
	await expect(page.locator("#root")).toBeVisible();

	const local = "LOCAL\nKEEP";
	const merged = "MERGED\nKEEP";
	const remote = "REMOTE\nKEEP";

	await page.evaluate(
		({ l, m, r, c }) => {
			window.postMessage(
				{
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: l },
							{ label: "Merged", content: m },
							{ label: "Remote", content: r },
						],
						diffs: [
							[
								{
									tag: "replace",
									startA: 0,
									endA: 1,
									startB: 0,
									endB: 1,
								},
							], // Local->Merged
							[
								{
									tag: "replace",
									startA: 0,
									endA: 1,
									startB: 0,
									endB: 1,
								},
							], // Merged->Remote
						],
						config: c,
					},
					lastExternalChangeVersion: 1,
				},
				"*",
			);
		},
		{ l: local, m: merged, r: remote, c: config },
	);

	// Wait for Monaco editors to appear
	await expect(page.locator(".monaco-editor").first()).toBeVisible();
};

const loadBaseDiff = async (page: Page, side: "left" | "right") => {
	await page.evaluate(
		({ s }) => {
			window.postMessage(
				{
					command: "loadBaseDiff",
					data: {
						side: s,
						file: { label: `Base (${s})`, content: "BASE\nKEEP" },
						diffs: [
							{
								tag: "replace",
								startA: 0,
								endA: 1,
								startB: 0,
								endB: 1,
							},
						],
					},
				},
				"*",
			);
		},
		{ s: side },
	);
};

const updateConfig = async (
	page: Page,
	config: { baseCompareHighlighting: boolean },
) => {
	await page.evaluate(
		({ c }) => {
			window.postMessage(
				{
					command: "updateConfig",
					config: c,
				},
				"*",
			);
		},
		{ c: config },
	);
};

const getVisibleMasks = async (page: Page) => {
	const diffViews = page.locator(".diff-view");
	const count = await diffViews.count();
	const masks: string[] = await Promise.all(
		Array.from({ length: count }).map(async (_, i) => {
			const curtain = diffViews.nth(i);
			const container = curtain.locator(".diff-container").first();
			try {
				const attr = await container.getAttribute("mask", {
					timeout: 100,
				});
				if (!attr) {
					return "NONE";
				}
				if (attr.includes("-left")) {
					return "LEFT";
				}
				if (attr.includes("-right")) {
					return "RIGHT";
				}
				if (attr.includes("-both")) {
					return "BOTH";
				}
				return "UNKNOWN";
			} catch (e) {
				if (e instanceof Error && !e.message.includes("Timeout")) {
					throw e;
				}
				return "NONE";
			}
		}),
	);
	return masks;
};

const expectMasks = async (page: Page, expected: string[]) => {
	await expect
		.poll(async () => await getVisibleMasks(page), { timeout: 5000 })
		.toEqual(expected);
};

test.describe("Diff Curtain Fade Masks", () => {
	test("UC1: Standard 3-way merge", async ({ page }) => {
		await loadInitialDiff(page, { baseCompareHighlighting: false });
		await expectMasks(page, ["NONE", "NONE"]);
	});

	test("UC2: Left base open (highlight OFF)", async ({ page }) => {
		await loadInitialDiff(page, { baseCompareHighlighting: false });
		await loadBaseDiff(page, "left");
		await expectMasks(page, ["RIGHT", "NONE", "NONE"]);
	});

	test("UC3: Right base open (highlight OFF)", async ({ page }) => {
		await loadInitialDiff(page, { baseCompareHighlighting: false });
		await loadBaseDiff(page, "right");
		await expectMasks(page, ["NONE", "NONE", "LEFT"]);
	});

	test("UC4, UC5, UC6: Both bases open and toggle highlight", async ({
		page,
	}) => {
		await loadInitialDiff(page, { baseCompareHighlighting: false });
		await loadBaseDiff(page, "left");
		await loadBaseDiff(page, "right");

		// UC4: Both open, highlight OFF
		await expectMasks(page, ["RIGHT", "NONE", "NONE", "LEFT"]);

		// UC5: Both open, highlight ON
		await updateConfig(page, { baseCompareHighlighting: true });
		await expectMasks(page, ["NONE", "LEFT", "RIGHT", "NONE"]);

		// UC6: Both open, highlight OFF
		await updateConfig(page, { baseCompareHighlighting: false });
		await expectMasks(page, ["RIGHT", "NONE", "NONE", "LEFT"]);
	});

	test("EC1: Animation during base pane open", async ({ page }) => {
		await loadInitialDiff(page, { baseCompareHighlighting: false });
		// We expect the mask to be there immediately upon DOM appearance
		await loadBaseDiff(page, "left");

		// Instead of polling, fetch once quickly after setting up to catch
		// intermediate state if the mask was incorrectly deferred
		await page.waitForSelector(".diff-view", { state: "attached" });
		const visible = await getVisibleMasks(page);
		expect(visible).toEqual(["RIGHT", "NONE", "NONE"]);

		// Wait for animation to finish to confirm it stays
		await page.waitForTimeout(500);
		await expectMasks(page, ["RIGHT", "NONE", "NONE"]);
	});

	test("EC2: Animation during base pane close (fade persistence)", async ({
		page,
	}) => {
		await loadInitialDiff(page, { baseCompareHighlighting: true });
		await loadBaseDiff(page, "left");
		await expectMasks(page, ["NONE", "LEFT", "NONE"]);

		// Close the left base pane using the UI toggle button
		await page.click('[data-testid="toggle-base-left"]');

		// Check mask MID-ANIMATION. The pane takes 430ms to close.
		await page.waitForTimeout(100);

		// Curtain 1 MUST still have LEFT fade because the base pane is still
		// visually present (animating out). The bridge curtain (idx=0) also
		// persists during the animation.
		const midMasks = await getVisibleMasks(page);
		expect(midMasks).toEqual(["NONE", "LEFT", "NONE"]);

		// Wait for animation to finish
		await page.waitForTimeout(400);

		// Now the pane is completely gone and unmounted
		await expectMasks(page, ["NONE", "NONE"]);
	});

	test("EC3: Only one base pane open with highlight ON", async ({ page }) => {
		await loadInitialDiff(page, { baseCompareHighlighting: true });
		await loadBaseDiff(page, "left");
		await expectMasks(page, ["NONE", "LEFT", "NONE"]);

		// Close left pane via toggle button, wait for animation to finish
		await page.click('[data-testid="toggle-base-left"]');
		await page.waitForTimeout(500);
		await expectMasks(page, ["NONE", "NONE"]);

		// Now open right base
		await loadBaseDiff(page, "right");
		await expectMasks(page, ["NONE", "RIGHT", "NONE"]);
	});

	test("EC4: Highlight ON but no base panes open", async ({ page }) => {
		await loadInitialDiff(page, { baseCompareHighlighting: true });
		await expectMasks(page, ["NONE", "NONE"]);
	});
});
