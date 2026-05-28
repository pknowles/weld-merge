import path from "node:path";
import process from "node:process";
import { expect, type Page, test } from "@playwright/test";

const htmlPath = () =>
	`file://${path.resolve(process.cwd(), "test", "benchmarking", "benchmark.html")}`;

const LINE_NUMBER_REGEX = / line (\d+)/;
const TEST_LINE_COUNT = 1000;

const numberedLines = (prefix: string, count: number) =>
	Array.from(
		{ length: count },
		(_, i) => `${prefix} line ${String(i + 1).padStart(4, "0")}`,
	).join("\n");

type BaseSide = "left" | "right";

interface TestDiffChunk {
	tag: "replace";
	startA: number;
	endA: number;
	startB: number;
	endB: number;
}

interface TestData {
	local: string;
	merged: string;
	remote: string;
	localToMergedDiffs: TestDiffChunk[];
	mergedToRemoteDiffs: TestDiffChunk[];
}

interface RightBaseOpenFrame {
	elapsedMs: number;
	editorCount: number;
	firstLine: string | null;
	marginRight: string;
	existingPanes: [ExistingPaneFrame, ExistingPaneFrame, ExistingPaneFrame];
	width: number;
}

interface ExistingPaneFrame {
	firstLine: string | null;
	width: number;
}

interface ExistingPaneSnapshot {
	local: string;
	merged: string;
	remote: string;
}

const changedLineNumbers = (start: number, end: number) =>
	new Set(Array.from({ length: end - start + 1 }, (_, i) => start + i));

const mergeLineSets = (sets: Set<number>[]) => {
	const merged = new Set<number>();
	for (const set of sets) {
		for (const lineNumber of set) {
			merged.add(lineNumber);
		}
	}
	return merged;
};

const linesWithChanges = (prefix: string, changedLines: Set<number>) =>
	Array.from({ length: TEST_LINE_COUNT }, (_, i) => {
		const lineNumber = i + 1;
		const base = `${prefix} line ${String(lineNumber).padStart(4, "0")}`;
		return changedLines.has(lineNumber) ? `${base} changed` : base;
	}).join("\n");

const diffChunksForRanges = (ranges: [number, number][]) =>
	ranges.map(
		([startLine, endLine]): TestDiffChunk => ({
			tag: "replace",
			startA: startLine - 1,
			endA: endLine,
			startB: startLine - 1,
			endB: endLine,
		}),
	);

const createInitialTestData = (): TestData => {
	const localRanges: [number, number][] = [
		[80, 85],
		[320, 330],
		[610, 615],
	];
	const remoteRanges: [number, number][] = [
		[120, 125],
		[450, 460],
		[760, 765],
	];
	const localChangedLines = mergeLineSets(
		localRanges.map(([start, end]) => changedLineNumbers(start, end)),
	);
	const remoteChangedLines = mergeLineSets(
		remoteRanges.map(([start, end]) => changedLineNumbers(start, end)),
	);

	return {
		local: linesWithChanges("local", localChangedLines),
		merged: numberedLines("merged", TEST_LINE_COUNT),
		remote: linesWithChanges("remote", remoteChangedLines),
		localToMergedDiffs: diffChunksForRanges(localRanges),
		mergedToRemoteDiffs: diffChunksForRanges(remoteRanges),
	};
};

const loadInitialDiff = async (page: Page) => {
	await page.goto(htmlPath());
	await expect(page.locator("#root")).toBeVisible();
	const testData = createInitialTestData();

	await page.evaluate(
		({
			local,
			localToMergedDiffs,
			merged,
			mergedToRemoteDiffs,
			remote,
		}) => {
			window.postMessage(
				{
					command: "loadDiff",
					data: {
						files: [
							{ label: "Local", content: local },
							{ label: "Merged", content: merged },
							{ label: "Remote", content: remote },
						],
						diffs: [localToMergedDiffs, mergedToRemoteDiffs],
						isConflicted: true,
						lastExternalChangeVersion: 1,
					},
				},
				"*",
			);
		},
		testData,
	);

	await expect(page.locator(".monaco-editor")).toHaveCount(3);
};

