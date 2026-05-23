// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { GitGraph } from "./GitGraph.tsx";
import type { CommitInfo } from "./types.ts";

const originalScrollIntoView = Element.prototype.scrollIntoView;
const REMOTE_ROW_NAME = /remote.*origin\/remote.*Remote/u;

function commit(
	hash: string,
	subject: string,
	parents: string[],
	refs: string[] = [],
): CommitInfo {
	return {
		hash,
		shortHash: hash.slice(0, 7),
		subject,
		message: "",
		authorName: "Test Author",
		authorEmail: "author@example.com",
		authorDate: "2026-05-22T00:00:00Z",
		committerName: "Test Committer",
		committerEmail: "committer@example.com",
		committerDate: "2026-05-22T00:00:00Z",
		parents,
		refs,
		files: null,
	};
}

describe("GitGraph", () => {
	beforeAll(() => {
		Element.prototype.scrollIntoView = jest.fn();
	});

	afterAll(() => {
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	it("renders Git-provided order newest first without dangling branch-tip lanes", () => {
		const base = "1000000000000000000000000000000000000000";
		const local = "2000000000000000000000000000000000000000";
		const remote = "3000000000000000000000000000000000000000";
		const onSelect = jest.fn();
		render(
			<GitGraph
				commits={[
					commit(base, "base", []),
					commit(remote, "remote", [base], ["origin/remote"]),
					commit(local, "local", [base], ["HEAD -> local"]),
				]}
				baseSha={base}
				localSha={local}
				remoteSha={remote}
				selectedSha={remote}
				onSelect={onSelect}
			/>,
		);

		const rows = screen.getAllByRole("button");
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("local"),
			expect.stringContaining("remote"),
			expect.stringContaining("base"),
		]);

		const remoteRow = screen.getByRole("button", {
			name: REMOTE_ROW_NAME,
		});
		const remotePaths = Array.from(remoteRow.querySelectorAll("path")).map(
			(path) => path.getAttribute("d") ?? "",
		);
		expect(remotePaths).not.toContain("M 48 0 L 48 14");
		expect(remotePaths).toContain("M 48 14 C 48 33.6, 24 22.4, 24 42");
		expect(
			remoteRow.querySelector("circle")?.getAttribute("fill"),
		).toContain("var(--vscode-charts-purple)");

		fireEvent.click(remoteRow);
		expect(onSelect).toHaveBeenCalledWith(remote);
		expect(screen.getByText("Remote")).toBeInTheDocument();
		expect(screen.getByText("HEAD")).toBeInTheDocument();
		expect(screen.getAllByText("local")).toHaveLength(2);
	});

	it("shows visible truncation for off-window parents", () => {
		const oldParent = "4000000000000000000000000000000000000000";
		const visible = "5000000000000000000000000000000000000000";
		render(
			<GitGraph
				commits={[commit(visible, "visible", [oldParent])]}
				baseSha={visible}
				localSha={visible}
				remoteSha={visible}
				selectedSha={visible}
				onSelect={() => undefined}
			/>,
		);

		expect(screen.getByText("Earlier history...")).toBeInTheDocument();
		expect(screen.getByText("Base")).toBeInTheDocument();
		expect(screen.getByText("Local")).toBeInTheDocument();
		expect(screen.getByText("Remote")).toBeInTheDocument();
	});
});
