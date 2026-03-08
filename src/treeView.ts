// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Event,
	EventEmitter,
	type TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	workspace,
} from "vscode";
import { execGit } from "./gitUtils.ts";

const CONFLICT_PREFIX_REGEX = /^#?\t/;

interface GitFileOptions {
	label: string;
	collapsibleState: TreeItemCollapsibleState;
	uri: Uri;
	repoPath: string;
	commandId: string;
}

abstract class GitFile extends TreeItem {
	readonly uri: Uri;
	readonly repoPath: string;

	constructor(options: GitFileOptions) {
		super(options.label, options.collapsibleState);
		this.uri = options.uri;
		this.repoPath = options.repoPath;
		this.resourceUri = options.uri;
		this.tooltip = `${options.label}`;
		this.command = {
			command: options.commandId,
			title: "Open",
			arguments: [this],
		};
	}
}

class ConflictedFile extends GitFile {
	constructor(options: Omit<GitFileOptions, "commandId">) {
		super({
			...options,
			commandId: "meld-auto-merge.openMeldDiff",
		});
		this.description = "Conflicted";
		this.contextValue = "conflictedFile";
	}
}

class ResolvedFile extends GitFile {
	constructor(options: Omit<GitFileOptions, "commandId">) {
		super({
			...options,
			commandId: "meld-auto-merge.openConflictedFile",
		});
		this.description = "Resolved";
		this.contextValue = "resolvedFile";
	}
}

class ConflictedFilesProvider implements TreeDataProvider<GitFile> {
	private readonly _onDidChangeTreeData: EventEmitter<
		GitFile | undefined | null
	> = new EventEmitter<GitFile | undefined | null>();
	readonly onDidChangeTreeData: Event<GitFile | undefined | null> =
		this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: GitFile): TreeItem {
		return element;
	}

	async getChildren(element?: GitFile): Promise<GitFile[]> {
		if (element) {
			return [];
		}

		const workspaceFolders = workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return [];
		}

		const repoPath = workspaceFolders[0]?.uri.fsPath;
		if (!repoPath) {
			return [];
		}

		try {
			const unmergedFiles = await this._getUnmergedFiles(repoPath);
			const items: GitFile[] = this._createConflictedItems(
				unmergedFiles,
				repoPath,
			);

			const originallyConflicted =
				this._getOriginallyConflicted(repoPath);
			const resolvedFiles = originallyConflicted.filter(
				(f) => !unmergedFiles.includes(f),
			);

			items.push(...this._createResolvedItems(resolvedFiles, repoPath));

			return items;
		} catch {
			return [];
		}
	}

	private _createConflictedItems(
		files: string[],
		repoPath: string,
	): GitFile[] {
		return files.map(
			(file) =>
				new ConflictedFile({
					label: file,
					collapsibleState: TreeItemCollapsibleState.None,
					uri: Uri.file(join(repoPath, file)),
					repoPath,
				}),
		);
	}

	private _createResolvedItems(files: string[], repoPath: string): GitFile[] {
		return files.map(
			(file) =>
				new ResolvedFile({
					label: file,
					collapsibleState: TreeItemCollapsibleState.None,
					uri: Uri.file(join(repoPath, file)),
					repoPath,
				}),
		);
	}

	private async _getUnmergedFiles(repoPath: string): Promise<string[]> {
		const unmergedOutput = await execGit(
			["diff", "--name-only", "--diff-filter=U"],
			repoPath,
		);
		return unmergedOutput
			.trim()
			.split("\n")
			.filter((f) => f);
	}

	private _isInConflictState(repoPath: string): boolean {
		const stateFiles = [
			"MERGE_HEAD",
			"rebase-merge",
			"rebase-apply",
			"CHERRY_PICK_HEAD",
		];
		return stateFiles.some((f) => existsSync(join(repoPath, ".git", f)));
	}

	private _getOriginallyConflicted(repoPath: string): string[] {
		if (!this._isInConflictState(repoPath)) {
			return [];
		}

		const mergeMsgPath = join(repoPath, ".git", "MERGE_MSG");
		if (!existsSync(mergeMsgPath)) {
			return [];
		}

		const msg = readFileSync(mergeMsgPath, "utf8");
		const lines = msg.split("\n");

		return this._parseMergeMsgConflicts(lines);
	}

	private _parseMergeMsgConflicts(lines: string[]): string[] {
		const originallyConflicted: string[] = [];
		let inConflicts = false;

		for (const line of lines) {
			const trimmed = line.trim();
			if (this._isConflictHeader(trimmed)) {
				inConflicts = true;
				continue;
			}
			if (inConflicts) {
				if (this._isConflictEntry(line)) {
					originallyConflicted.push(
						line.replace(CONFLICT_PREFIX_REGEX, "").trim(),
					);
				} else if (this._shouldStopParsing(line, trimmed)) {
					break;
				}
			}
		}
		return originallyConflicted;
	}

	private _isConflictHeader(trimmed: string): boolean {
		return trimmed === "Conflicts:" || trimmed === "# Conflicts:";
	}

	private _isConflictEntry(line: string): boolean {
		return line.startsWith("\t") || line.startsWith("#\t");
	}

	private _shouldStopParsing(line: string, trimmed: string): boolean {
		return trimmed !== "" && !line.startsWith("#");
	}
}

export { GitFile, ConflictedFilesProvider };
