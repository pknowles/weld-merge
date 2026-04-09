// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { createRoot } from "react-dom/client";
import { SubmoduleApp } from "../../src/webview/submoduleUi/SubmoduleApp.tsx";
import type { CommitInfo } from "../../src/webview/submoduleUi/types.ts";

interface VsCodeMessage {
	command: string;
	[key: string]: unknown;
}

// Mock VS Code API
// biome-ignore lint/suspicious/noExplicitAny: test environment
(window as any).acquireVsCodeApi = () => ({
	postMessage: (msg: VsCodeMessage) => {
		// biome-ignore lint/suspicious/noConsole: debugging
		console.log("Webview sent message:", msg);
		if (msg.command === "ready") {
			// Send mock initial data
			window.postMessage(
				{
					command: "init",
					submoduleName: "test-submodule",
					base: "base-sha",
					local: "local-tip",
					remote: "remote-tip",
					commits: mockCommits,
				},
				"*",
			);
		}
	},
});

const mockCommits: CommitInfo[] = [
	{
		hash: "local-tip",
		shortHash: "ltip",
		subject: "Local Feature C",
		authorName: "Local Dev",
		authorEmail: "local@example.com",
		authorDate: new Date().toISOString(),
		committerName: "Local Dev",
		committerEmail: "local@example.com",
		committerDate: new Date().toISOString(),
		parents: ["local-2"],
		message: "Local Feature C\n\nDetailed description of local change.",
	},
	{
		hash: "local-2",
		shortHash: "l2",
		subject: "Merge branch 'feature-x' into main",
		authorName: "Local Dev",
		authorEmail: "local@example.com",
		authorDate: new Date(Date.now() - 100_000).toISOString(),
		committerName: "Local Dev",
		committerEmail: "local@example.com",
		committerDate: new Date(Date.now() - 100_000).toISOString(),
		parents: ["local-1", "feature-x-tip"],
		message: "Merge branch 'feature-x' into main",
	},
	{
		hash: "local-1",
		shortHash: "l1",
		subject: "Local Feature A",
		authorName: "Local Dev",
		authorEmail: "local@example.com",
		authorDate: new Date(Date.now() - 200_000).toISOString(),
		committerName: "Local Dev",
		committerEmail: "local@example.com",
		committerDate: new Date(Date.now() - 200_000).toISOString(),
		parents: ["base-sha"],
		message: "Local Feature A",
	},
	{
		hash: "remote-tip",
		shortHash: "rtip",
		subject: "Remote Feature Z",
		authorName: "Remote Dev",
		authorEmail: "remote@example.com",
		authorDate: new Date().toISOString(),
		committerName: "Remote Dev",
		committerEmail: "remote@example.com",
		committerDate: new Date().toISOString(),
		parents: ["remote-1"],
		message: "Remote Feature Z",
	},
	{
		hash: "remote-1",
		shortHash: "r1",
		subject: "Remote Feature Y",
		authorName: "Remote Dev",
		authorEmail: "remote@example.com",
		authorDate: new Date(Date.now() - 150_000).toISOString(),
		committerName: "Remote Dev",
		committerEmail: "remote@example.com",
		committerDate: new Date(Date.now() - 150_000).toISOString(),
		parents: ["base-sha"],
		message: "Remote Feature Y",
	},
	{
		hash: "base-sha",
		shortHash: "base",
		subject: "Common Ancestor",
		authorName: "Common Dev",
		authorEmail: "common@example.com",
		authorDate: new Date(Date.now() - 500_000).toISOString(),
		committerName: "Common Dev",
		committerEmail: "common@example.com",
		committerDate: new Date(Date.now() - 500_000).toISOString(),
		parents: ["ancient-sha"],
		message: "Common Ancestor",
	},
	{
		hash: "ancient-sha",
		shortHash: "anc",
		subject: "Ancient History",
		authorName: "Common Dev",
		authorEmail: "common@example.com",
		authorDate: new Date(Date.now() - 1_000_000).toISOString(),
		committerName: "Common Dev",
		committerEmail: "common@example.com",
		committerDate: new Date(Date.now() - 1_000_000).toISOString(),
		parents: [],
		message: "Ancient History",
	},
];

const container = document.getElementById("root");
if (container) {
	const root = createRoot(container);
	root.render(<SubmoduleApp />);
}
