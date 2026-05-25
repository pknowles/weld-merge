import { describe, expect, it } from "@jest/globals";
import { ConflictedFilesProvider } from "../src/treeView.ts";

describe("ConflictedFilesProvider telemetry events", () => {
	it("fires refresh and materialization events at the tree boundary", async () => {
		const provider = new ConflictedFilesProvider();
		let refreshes = 0;
		let getChildrenCalls = 0;
		const refreshSubscription = provider.onDidRefresh(() => {
			refreshes += 1;
		});
		const getChildrenSubscription = provider.onDidGetChildren(() => {
			getChildrenCalls += 1;
		});
		try {
			provider.refresh();
			await provider.getChildren();
		} finally {
			refreshSubscription.dispose();
			getChildrenSubscription.dispose();
		}

		expect(refreshes).toBe(1);
		expect(getChildrenCalls).toBe(1);
	});
});
