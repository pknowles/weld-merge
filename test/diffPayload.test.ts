import { describe, expect, it, jest } from "@jest/globals";
import { Uri } from "vscode";
import type { ConflictedItem } from "../src/repoContext.ts";
import { GitStatus } from "../src/repoContext.ts";
import { buildDiffPayload } from "../src/webview/diffPayload.ts";

// readConflictState calls getGitDirUri which does real filesystem I/O. Stub it
// out: returning null means "no active merge operation" (getRemoteRef → null).
jest.mock("../src/gitUtils.ts", () => ({
	// biome-ignore lint/suspicious/noExplicitAny: mock return type needs any
	readConflictState: jest.fn<() => Promise<any>>().mockResolvedValue(null),
}));

interface CommitShape {
	hash: string;
	message: string;
	authorName?: string;
	authorEmail?: string;
	authorDate?: Date;
}

// Minimal mock for GitApiRepository — only the methods buildDiffPayload calls.
function makeRepo(
	overrides: {
		show?: (ref: string, path: string) => Promise<string>;
		getCommit?: (ref: string) => Promise<CommitShape>;
		getMergeBase?: (a: string, b: string) => Promise<string>;
	} = {},
) {
	return {
		rootUri: Uri.file("/repo"),
		state: {
			mergeChanges: [],
			onDidChange: jest.fn(),
		},
		status: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		show:
			overrides.show ??
			jest
				.fn<(ref: string, path: string) => Promise<string>>()
				.mockResolvedValue(""),
		getCommit:
			overrides.getCommit ??
			jest.fn<(ref: string) => Promise<CommitShape>>().mockResolvedValue({
				hash: "abc123",
				message: "initial\n",
				authorName: "Dev",
				authorEmail: "dev@example.com",
				authorDate: new Date("2024-01-01"),
			}),
		getMergeBase:
			overrides.getMergeBase ??
			jest
				.fn<(a: string, b: string) => Promise<string>>()
				.mockResolvedValue(""),
		add: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};
}

function makeConflictedItem(
	repo: ReturnType<typeof makeRepo>,
	status?: number,
): ConflictedItem {
	const fileUri = Uri.file("/repo/conflict.txt");
	return {
		repository: repo as never,
		rootUri: Uri.file("/repo"),
		uri: fileUri,
		mergeChange: status === undefined ? null : { uri: fileUri, status },
		conflictStatus: jest.fn<() => never>(),
	};
}

const BOTH_MODIFIED_STAGES = {
	base: "base line\n",
	local: "local line\n",
	incoming: "remote line\n",
};

// ─── payload shape ────────────────────────────────────────────────────────────

describe("buildDiffPayload payload shape", () => {
	it("returns three files with Local, Merged, Remote labels in order", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: {
				base: "shared\n",
				local: "local change\n",
				incoming: "remote change\n",
			},
		});

		expect(result.files).toHaveLength(3);
		expect(result.files[0].label).toBe("Local");
		expect(result.files[1].label).toBe("Merged");
		expect(result.files[2].label).toBe("Remote");
	});

	it("Local and Remote content match the injected stages exactly", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: {
				base: "base\n",
				local: "local content\n",
				incoming: "remote content\n",
			},
		});

		expect(result.files[0].content).toBe("local content\n");
		expect(result.files[2].content).toBe("remote content\n");
	});

	it("always sets isConflicted to true", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: { base: "b\n", local: "l\n", incoming: "r\n" },
		});

		expect(result.isConflicted).toBe(true);
	});

	it("diffs array has exactly two entries (left and right)", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: { base: "b\n", local: "l\n", incoming: "r\n" },
		});

		expect(result.diffs).toHaveLength(2);
	});

	it("Merged file has no commit metadata", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: { base: "b\n", local: "l\n", incoming: "r\n" },
		});

		expect(result.files[1].commit).toBeUndefined();
	});

	it("attaches commit metadata to Local and Remote files", async () => {
		const commitDate = new Date("2024-06-15T10:00:00Z");
		const repo = makeRepo({
			getCommit: jest
				.fn<(ref: string) => Promise<CommitShape>>()
				.mockResolvedValue({
					hash: "deadbeef",
					message: "fix: some bug\n\nbody text",
					authorName: "Alice",
					authorEmail: "alice@example.com",
					authorDate: commitDate,
				}),
		});

		const result = await buildDiffPayload(makeConflictedItem(repo), {
			stages: { base: "", local: "l\n", incoming: "r\n" },
		});

		expect(result.files[0].commit?.hash).toBe("deadbeef");
		expect(result.files[0].commit?.title).toBe("fix: some bug");
		expect(result.files[0].commit?.authorName).toBe("Alice");
		expect(result.files[0].commit?.authorEmail).toBe("alice@example.com");
		expect(result.files[0].commit?.date).toBe(commitDate.toISOString());
	});
});