const loadBaseDiff = async (page: Page, side: BaseSide) => {
	await page.evaluate(
		({ base, side }) => {
			window.postMessage(
				{
					command: "loadBaseDiff",
					data: {
						side,
						file: { label: `Base (${side})`, content: base },
						diffs: [],
					},
				},
				"*",
			);
		},
		{ base: numberedLines(`base ${side}`, TEST_LINE_COUNT), side },
	);

	await expect(page.locator(".monaco-editor")).toHaveCount(4);
};

const loadRightBaseDiff = async (page: Page) => {
	await loadBaseDiff(page, "right");
};

const visibleLinesInPane = async (page: Page, paneIndex: number) =>
	page
		.locator(".monaco-editor")
		.nth(paneIndex)
		.locator(".view-line")
		.evaluateAll((lines) =>
			lines
				.map((line) =>
					(line.textContent ?? "").replace(/\s+/g, " ").trim(),
				)
				.filter((text) => text.length > 0),
		);

const paneContainsLine = async (
	page: Page,
	paneIndex: number,
	expectedLine: string,
) => {
	const visibleLines = await visibleLinesInPane(page, paneIndex);
	return visibleLines.some((line) => line.includes(expectedLine));
};

const firstVisibleLineInPane = async (page: Page, paneIndex: number) => {
	const visibleLines = await visibleLinesInPane(page, paneIndex);
	const firstLine = visibleLines[0];
	if (!firstLine) {
		throw new Error(`Monaco pane ${paneIndex} has no visible lines`);
	}
	return firstLine;
};

const lineNumberFromText = (line: string) => {
	const match = LINE_NUMBER_REGEX.exec(line);
	if (!match) {
		throw new Error(`Cannot parse line number from: ${line}`);
	}
	const lineDigits = match[1];
	if (!lineDigits) {
		throw new Error(`Missing line number in: ${line}`);
	}
	const lineNumber = Number.parseInt(lineDigits, 10);
	if (Number.isNaN(lineNumber)) {
		throw new Error(`Invalid line number in: ${line}`);
	}
	return lineNumber;
};

const scrollPaneUntilLineVisible = async (
	page: Page,
	paneIndex: number,
	expectedLine: string,
) => {
	const editor = page.locator(".monaco-editor").nth(paneIndex);
	await editor.click();
	const box = await editor.boundingBox();
	if (!box) {
		throw new Error(`Monaco pane ${paneIndex} has no bounding box`);
	}
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

	const scrollUntilVisible = async (
		remainingAttempts: number,
	): Promise<void> => {
		if (await paneContainsLine(page, paneIndex, expectedLine)) {
			return;
		}
		if (remainingAttempts === 0) {
			throw new Error(
				`Expected ${expectedLine} to become visible in pane ${paneIndex}`,
			);
		}
		await page.mouse.wheel(0, 2500);
		await page.waitForTimeout(10);
		await scrollUntilVisible(remainingAttempts - 1);
	};

	await scrollUntilVisible(320);
};

const existingPaneSnapshot = async (
	page: Page,
): Promise<ExistingPaneSnapshot> => ({
	local: await firstVisibleLineInPane(page, 0),
	merged: await firstVisibleLineInPane(page, 1),
	remote: await firstVisibleLineInPane(page, 2),
});

