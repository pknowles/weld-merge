// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export class ConflictedFilesProvider
	implements vscode.TreeDataProvider<GitFile>
{
	private _onDidChangeTreeData: vscode.EventEmitter<
		GitFile | undefined | null | undefined
	> = new vscode.EventEmitter<GitFile | undefined | null | undefined>();
	readonly onDidChangeTreeData: vscode.Event<
		GitFile | undefined | null | undefined
	> = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: GitFile): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: GitFile): Promise<GitFile[]> {
		if (element) {
			return Promise.resolve([]);
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return Promise.resolve([]);
		}

		const repoPath = workspaceFolders[0].uri.fsPath;
		try {
			const items: GitFile[] = [];

			// Get unmerged (conflicted) files first.
			// This guarantees we ALWAYS show currently conflicted files, even if MERGE_MSG is missing/corrupt.
			// The official vscode.git API provides repository.state.mergeChanges, but parsing the raw output
			// of 'git diff --name-only' directly ensures we get the synchronous source of truth without relying
			// on the extension's polling state. All arguments are hardcoded strings, so there's zero injection risk.
			const unmergedOutput = await this.execShell(
				"git",
				["diff", "--name-only", "--diff-filter=U"],
				repoPath,
			);
			const unmergedFiles = unmergedOutput
				.trim()
				.split("\n")
				.filter((f) => f);

			items.push(
				...unmergedFiles.map((file) => {
					return new ConflictedFile(
						file,
						vscode.TreeItemCollapsibleState.None,
						vscode.Uri.file(path.join(repoPath, file)),
						repoPath,
					);
				}),
			);

			// Check if we are in a merge, rebase, or cherry-pick state
			const mergeHeadPath = path.join(repoPath, ".git", "MERGE_HEAD");
			const rebaseMergePath = path.join(repoPath, ".git", "rebase-merge");
			const rebaseApplyPath = path.join(repoPath, ".git", "rebase-apply");
			const cherryPickPath = path.join(repoPath, ".git", "CHERRY_PICK_HEAD");

			if (
				fs.existsSync(mergeHeadPath) ||
				fs.existsSync(rebaseMergePath) ||
				fs.existsSync(rebaseApplyPath) ||
				fs.existsSync(cherryPickPath)
			) {
				// Parse MERGE_MSG or similar to find originally conflicted files
				const originallyConflicted: string[] = [];
				const mergeMsgPath = path.join(repoPath, ".git", "MERGE_MSG");

				// standard git merge writes to MERGE_MSG
				if (fs.existsSync(mergeMsgPath)) {
					const msg = fs.readFileSync(mergeMsgPath, "utf8");
					const lines = msg.split("\n");
					let inConflicts = false;
					for (const line of lines) {
						if (
							line.trim() === "Conflicts:" ||
							line.trim() === "# Conflicts:"
						) {
							inConflicts = true;
							continue;
						}
						if (inConflicts) {
							if (line.startsWith("\t") || line.startsWith("#\t")) {
								originallyConflicted.push(line.replace(/^#?\t/, "").trim());
							} else if (line.trim() === "" || line.startsWith("#")) {
							} else {
								break;
							}
						}
					}
				}

				// Any file that was originally conflicted but is NOT currently unmerged is considered "Resolved"
				const resolvedFiles = originallyConflicted.filter(
					(f) => !unmergedFiles.includes(f),
				);

				items.push(
					...resolvedFiles.map((file) => {
						return new ResolvedFile(
							file,
							vscode.TreeItemCollapsibleState.None,
							vscode.Uri.file(path.join(repoPath, file)),
							repoPath,
						);
					}),
				);
			}

			return items;
		} catch (_e) {
			return Promise.resolve([]);
		}
	}

	private execShell(cmd: string, args: string[], cwd: string): Promise<string> {
		return new Promise((resolve) => {
			cp.execFile(cmd, args, { cwd }, (err, stdout) => {
				if (err) {
					resolve("");
				} else {
					resolve(stdout);
				}
			});
		});
	}
}

export abstract class GitFile extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly uri: vscode.Uri,
		public readonly repoPath: string,
	) {
		super(label, collapsibleState);
		this.resourceUri = uri;
		this.tooltip = `${this.label}`;
		this.command = {
			command: "meld-auto-merge.openConflictedFile",
			title: "Open File",
			arguments: [this],
		};
	}
}

export class ConflictedFile extends GitFile {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		uri: vscode.Uri,
		repoPath: string,
	) {
		super(label, collapsibleState, uri, repoPath);
		this.description = "Conflicted";
		this.contextValue = "conflictedFile";
	}
}

export class ResolvedFile extends GitFile {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		uri: vscode.Uri,
		repoPath: string,
	) {
		super(label, collapsibleState, uri, repoPath);
		this.description = "Resolved";
		this.contextValue = "resolvedFile";
	}
}