// ─── merge behaviour ──────────────────────────────────────────────────────────

describe("buildDiffPayload merge behaviour", () => {
	it("auto-merges identical local and remote with no conflict markers", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: {
				base: "original\n",
				local: "changed\n",
				incoming: "changed\n",
			},
		});

		expect(result.files[1].content).toBe("changed\n");
		expect(result.files[1].content).not.toContain("<<<<<<<");
	});

	it("marks Merged as conflicted when local and remote diverge", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: BOTH_MODIFIED_STAGES,
		});

		// The JS Merger uses (??) markers (not git-style <<<<<<<).
		expect(result.files[1].content).toContain("(??)");
		// And the diff array must contain at least one conflict chunk.
		const allChunks = [...result.diffs[0], ...result.diffs[1]];
		expect(allChunks.some((c) => c.tag === "conflict")).toBe(true);
	});

	it("uses empty string as base for BOTH_ADDED and still merges", async () => {
		const result = await buildDiffPayload(
			makeConflictedItem(makeRepo(), GitStatus.BOTH_ADDED),
			{
				stages: {
					base: "",
					local: "same line\n",
					incoming: "same line\n",
				},
			},
		);

		expect(result.files[1].content).toBe("same line\n");
		expect(result.files[1].content).not.toContain("<<<<<<<");
	});

	it("uses caller-supplied workingContent instead of auto-merging", async () => {
		const workingContent = "user edited content\n";
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: { base: "base\n", local: "local\n", incoming: "remote\n" },
			workingContent,
		});

		expect(result.files[1].content).toBe(workingContent);
	});
});

// ─── opcode correctness ───────────────────────────────────────────────────────
//
// local: "a\nX\nc\n"  incoming: "a\nb\nY\n"  base: "a\nb\nc\n"
// Local changed line 2 (b→X); Remote changed line 3 (c→Y).
// Auto-merge produces "a\nX\nY\n" — a clean 3-way merge.
// Left diffs (merged↔local): line 3 differs (Y vs c).
// Right diffs (merged↔remote): line 2 differs (X vs b).

describe("buildDiffPayload opcode correctness", () => {
	const cleanStages = {
		base: "a\nb\nc\n",
		local: "a\nX\nc\n",
		incoming: "a\nb\nY\n",
	};

	it("left diffs mark lines where Merged and Local content differ", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: cleanStages,
		});

		// Merged is "a\nX\nY\n". Local is "a\nX\nc\n". They differ on line "Y" vs "c".
		// Left diff chunks (merged↔local) must only cover lines that actually differ.
		const mergedLines = result.files[1].content.split("\n");
		const localLines = result.files[0].content.split("\n");
		const leftNonEqual = result.diffs[0].filter((c) => c.tag !== "equal");

		// Every non-equal chunk must point to lines that actually differ.
		for (const c of leftNonEqual) {
			const mergedSlice = mergedLines.slice(c.startA, c.endA).join("\n");
			const localSlice = localLines.slice(c.startB, c.endB).join("\n");
			expect(mergedSlice).not.toBe(localSlice);
		}
		// Lines that are equal between merged and local must not appear in diffs.
		expect(leftNonEqual.length).toBeGreaterThan(0);
	});

	it("right diffs mark lines where Merged and Remote content differ", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: cleanStages,
		});

		// Merged is "a\nX\nY\n". Remote is "a\nb\nY\n". They differ on "X" vs "b".
		const mergedLines = result.files[1].content.split("\n");
		const remoteLines = result.files[2].content.split("\n");
		const rightNonEqual = result.diffs[1].filter((c) => c.tag !== "equal");

		for (const c of rightNonEqual) {
			const mergedSlice = mergedLines.slice(c.startA, c.endA).join("\n");
			const remoteSlice = remoteLines.slice(c.startB, c.endB).join("\n");
			expect(mergedSlice).not.toBe(remoteSlice);
		}
		expect(rightNonEqual.length).toBeGreaterThan(0);
	});

	it("explicit workingContent causes non-empty left diffs when it differs from Local", async () => {
		const result = await buildDiffPayload(makeConflictedItem(makeRepo()), {
			stages: { base: "x\n", local: "x\n", incoming: "x\n" },
			workingContent: "completely different\n",
		});

		expect(result.diffs[0].length).toBeGreaterThan(0);
	});
});
