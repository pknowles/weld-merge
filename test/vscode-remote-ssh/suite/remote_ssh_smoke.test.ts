import assert from "node:assert/strict";
import { env } from "node:process";
import { describe, it } from "mocha";
import { commands, TabInputCustom, Uri, window, workspace } from "vscode";

const REMOTE_AUTHORITY = requiredEnv("WELD_REMOTE_AUTHORITY");
const REMOTE_REPO_URI = Uri.parse(requiredEnv("WELD_REMOTE_REPO_URI"));
const REMOTE_FILE_URI = Uri.parse(requiredEnv("WELD_REMOTE_FILE_URI"));
const WELD_EDITOR_VIEW_TYPE = "weld.mergeEditor";
const OPEN_TREE_CONFLICT_COMMAND =
	"meld-auto-merge.test.openFirstConflictFromTree";
const EXPECTED_AUTO_MERGED_CONTENT = "(??)base";

interface RemoteTreeOpenResult {
	readonly uri: string;
	readonly command: string;
	readonly stages: {
		readonly base: string;
		readonly local: string;
		readonly remote: string;
	};
	readonly initialState: {
		readonly workingContent: string;
		readonly reconstructedContent: string | null;
	};
}

function requiredEnv(name: string): string {
	const value = env[name];
	if (!value) {
		throw new Error(`${name} must be set for remote SSH smoke tests.`);
	}
	return value;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor<T>(
	description: string,
	probe: () => T | Promise<T | null | undefined> | null | undefined,
	timeoutMs = 90_000,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	const poll = async (): Promise<NonNullable<T>> => {
		if (Date.now() >= deadline) {
			const suffix =
				lastError instanceof Error
					? ` Last error: ${lastError.message}`
					: "";
			throw new Error(`Timed out waiting for ${description}.${suffix}`);
		}

		try {
			const value = await probe();
			if (value !== null && value !== undefined) {
				return value as NonNullable<T>;
			}
		} catch (error: unknown) {
			lastError = error;
		}
		await delay(500);
		return poll();
	};
	return poll();
}

describe("Remote SSH smoke test", () => {
	it("opens the remote conflict with Weld's custom editor", async () => {
		assert.equal(REMOTE_REPO_URI.scheme, "vscode-remote");
		assert.equal(REMOTE_FILE_URI.scheme, "vscode-remote");
		assert.equal(REMOTE_REPO_URI.authority, REMOTE_AUTHORITY);

		await waitFor("remote workspace folder", () =>
			workspace.workspaceFolders?.some(
				(folder) =>
					folder.uri.toString() === REMOTE_REPO_URI.toString(),
			)
				? true
				: null,
		);

		await waitFor("Weld remote tree smoke command", async () => {
			const commandIds = await commands.getCommands(true);
			return commandIds.includes(OPEN_TREE_CONFLICT_COMMAND)
				? true
				: null;
		});

		const treeOpenResult = (await commands.executeCommand(
			OPEN_TREE_CONFLICT_COMMAND,
		)) as RemoteTreeOpenResult;
		const openedUri = Uri.parse(treeOpenResult.uri);
		assert.equal(openedUri.path, REMOTE_FILE_URI.path);
		assert.equal(treeOpenResult.command, "meld-auto-merge.openMeldDiff");
		assert.deepEqual(treeOpenResult.stages, {
			base: "base\n",
			local: "local\n",
			remote: "remote\n",
		});
		assert.equal(
			treeOpenResult.initialState.workingContent,
			treeOpenResult.initialState.reconstructedContent,
		);

		await waitFor("Weld custom editor tab", () =>
			window.tabGroups.all
				.flatMap((group) => group.tabs)
				.some(
					(tab) =>
						tab.input instanceof TabInputCustom &&
						tab.input.uri.toString() ===
							REMOTE_FILE_URI.toString() &&
						tab.input.viewType === WELD_EDITOR_VIEW_TYPE,
				)
				? true
				: null,
		);

		await waitFor("remote auto-merge document content", async () => {
			const document = await workspace.openTextDocument(REMOTE_FILE_URI);
			return document.getText() === EXPECTED_AUTO_MERGED_CONTENT
				? true
				: null;
		});
	});
});