const sampleRightBaseOpenFrames = async (page: Page) =>
	page.evaluate<RightBaseOpenFrame[], string>(
		(base) => {
			const normalize = (text: string | null) =>
				(text ?? "").replace(/\s+/g, " ").trim();
			return new Promise<RightBaseOpenFrame[]>((resolve) => {
				const frames: RightBaseOpenFrame[] = [];
				const start = performance.now();
				window.postMessage(
					{
						command: "loadBaseDiff",
						data: {
							side: "right",
							file: { label: "Base (right)", content: base },
							diffs: [],
						},
					},
					"*",
				);

				const sample = () => {
					const existingPanes = Array.from(
						document.querySelectorAll(".monaco-editor"),
					)
						.slice(0, 3)
						.map((editor) => ({
							firstLine:
								normalize(
									editor.querySelector(".view-line")
										?.textContent ?? null,
								) || null,
							width: editor.getBoundingClientRect().width,
						})) as [
						ExistingPaneFrame,
						ExistingPaneFrame,
						ExistingPaneFrame,
					];
					const rightColumn =
						document.querySelector("#col-base-right");
					const firstLine = normalize(
						rightColumn?.querySelector(".view-line")?.textContent ??
							null,
					);
					const rect = rightColumn?.getBoundingClientRect();
					const style = rightColumn
						? window.getComputedStyle(rightColumn)
						: null;
					frames.push({
						elapsedMs: performance.now() - start,
						editorCount:
							document.querySelectorAll(".monaco-editor").length,
						firstLine: firstLine.length > 0 ? firstLine : null,
						marginRight: style?.marginRight ?? "",
						existingPanes,
						width: rect?.width ?? 0,
					});
					if (performance.now() - start < 700) {
						requestAnimationFrame(sample);
						return;
					}
					resolve(frames);
				};
				requestAnimationFrame(sample);
			});
		},
		numberedLines("base right", TEST_LINE_COUNT),
	);

const existingPaneDriftFrames = (
	frames: RightBaseOpenFrame[],
	expected: ExistingPaneSnapshot,
) => {
	const expectedLines = [expected.local, expected.merged, expected.remote];
	return frames.filter((frame) =>
		frame.existingPanes.some(
			(pane, index) => pane.firstLine !== expectedLines[index],
		),
	);
};

interface ScrollCounter {
	scrollable: HTMLElement;
	fireCount: number;
}

// Extend the browser Window so page.evaluate callbacks can access the
// test-state property without casting to any.
declare global {
	interface Window {
		__scrollCounters: ScrollCounter[];
	}
}

interface ScrollCounterState {
	fireCount: number;
	scrollTop: number;
}

// Attach a scroll-fire counter to each stable pane's .monaco-scrollable-element
// BEFORE the initial scroll, so later reads can prove the hook actually fires.
// Throws if any element is missing so failures are explicit.
const attachScrollCounters = async (page: Page, domIndices: number[]) => {
	await page.evaluate((indices) => {
		window.__scrollCounters = indices.map((i: number) => {
			const editor = document.querySelectorAll(".monaco-editor")[i];
			if (!editor) {
				throw new Error(`.monaco-editor[${i}] not found`);
			}
			const scrollable = editor.querySelector(
				".monaco-scrollable-element",
			) as HTMLElement | null;
			if (!scrollable) {
				throw new Error(
					`.monaco-scrollable-element not found in .monaco-editor[${i}]`,
				);
			}
			const counter: ScrollCounter = { scrollable, fireCount: 0 };
			scrollable.addEventListener(
				"scroll",
				() => {
					counter.fireCount++;
				},
				{ passive: true },
			);
			return counter;
		});
	}, domIndices);
};

const readScrollCounters = (page: Page): Promise<ScrollCounterState[]> =>
	page.evaluate(() =>
		window.__scrollCounters.map((s) => ({
			fireCount: s.fireCount,
			scrollTop: s.scrollable.scrollTop,
		})),
	);

