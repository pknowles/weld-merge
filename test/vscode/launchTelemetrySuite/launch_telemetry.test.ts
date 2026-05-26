import assert from "node:assert/strict";
import process from "node:process";
import { before, describe, it } from "mocha";
import { extensions, workspace } from "vscode";
import type {
	WeldExtensionApi,
	WeldTelemetrySnapshot,
} from "../../../src/extension.ts";
import type { GitApiRepository } from "../../../src/repoContext.ts";
import { getGitApi } from "../../../src/repoContext.ts";

const EXPECTED_REPOSITORIES = 2;
const EXPECTED_MERGE_CHANGES_PER_REPOSITORY = 1;
const TREE_REFRESH_CEILING = 2;
const TREE_GET_CHILDREN_CEILING = 4;
const REFRESH_REPO_CEILING = 2;
const REPOSITORY_STATE_CHANGED_CEILING = 2;
const CONFLICT_STATE_CHANGED_CEILING = 2;
const QUIET_WINDOW_MS = 300;
const QUIET_TIMEOUT_MS = 10_000;

let weldApi: WeldExtensionApi;

before(async () => {
	const ext = extensions.getExtension("pknowles.meld-auto-merge");
	assert.ok(ext, "weld extension must be discoverable");
	weldApi = (await ext.activate()) as WeldExtensionApi;
});

describe("launch telemetry — isolated extension host", () => {
	it("captures one startup refresh per conflicted workspace repository", async () => {
		assert.equal(
			workspace.workspaceFolders?.length,
			EXPECTED_REPOSITORIES,
			"launch telemetry runner must open exactly two workspace folders",
		);
		const repositories = await waitForWorkspaceRepositories();
		await Promise.all(repositories.map(waitForRepositoryMergeChange));
		await waitForQuiet(() =>
			totalLaunchWork(weldApi.getTelemetrySnapshot()),
		);
		const snapshot = weldApi.getTelemetrySnapshot();
		printLaunchTelemetry(snapshot);
		assert.equal(repositories.length, EXPECTED_REPOSITORIES);
		assert.ok(
			snapshot.treeRefreshes <= TREE_REFRESH_CEILING,
			`expected <= ${TREE_REFRESH_CEILING} tree refreshes, got ${snapshot.treeRefreshes}`,
		);
		assert.ok(
			snapshot.treeGetChildrenCalls <= TREE_GET_CHILDREN_CEILING,
			`expected <= ${TREE_GET_CHILDREN_CEILING} getChildren calls, got ${snapshot.treeGetChildrenCalls}`,
		);
		assert.ok(
			snapshot.refreshRepoCalls <= REFRESH_REPO_CEILING,
			`expected <= ${REFRESH_REPO_CEILING} refreshRepo calls, got ${snapshot.refreshRepoCalls}`,
		);
		assert.ok(
			snapshot.repositoryStateChangedEvents <=
				REPOSITORY_STATE_CHANGED_CEILING,
			`expected <= ${REPOSITORY_STATE_CHANGED_CEILING} repository-state events, got ${snapshot.repositoryStateChangedEvents}`,
		);
		assert.ok(
			snapshot.conflictStateChangedEvents <=
				CONFLICT_STATE_CHANGED_CEILING,
			`expected <= ${CONFLICT_STATE_CHANGED_CEILING} conflict-state events, got ${snapshot.conflictStateChangedEvents}`,
		);
	});
});

function totalLaunchWork(snapshot: WeldTelemetrySnapshot): number {
	return (
		snapshot.treeRefreshes +
		snapshot.treeGetChildrenCalls +
		snapshot.refreshRepoCalls +
		snapshot.repositoryStateChangedEvents +
		snapshot.conflictStateChangedEvents
	);
}

function waitForWorkspaceRepositories(): Promise<GitApiRepository[]> {
	const gitApi = getGitApi();
	const current = workspaceRepositories();
	if (current.length === EXPECTED_REPOSITORIES) {
		return Promise.resolve(current);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sub.dispose();
			reject(
				new Error(
					`Expected ${EXPECTED_REPOSITORIES} workspace repositories, got ${workspaceRepositories().length}`,
				),
			);
		}, QUIET_TIMEOUT_MS);
		const sub = gitApi.onDidOpenRepository(() => {
			const repositories = workspaceRepositories();
			if (repositories.length === EXPECTED_REPOSITORIES) {
				clearTimeout(timer);
				sub.dispose();
				resolve(repositories);
			}
		});
	});
}

function workspaceRepositories(): GitApiRepository[] {
	const folders = workspace.workspaceFolders ?? [];
	return getGitApi().repositories.filter((repo) =>
		folders.some(
			(folder) => folder.uri.toString() === repo.rootUri.toString(),
		),
	);
}

function waitForRepositoryMergeChange(
	repository: GitApiRepository,
): Promise<void> {
	if (
		repository.state.mergeChanges.length ===
		EXPECTED_MERGE_CHANGES_PER_REPOSITORY
	) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sub.dispose();
			reject(
				new Error(
					`Expected ${EXPECTED_MERGE_CHANGES_PER_REPOSITORY} merge changes for ${repository.rootUri}, got ${repository.state.mergeChanges.length}`,
				),
			);
		}, QUIET_TIMEOUT_MS);
		const sub = repository.state.onDidChange(() => {
			if (
				repository.state.mergeChanges.length ===
				EXPECTED_MERGE_CHANGES_PER_REPOSITORY
			) {
				clearTimeout(timer);
				sub.dispose();
				resolve();
			}
		});
	});
}

function waitForQuiet(getCount: () => number): Promise<void> {
	const pollMs = 50;
	return new Promise((resolve, reject) => {
		let last = getCount();
		let quietFor = 0;
		let elapsed = 0;
		const interval = setInterval(() => {
			elapsed += pollMs;
			if (elapsed > QUIET_TIMEOUT_MS) {
				clearInterval(interval);
				reject(
					new Error(
						`Launch telemetry never went quiet after ${QUIET_TIMEOUT_MS} ms; last count: ${getCount()}`,
					),
				);
				return;
			}
			const current = getCount();
			quietFor = current === last ? quietFor + pollMs : 0;
			last = current;
			if (quietFor >= QUIET_WINDOW_MS) {
				clearInterval(interval);
				resolve();
			}
		}, pollMs);
	});
}

function printLaunchTelemetry(snapshot: WeldTelemetrySnapshot): void {
	process.stdout.write(
		[
			"isolated launch telemetry:",
			`  treeRefreshes: ${snapshot.treeRefreshes}`,
			`  treeGetChildrenCalls: ${snapshot.treeGetChildrenCalls}`,
			`  refreshRepoCalls: ${snapshot.refreshRepoCalls}`,
			`  repositoryStateChangedEvents: ${snapshot.repositoryStateChangedEvents}`,
			`  conflictStateChangedEvents: ${snapshot.conflictStateChangedEvents}`,
			"  refreshRepoReasons:",
			...formatRefreshRepoReasons(snapshot.refreshRepoReasons),
		].join("\n"),
	);
	process.stdout.write("\n");
}

function formatRefreshRepoReasons(
	reasons: WeldTelemetrySnapshot["refreshRepoReasons"],
): string[] {
	return Object.entries(reasons)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([reason, count]) => `    ${reason}: ${count}`);
}
