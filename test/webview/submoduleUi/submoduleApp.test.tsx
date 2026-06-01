// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SubmoduleApp } from "../../../src/webview/submoduleUi/SubmoduleApp.tsx";
import type {
	CommitInfo,
	SubmoduleConflictSnapshot,
} from "../../../src/webview/submoduleUi/types.ts";

const originalScrollIntoView = Element.prototype.scrollIntoView;
const CHANGED_FILE_BUTTON_NAME = /M src\/file.cpp/u;
const CONFLICT_LOST_TEXT = /no longer active/u;
const MALFORMED_SNAPSHOT_ERROR = /selected/u;

interface TestVsCodeApi {
	postMessage(message: unknown): void;
}

interface TestGlobal {
	acquireVsCodeApi: () => TestVsCodeApi;
}

function commit(hash: string, subject: string): CommitInfo {
	return {
		hash,
		shortHash: hash.slice(0, 7),
		subject,
		message: "",
		authorName: "Weld Test",
		authorEmail: "weld@example.com",
		authorDate: "2026-05-22T00:00:00Z",
		committerName: "Weld Test",
		committerEmail: "weld@example.com",
		committerDate: "2026-05-22T00:00:00Z",
		parents: [],
		refs: [],
		files: null,
	};
}

function snapshot(): SubmoduleConflictSnapshot {
	const base = "1000000000000000000000000000000000000000";
	const local = "2000000000000000000000000000000000000000";
	const remote = "3000000000000000000000000000000000000000";
	return {
		submoduleName: "sub",
		repositoryRoot: "file:///repo",
		submodulePath: "libs/sub",
		base,
		local,
		remote,
		selected: local,
		commits: [
			commit(base, "base commit"),
			commit(remote, "remote commit"),
			commit(local, "local commit"),
		],
	};
}

function postHostMessage(message: unknown): void {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: message }));
	});
}

function installVsCodeApi(messages: unknown[]): void {
	(globalThis as unknown as TestGlobal).acquireVsCodeApi = () => ({
		postMessage: (message: unknown) => messages.push(message),
	});
}

function renderSnapshot() {
	const messages: unknown[] = [];
	installVsCodeApi(messages);
	const rendered = render(<SubmoduleApp />);
	const currentSnapshot = snapshot();
	postHostMessage({ command: "snapshot", snapshot: currentSnapshot });
	return { currentSnapshot, messages, ...rendered };
}

describe("SubmoduleApp loading", () => {
	it("shows loading before the extension host sends the initial snapshot", () => {
		const messages: unknown[] = [];
		installVsCodeApi(messages);

		render(<SubmoduleApp />);

		expect(screen.getByText("Loading...")).toBeInTheDocument();
		expect(messages).toContainEqual({ command: "ready" });
	});
});

describe("SubmoduleApp", () => {
	beforeAll(() => {
		Element.prototype.scrollIntoView = jest.fn();
	});

	afterAll(() => {
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	it("requests a snapshot, lazy-loads selected files, stages, and shows loaded file details", () => {
		const { currentSnapshot, messages } = renderSnapshot();
		expect(messages[0]).toEqual({ command: "ready" });
		expect(screen.getByText("Resolve:")).toBeInTheDocument();
		expect(screen.getByText("libs/sub")).toBeInTheDocument();
		expect(messages).toContainEqual({
			command: "loadCommitFiles",
			sha: currentSnapshot.local,
		});

		postHostMessage({
			command: "commitFiles",
			sha: currentSnapshot.local,
			files: [{ status: "M", path: "src/file.cpp" }],
		});
		expect(
			screen.getByRole("button", { name: CHANGED_FILE_BUTTON_NAME }),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Stage" }));
		expect(messages).toContainEqual({
			command: "stageCommit",
			sha: currentSnapshot.local,
		});

		fireEvent.click(
			screen.getByRole("button", { name: CHANGED_FILE_BUTTON_NAME }),
		);
		expect(messages).toContainEqual({
			command: "showFileDiff",
			sha: currentSnapshot.local,
			filePath: "src/file.cpp",
		});
	});

	it("shows staged success without reusing conflict-lost error state", () => {
		const { currentSnapshot, messages } = renderSnapshot();
		fireEvent.click(screen.getByRole("button", { name: "Stage" }));
		expect(messages).toContainEqual({
			command: "stageCommit",
			sha: currentSnapshot.local,
		});

		postHostMessage({ command: "staged" });

		expect(
			screen.getByText("Submodule conflict staged."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Stage" })).toBeDisabled();
		expect(screen.queryByText(CONFLICT_LOST_TEXT)).not.toBeInTheDocument();
	});

	it("keeps operational errors distinct from conflict-lost states", () => {
		const messages: unknown[] = [];
		installVsCodeApi(messages);
		const { unmount } = render(<SubmoduleApp />);
		postHostMessage({
			command: "error",
			message: "submodule repo missing",
		});
		expect(screen.getByText("submodule repo missing")).toBeInTheDocument();

		unmount();
		render(<SubmoduleApp />);
		postHostMessage({
			command: "conflictLost",
			message: "Submodule conflict is no longer active.",
		});
		expect(
			screen.getByText("Submodule conflict is no longer active."),
		).toBeInTheDocument();
		expect(messages).toContainEqual({ command: "ready" });
	});

	it("surfaces malformed host messages as visible errors", () => {
		const messages: unknown[] = [];
		installVsCodeApi(messages);
		render(<SubmoduleApp />);

		postHostMessage({ command: "snapshot" });

		expect(screen.getByText(MALFORMED_SNAPSHOT_ERROR)).toBeInTheDocument();
	});

	it("restores body text selection when resize drag is interrupted", () => {
		const originalUserSelect = document.body.style.userSelect;
		document.body.style.userSelect = "text";
		try {
			const { container, unmount } = renderSnapshot();
			const resizer = container.querySelector(".submodule-resizer");
			if (!(resizer instanceof HTMLElement)) {
				throw new Error("Missing submodule resizer.");
			}

			fireEvent.mouseDown(resizer);
			expect(document.body.style.userSelect).toBe("none");

			unmount();
			expect(document.body.style.userSelect).toBe("text");
		} finally {
			document.body.style.userSelect = originalUserSelect;
		}
	});
});