// Clicks the close button, waits for the CSS transitionend on the column, then
// returns which panes had a vertical scrollTop change during the animation.
const watchCloseAndDetectVerticalScroll = (
	page: Page,
	columnId: string,
	toggleTestId: string,
): Promise<{ shifted: boolean[]; transitionEndFired: boolean }> =>
	page.evaluate(
		({ columnId, toggleTestId }) =>
			new Promise<{ shifted: boolean[]; transitionEndFired: boolean }>(
				(resolve) => {
					const counters = window.__scrollCounters;

					// Co-locate initial scrollTop with handler so no parallel
					// array indexing is needed.
					const monitored = counters.map((c) => {
						const initialTop = c.scrollable.scrollTop;
						const state = { shifted: false };
						const handler = () => {
							if (c.scrollable.scrollTop !== initialTop) {
								state.shifted = true;
							}
						};
						c.scrollable.addEventListener("scroll", handler, {
							passive: true,
						});
						return { scrollable: c.scrollable, handler, state };
					});

					const col = document.querySelector(`#${columnId}`);
					if (!col) {
						throw new Error(`#${columnId} not found`);
					}
					col.addEventListener(
						"transitionend",
						() => {
							for (const { scrollable, handler } of monitored) {
								scrollable.removeEventListener(
									"scroll",
									handler,
								);
							}
							requestAnimationFrame(() => {
								resolve({
									shifted: monitored.map(
										({ state }) => state.shifted,
									),
									transitionEndFired: true,
								});
							});
						},
						{ once: true },
					);

					const btn = document.querySelector(
						`[data-testid="${toggleTestId}"]`,
					) as HTMLElement | null;
					if (!btn) {
						throw new Error(
							`[data-testid="${toggleTestId}"] not found`,
						);
					}
					btn.click();
				},
			),
		{ columnId, toggleTestId },
	);

// When the right base pane is open the DOM order is:
//   local(0), merged(1), remote(2), right-base(3)
// When the left base pane is open the DOM order is:
//   left-base(0), local(1), merged(2), remote(3)
const BASE_CLOSE_CASES = [
	{
		side: "right" as BaseSide,
		stableDomIndices: [0, 1, 2] as number[],
		remoteDomIndex: 2,
		columnId: "col-base-right",
		toggleTestId: "toggle-base-right",
	},
	{
		side: "left" as BaseSide,
		stableDomIndices: [1, 2, 3] as number[],
		remoteDomIndex: 3,
		columnId: "col-base-left",
		toggleTestId: "toggle-base-left",
	},
];

test.describe("Base pane close scroll preservation", () => {
	for (const {
		side,
		stableDomIndices,
		remoteDomIndex,
		columnId,
		toggleTestId,
	} of BASE_CLOSE_CASES) {
		test(`closing the ${side} base pane does not vertically scroll any remaining pane`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: 1400, height: 800 });
			await loadInitialDiff(page);
			await loadBaseDiff(page, side);

			// Hook scroll events BEFORE the initial scroll so we can verify
			// the hooks actually fire (guards against false negatives).
			await attachScrollCounters(page, stableDomIndices);
			await scrollPaneUntilLineVisible(
				page,
				remoteDomIndex,
				"remote line 0880",
			);

			// Invariant: hooks fired during initial scroll — confirms the right
			// elements are hooked and native scroll events reach them.
			// scrollTop > 0 ensures a reset to zero would trigger the hook.
			const preClose = await readScrollCounters(page);
			for (const [j, state] of preClose.entries()) {
				expect(
					state.fireCount,
					`DOM[${stableDomIndices[j]}] scroll hook did not fire during initial scroll`,
				).toBeGreaterThan(0);
				expect(
					state.scrollTop,
					`DOM[${stableDomIndices[j]}] scrollTop must be > 0 before close`,
				).toBeGreaterThan(0);
			}

			const result = await watchCloseAndDetectVerticalScroll(
				page,
				columnId,
				toggleTestId,
			);

			// Invariant: the CSS transition actually ran.
			expect(
				result.transitionEndFired,
				"CSS transitionend did not fire",
			).toBe(true);

			for (const [j, didShift] of result.shifted.entries()) {
				expect(
					didShift,
					`DOM[${stableDomIndices[j]}] vertical scroll shifted while closing ${side} base pane`,
				).toBe(false);
			}
		});
	}
});

