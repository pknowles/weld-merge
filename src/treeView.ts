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
import { execGit, getGitDir, readConflictState } from "./gitUtils.ts";
import { getGitApi, isSupportedScheme } from "./repoContext.ts";

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

		try {
			const gitApi = await getGitApi();
			const repositoriesByRootUri = new Map<string, Uri>();
			for (const workspaceFolder of workspaceFolders) {
				if (!isSupportedScheme(workspaceFolder.uri)) {
					continue;
				}
				const repository = gitApi.getRepository(workspaceFolder.uri);
				if (!repository) {
					continue;
				}
				repositoriesByRootUri.set(
					repository.rootUri.toString(),
					repository.rootUri,
				);
			}
			if (repositoriesByRootUri.size === 0) {
				return [];
			}
			const perRepositoryItems = await Promise.all(
				[...repositoriesByRootUri.values()].map(async (rootUri) => {
					const repoPath = rootUri.fsPath;
					const unmergedFiles =
						await this._getUnmergedFiles(repoPath);
					const conflictedItems = this._createConflictedItems(
						unmergedFiles,
						rootUri,
						repoPath,
					);
					const originallyConflicted =
						await this._getOriginallyConflicted(repoPath);
					const resolvedFiles = originallyConflicted.filter(
						(f) => !unmergedFiles.includes(f),
					);
					const resolvedItems = this._createResolvedItems(
						resolvedFiles,
						rootUri,
						repoPath,
					);
					return [...conflictedItems, ...resolvedItems];
				}),
			);
			return perRepositoryItems.flat();
		} catch {
			return [];
		}
	}

	private _createFileUri(rootUri: Uri, filePath: string): Uri {
		const pathSegments = filePath.split("/").filter((segment) => segment);
		return Uri.joinPath(rootUri, ...pathSegments);
	}

	private _createConflictedItems(
		files: string[],
		rootUri: Uri,
		repoPath: string,
	): GitFile[] {
		return files.map(
			(file) =>
				new ConflictedFile({
					label: file,
					collapsibleState: TreeItemCollapsibleState.None,
					uri: this._createFileUri(rootUri, file),
					repoPath,
				}),
		);
	}

	private _createResolvedItems(
		files: string[],
		rootUri: Uri,
		repoPath: string,
	): GitFile[] {
		return files.map(
			(file) =>
				new ResolvedFile({
					label: file,
					collapsibleState: TreeItemCollapsibleState.None,
					uri: this._createFileUri(rootUri, file),
					repoPath,
				}),
		);
	}

	private async _getUnmergedFiles(repoPath: string): Promise<string[]> {
		const unmergedOutput = await execGit(
			["diff", "--name-only", "--diff-filter=U", "--"],
			repoPath,
		);
		return unmergedOutput
			.trim()
			.split("\n")
			.filter((f) => f);
	}

	private async _isInConflictState(repoPath: string): Promise<boolean> {
		return (await readConflictState(repoPath)) !== undefined;
	}

	private async _getOriginallyConflicted(
		repoPath: string,
	): Promise<string[]> {
		if (!(await this._isInConflictState(repoPath))) {
			return [];
		}

		const mergeMsgPath = join(await getGitDir(repoPath), "MERGE_MSG");
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
