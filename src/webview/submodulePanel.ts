// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { basename, join } from "node:path";

const HEX_SHA_REGEX = /^[0-9a-fA-F]+$/;

import {
	commands,
	type Disposable,
	Uri,
	ViewColumn,
	type WebviewPanel,
	window,
} from "vscode";
import {
	getCommitFiles,
	getGitApi,
	getRepoForPath,
	getStagedSubmoduleShas,
	stageSubmoduleCommit,
} from "../gitSubmodule.ts";
import { execGit } from "../gitUtils.ts";
import type { ConflictedFilesProvider } from "../treeView.ts";

interface CommitBlob {
	hash: string;
	shortHash: string;
	authorName: string;
	authorEmail: string;
	authorDate: string;
	committerName: string;
	committerEmail: string;
	committerDate: string;
	parents: string[];
	marker: string;
	subject: string;
	message: string;
}

export class SubmodulePanel {
	static currentPanel: SubmodulePanel | undefined;
	private readonly panel: WebviewPanel;
	private readonly extensionUri: Uri;
	private readonly repoPath: string;
	private readonly submodulePath: string;
	private readonly conflictedFilesProvider: ConflictedFilesProvider;
	private readonly disposables: Disposable[] = [];

	private constructor(
		panel: WebviewPanel,
		extensionUri: Uri,
		repoPath: string,
		submodulePath: string,
		conflictedFilesProvider: ConflictedFilesProvider,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.repoPath = repoPath;
		this.submodulePath = submodulePath;
		this.conflictedFilesProvider = conflictedFilesProvider;
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			async (msg) => {
				await this._handleMessage(msg);
			},
			null,
			this.disposables,
		);
	}

	static open(
		extensionUri: Uri,
		repoPath: string,
		submodulePath: string,
		conflictedFilesProvider: ConflictedFilesProvider,
	) {
		if (SubmodulePanel.currentPanel) {
			SubmodulePanel.currentPanel.panel.reveal();
			return;
		}
		const panel = window.createWebviewPanel(
			"weldSubmoduleDiff",
			`Submodule: ${basename(submodulePath)}`,
			ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [Uri.joinPath(extensionUri, "out")],
				retainContextWhenHidden: true,
			},
		);
		SubmodulePanel.currentPanel = new SubmodulePanel(
			panel,
			extensionUri,
			repoPath,
			submodulePath,
			conflictedFilesProvider,
		);
		SubmodulePanel.currentPanel._init();
	}

	private _init() {
		this.panel.webview.html = this._getHtml();
	}

	private async _handleMessage(msg: {
		command: string;
		sha?: string;
		query?: string;
		subSha?: string;
		parentSha?: string;
		filePath?: string;
	}) {
		switch (msg.command) {
			case "ready":
				await this._sendInitialData();
				break;
			case "searchCommits":
				if (msg.query !== undefined) {
					await this._handleSearch(msg.query);
				}
				break;
			case "getCommitFiles":
				if (msg.sha) {
					await this._handleGetCommitFiles(msg.sha);
				}
				break;
			case "stageCommit":
				if (msg.sha) {
					await this._handleStage(msg.sha);
				}
				break;
			case "showFileDiff":
				if (msg.subSha && msg.parentSha && msg.filePath) {
					await this._handleShowFileDiff({
						subSha: msg.subSha,
						parentSha: msg.parentSha,
						filePath: msg.filePath,
					});
				}
				break;
			default:
				break;
		}
	}

	private async _sendInitialData() {
		try {
			const gitApi = await getGitApi();
			if (!gitApi) {
				return;
			}
			const shas = await getStagedSubmoduleShas(
				this.repoPath,
				this.submodulePath,
			);
			if (!shas) {
				const errorStr = "Could not find staged SHAs for submodule.";
				window.showErrorMessage(errorStr);
				this.panel.webview.postMessage({
					command: "error",
					message: errorStr,
				});
				throw new Error(errorStr);
			}
			const subRepoPath = join(this.repoPath, this.submodulePath);
			const subRepo = getRepoForPath(gitApi, subRepoPath);
			if (!subRepo) {
				const errorStr = `Submodule repository not found at ${subRepoPath}. Is it initialized?`;
				window.showErrorMessage(errorStr);
				this.panel.webview.postMessage({
					command: "error",
					message: errorStr,
				});
				throw new Error(errorStr);
			}

			let mergeBase = shas.base;
			try {
				// Get the merge base of the parent repository - this is the definitive source
				const parentBase = await execGit(
					["merge-base", "HEAD", "MERGE_HEAD"],
					this.repoPath,
				);
				if (parentBase.trim()) {
					// git rev-parse <BASE>:path/to/submodule
					const baseSha = await execGit(
						[
							"rev-parse",
							"--verify",
							`${parentBase.trim()}:${this.submodulePath}`,
						],
						this.repoPath,
					);
					if (baseSha.trim()) {
						mergeBase = baseSha.trim();
					}
				}
			} catch {
				/* If the parent HAS no merge-base (e.g. cherry-pick/rebase), shas.base is already our Stage 1 */
			}

			// Find universal merge base across all three points
			const commonAncestor = (
				await execGit(
					["merge-base", shas.local, shas.remote, shas.base].filter(
						Boolean,
					),
					subRepoPath,
				)
			).trim();

			// Fetch all commits between the tips and the universal base
			const format =
				"%H%x01%h%x01%an%x01%ae%x01%aI%x01%cn%x01%ce%x01%cI%x01%P%x01%B%x00";
			const output = await execGit(
				[
					"log",
					shas.local,
					shas.remote,
					shas.base,
					"--not",
					`${commonAncestor}~20`, // Context buffer
					"--topo-order",
					"--left-right",
					"--reverse",
					`-n${500}`,
					`--format=%m%x01${format}`,
				].filter(Boolean),
				subRepoPath,
			);
			const commits = output
				.split("\x00")
				.map((blob) => blob.trim())
				.filter(Boolean)
				.map((blob) => this._parseBlob(blob));

			this.panel.webview.postMessage({
				command: "init",
				submoduleName: basename(this.submodulePath),
				base: mergeBase || shas.base,
				local: shas.local,
				remote: shas.remote,
				commits,
			});
		} catch (e: unknown) {
			const error = (e as Error).message;
			window.showErrorMessage(`Submodule error: ${error}`);
			this.panel.webview.postMessage({
				command: "error",
				message: error,
			});
			throw e;
		}
	}

	private _parseBlob(blob: string): CommitBlob {
		// Field order in format: %m, %H, %h, %an, %ae, %aI, %cn, %ce, %cI, %P, %B
		const fields = blob.trim().split("\x01");
		const rawBody = fields[10] ?? "";
		const bodyLines = rawBody.split("\n");

		// Subject is the first non-empty line of the body
		let subject = "";
		let subjectIndex = -1;
		for (let i = 0; i < bodyLines.length; i++) {
			const line = bodyLines[i];
			if (line?.trim()) {
				subject = line.trim();
				subjectIndex = i;
				break;
			}
		}

		// Message is everything after the subject line
		const message = bodyLines
			.slice(subjectIndex + 1)
			.join("\n")
			.trim();

		return {
			hash: fields[1] || "",
			shortHash: fields[2] || "",
			authorName: fields[3] || "",
			authorEmail: fields[4] || "",
			authorDate: fields[5] || "",
			committerName: fields[6] || "",
			committerEmail: fields[7] || "",
			committerDate: fields[8] || "",
			parents: fields[9] ? fields[9].split(" ") : [],
			marker: fields[0] || "",
			subject,
			message,
		};
	}

	private async _handleSearch(query: string) {
		const subRepoPath = join(this.repoPath, this.submodulePath);
		const format =
			"%H%x01%h%x01%an%x01%ae%x01%aI%x01%cn%x01%ce%x01%cI%x01%P%x01%B%x00";

		const results = new Map<string, CommitBlob>();

		// Helper to fetch and parse commits
		const runLog = async (args: string[]) => {
			try {
				const output = await execGit(args, subRepoPath);
				const blobs = output.split("\x00").filter(Boolean);
				for (const blob of blobs) {
					const commit = this._parseBlob(blob);
					results.set(commit.hash, commit);
				}
			} catch {
				/* Ignore errors from specific searches */
			}
		};

		// 1. Search by message in all branches
		await runLog([
			"log",
			"--all",
			"--grep",
			query,
			"-i",
			"-n",
			"50",
			`--format=${format}`,
		]);

		// 2. If query looks like a SHA fragment, try to find by SHA
		if (query.length >= 4 && HEX_SHA_REGEX.test(query)) {
			await runLog([
				"log",
				"--all",
				"--no-walk",
				query,
				"-n",
				"50",
				`--format=${format}`,
			]);
		}

		this.panel.webview.postMessage({
			command: "searchResults",
			commits: Array.from(results.values()),
		});
	}

	private async _handleGetCommitFiles(sha: string) {
		try {
			const subRepoPath = join(this.repoPath, this.submodulePath);
			const files = await getCommitFiles(subRepoPath, sha);
			this.panel.webview.postMessage({
				command: "commitInfo",
				hash: sha,
				files,
			});
		} catch {
			/* Ignore */
		}
	}

	private async _handleStage(sha: string) {
		try {
			await stageSubmoduleCommit(this.repoPath, this.submodulePath, sha);
			window.showInformationMessage(
				`Staged submodule ${basename(this.submodulePath)} at ${sha.substring(0, 7)}`,
			);
			this.conflictedFilesProvider.refresh();
			this.panel.dispose();
		} catch (e: unknown) {
			window.showErrorMessage(
				`Failed to stage submodule: ${(e as Error).message}`,
			);
			throw e;
		}
	}

	private async _handleShowFileDiff(msg: {
		subSha: string;
		parentSha: string;
		filePath: string;
	}) {
		const gitApi = await getGitApi();
		if (!gitApi) {
			return;
		}
		const subRepoPath = join(this.repoPath, this.submodulePath);
		const leftUri = gitApi.toGitUri(
			Uri.file(join(subRepoPath, msg.filePath)),
			msg.parentSha,
		);
		const rightUri = gitApi.toGitUri(
			Uri.file(join(subRepoPath, msg.filePath)),
			msg.subSha,
		);
		await commands.executeCommand(
			"vscode.diff",
			leftUri,
			rightUri,
			`${basename(msg.filePath)} (${msg.subSha.substring(0, 7)})`,
		);
	}

	private _getHtml(): string {
		const scriptUri = this.panel.webview.asWebviewUri(
			Uri.joinPath(this.extensionUri, "out", "webview", "submodule.js"),
		);
		const cssUri = this.panel.webview.asWebviewUri(
			Uri.joinPath(this.extensionUri, "out", "webview", "index.css"),
		);
		const cspSource = this.panel.webview.cspSource;
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource}; img-src ${cspSource} data:; font-src ${cspSource};"><title>Weld Submodule Merge</title><link rel="stylesheet" href="${cssUri}"><style>body { padding: 0; margin: 0; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); } #root { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }</style></head><body><div id="root"></div><script src="${scriptUri}"></script></body></html>`;
	}

	dispose() {
		SubmodulePanel.currentPanel = undefined;
		this.panel.dispose();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}
}
