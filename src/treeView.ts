// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { existsSync, lstatSync, readFileSync } from "node:fs";
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
const UNMERGED_INFO_REGEX = /^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/;

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
			commandId: "weldMerge.openMeldDiff",
		});
		this.description = "Conflicted";
		this.contextValue = "conflictedFile";
	}
}

class ConflictedSubmodule extends GitFile {
	constructor(options: Omit<GitFileOptions, "commandId">) {
		super({
			...options,
			commandId: "weld.openSubmoduleDiff",
		});
		this.description = "Conflicted Submodule";
		this.contextValue = "conflictedSubmodule";
	}
}

class ResolvedFile extends GitFile {
	constructor(options: Omit<GitFileOptions, "commandId">) {
		super({
			...options,
			commandId: "weldMerge.openConflictedFile",
		});
		this.description = "Resolved";
		this.contextValue = "resolvedFile";
	}
}

class ResolvedSubmodule extends GitFile {
	constructor(options: Omit<GitFileOptions, "commandId">) {
		super({
			...options,
			commandId: "weld.openSubmoduleDiff",
		});
		this.description = "Resolved Submodule";
		this.contextValue = "resolvedSubmodule";
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
			const unmergedInfo = await this._getUnmergedInfo(repoPath);
			const unmergedFiles = Array.from(unmergedInfo.keys());
			const items: GitFile[] = this._createConflictedItems(
				unmergedInfo,
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
		unmergedInfo: Map<
			string,
			{ mode: string; stages: Map<number, string> }
		>,
		repoPath: string,
	): GitFile[] {
		const items: GitFile[] = [];
		for (const [file, info] of unmergedInfo) {
			const options = {
				label: file,
				collapsibleState: TreeItemCollapsibleState.None,
				uri: Uri.file(join(repoPath, file)),
				repoPath,
			};
			if (info.mode === "160000") {
				items.push(new ConflictedSubmodule(options));
			} else {
				items.push(new ConflictedFile(options));
			}
		}
		return items;
	}

	private _createResolvedItems(files: string[], repoPath: string): GitFile[] {
		return files.map((file) => {
			const fullPath = join(repoPath, file);
			const options = {
				label: file,
				collapsibleState: TreeItemCollapsibleState.None,
				uri: Uri.file(fullPath),
				repoPath,
			};

			try {
				if (existsSync(fullPath) && lstatSync(fullPath).isDirectory()) {
					return new ResolvedSubmodule(options);
				}
			} catch {
				/* Ignore stat errors, fallback to regular file */
			}

			return new ResolvedFile(options);
		});
	}

	private async _getUnmergedInfo(
		repoPath: string,
	): Promise<Map<string, { mode: string; stages: Map<number, string> }>> {
		const unmergedOutput = await execGit(
			["ls-files", "-u", "--stage"],
			repoPath,
		);
		const lines = unmergedOutput
			.trim()
			.split("\n")
			.filter((l) => l);
		const infoMap = new Map<
			string,
			{ mode: string; stages: Map<number, string> }
		>();

		for (const line of lines) {
			// Format: <mode> <sha> <stage> <path>
			const match = line.match(UNMERGED_INFO_REGEX);
			if (match?.[1] && match[2] && match[3] && match[4]) {
				const mode = match[1];
				const sha = match[2];
				const stageStr = match[3];
				const path = match[4];
				const stage = Number.parseInt(stageStr, 10);
				let info = infoMap.get(path);
				if (!info) {
					info = { mode, stages: new Map() };
					infoMap.set(path, info);
				}
				info.stages.set(stage, sha);
			}
		}
		return infoMap;
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