test.describe("Right base pane open diagnostics", () => {
	test("records right base open frames and verifies existing panes stay stable", async ({
		page,
	}, testInfo) => {
		const remotePaneIndex = 2;
		const anchorLine = "remote line 0880";

		await page.setViewportSize({ width: 1400, height: 800 });
		await loadInitialDiff(page);
		await scrollPaneUntilLineVisible(page, remotePaneIndex, anchorLine);
		const existingBeforeOpen = await existingPaneSnapshot(page);
		const remoteFirstLine = await firstVisibleLineInPane(
			page,
			remotePaneIndex,
		);
		const remoteFirstLineNumber = lineNumberFromText(remoteFirstLine);

		const frames = await sampleRightBaseOpenFrames(page);
		await testInfo.attach("right-base-open-frames.json", {
			body: JSON.stringify({ remoteFirstLine, frames }, null, 2),
			contentType: "application/json",
		});

		const renderedFrames = frames.filter(
			(frame) => frame.firstLine !== null,
		);
		expect(renderedFrames.length).toBeGreaterThan(0);
		const driftFrames = existingPaneDriftFrames(frames, existingBeforeOpen);
		if (driftFrames.length > 0) {
			throw new Error(
				JSON.stringify(
					{
						existingBeforeOpen,
						driftFrameCount: driftFrames.length,
						firstDriftFrames: driftFrames.slice(0, 3),
						lastFrames: frames.slice(-3),
					},
					null,
					2,
				),
			);
		}
		const unsyncedFrames = renderedFrames.filter(
			(frame) =>
				lineNumberFromText(frame.firstLine ?? "") !==
				remoteFirstLineNumber,
		);
		await testInfo.attach("right-base-open-summary.json", {
			body: JSON.stringify(
				{
					existingBeforeOpen,
					remoteFirstLine,
					remoteFirstLineNumber,
					firstRenderedLine: renderedFrames[0]?.firstLine,
					existingPaneDriftCount: driftFrames.length,
					blankFrameCount: frames.filter(
						(frame) => frame.firstLine === null,
					).length,
					renderedFrameCount: renderedFrames.length,
					unsyncedFrameCount: unsyncedFrames.length,
					firstUnsyncedFrames: unsyncedFrames.slice(0, 3),
					lastFrames: frames.slice(-3),
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	});
});

test.describe("Base pane Monaco lifecycle", () => {
	test("closing the right base pane keeps Monaco alive during the animation", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1400, height: 800 });
		await loadInitialDiff(page);
		await loadRightBaseDiff(page);
		await expect(page.locator(".monaco-editor")).toHaveCount(4);

		await page.click('[data-testid="toggle-base-right"]');
		await page.waitForTimeout(0);

		// Monaco should still be alive while the column animates off-screen,
		// matching the left base pane behavior.
		expect(await page.locator("#col-base-right").count()).toBe(1);
		expect(await page.locator(".monaco-editor").count()).toBe(4);
	});

	test("closing the left base pane destroys its Monaco editor after the animation", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1400, height: 800 });
		await loadInitialDiff(page);
		await loadBaseDiff(page, "left");

		await page.click('[data-testid="toggle-base-left"]');
		await page.waitForTimeout(500);

		expect(await page.locator("#col-base-left").count()).toBe(0);
		expect(await page.locator(".monaco-editor").count()).toBe(3);
	});

	test("closing the right base pane destroys its Monaco editor after the animation", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1400, height: 800 });
		await loadInitialDiff(page);
		await loadRightBaseDiff(page);

		await page.click('[data-testid="toggle-base-right"]');
		await page.waitForTimeout(500);

		expect(await page.locator("#col-base-right").count()).toBe(0);
		expect(await page.locator(".monaco-editor").count()).toBe(3);
	});
});
