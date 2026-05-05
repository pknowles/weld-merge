// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import {
	type Event,
	EventEmitter,
	ThemeIcon,
	type TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	workspace,
} from "vscode";
import {
	type ConflictState,
	getConflictedFiles,
	getGitDirUri,
	readConflictState,
} from "./gitUtils.ts";
import {
	type GitApiRepository,
	getGitApi,
	isSupportedScheme,
} from "./repoContext.ts";

const CONFLICT_PREFIX_REGEX = /^#?\t/;

function getTreeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const messages: string[] = [];
		const seen = new Set<unknown>();
		let current: unknown = error;
		while (current instanceof Error && !seen.has(current)) {
			seen.add(current);
			messages.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
		}
		if (current !== undefined && !seen.has(current)) {
			messages.push(String(current));
		}
		return messages.join(" -> caused by: ");
	}
	return String(error);
}

interface GitFileOptions {
	label: string;
	collapsibleState: TreeItemCollapsibleState;
	uri: Uri;
	repoPath: Uri;
	commandId: string;
}

abstract class GitFile extends TreeItem {
	readonly uri: Uri;
	readonly repoPath: Uri;

	constructor(options: GitFileOptions) {
		super(options.label, options.collapsibleState);
		this.uri = options.uri;
		this.repoPath = options.repoPath;
		// TODO: seeing "ExplorerItem not found" exception for some files in codespaces
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

// Persistent, in-tree surface for a failure while building the conflict list.
// Takes the slot where the real list (or a subtree of it) would have gone, so
// users always have the error visible in the UI rather than in a transient
// popup. Carries no command / uri: clicking it does nothing, hovering shows
// the full error message.
class ErrorTreeItem extends TreeItem {
	override readonly contextValue = "weldError";

	constructor(label: string, error: unknown) {
		super(label, TreeItemCollapsibleState.None);
		this.iconPath = new ThemeIcon("error");
		this.tooltip = getTreeErrorMessage(error);
		this.description = getTreeErrorMessage(error);
	}
}

// Persistent, in-tree surface for a non-error condition that the user should
// notice. Used when the repository is in a conflict operation but the Git API
// reports no merge changes (e.g. stale state on remote hosts), so the tree
// would otherwise be silently empty. Carries no command / uri: clicking does
// nothing, hovering shows the full diagnostic.
class WarningTreeItem extends TreeItem {
	override readonly contextValue = "weldWarning";

	constructor(label: string, description: string, tooltip: string) {
		super(label, TreeItemCollapsibleState.None);
		this.iconPath = new ThemeIcon("warning");
		this.description = description;
		this.tooltip = tooltip;
	}
}

type ConflictedTreeItem = GitFile | ErrorTreeItem | WarningTreeItem;

class ConflictedFilesProvider implements TreeDataProvider<ConflictedTreeItem> {
	private readonly _onDidChangeTreeData: EventEmitter<
		ConflictedTreeItem | undefined | null
	> = new EventEmitter<ConflictedTreeItem | undefined | null>();
	readonly onDidChangeTreeData: Event<ConflictedTreeItem | undefined | null> =
		this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: ConflictedTreeItem): TreeItem {
		return element;
	}

	// Top-level failures replace the entire list with an ErrorTreeItem so the
	// user sees persistent UI feedback rather than a silent empty list.
	async getChildren(
		element?: ConflictedTreeItem,
	): Promise<ConflictedTreeItem[]> {
		if (element) {
			return [];
		}
		try {
			return await this._getRootChildren();
		} catch (error: unknown) {
			return [new ErrorTreeItem("Failed to list conflicts", error)];
		}
	}

	private async _getRootChildren(): Promise<ConflictedTreeItem[]> {
		const repositories = getGitApi().repositories.filter((r) =>
			isSupportedScheme(r.rootUri),
		);
		if (repositories.length === 0) {
			return [];
		}
		const perRepositoryItems = await Promise.all(
			repositories.map((r) => this._buildItemsForRepository(r)),
		);
		return perRepositoryItems.flat();
	}

	// Builds conflict + resolved items for a single repository. Any failure is
	// caught and replaced with a single error item in that repository's slot,
	// so an unrelated repo's problem cannot wipe out the rest of the tree.
	// Per-repository failures show an ErrorTreeItem for that repo only, allowing
	// other repositories to still display their conflicts normally.
	private async _buildItemsForRepository(
		repository: GitApiRepository,
	): Promise<ConflictedTreeItem[]> {
		try {
			const conflictState = await readConflictState(repository);
			const unmergedFiles = getConflictedFiles(repository);
			const conflictedItems = this._createConflictedItems(
				unmergedFiles,
				repository.rootUri,
			);
			const resolvedFileUris = await this._getResolvedFileUris(
				repository,
				conflictState,
				unmergedFiles,
			);
			const resolvedItems = this._createResolvedItems(
				resolvedFileUris,
				repository.rootUri,
			);
			if (
				conflictState &&
				conflictedItems.length === 0 &&
				resolvedItems.length === 0
			) {
				return [
					new WarningTreeItem(
						`No conflicts detected during ${conflictState.operation}`,
						"Git API mismatch",
						"Git reports a conflict operation in progress but VS Code's Git API returned no merge changes. Try 'Git: Refresh' from the command palette.",
					),
				];
			}
			return [...conflictedItems, ...resolvedItems];
		} catch (error: unknown) {
			return [
				new ErrorTreeItem(
					`Failed to list conflicts for ${repository.rootUri}`,
					error,
				),
			];
		}
	}

	private _createFileUri(rootUri: Uri, filePath: string): Uri {
		const pathSegments = filePath.split("/").filter((segment) => segment);
		return Uri.joinPath(rootUri, ...pathSegments);
	}

	private _createConflictedItems(files: Uri[], repoUri: Uri): GitFile[] {
		return files.map(
			(file) =>
				new ConflictedFile({
					label: workspace.asRelativePath(file, false),
					collapsibleState: TreeItemCollapsibleState.None,
					uri: file,
					repoPath: repoUri,
				}),
		);
	}

	private _createResolvedItems(files: Uri[], rootUri: Uri): GitFile[] {
		return files.map(
			(file) =>
				new ResolvedFile({
					label: workspace.asRelativePath(file, false),
					collapsibleState: TreeItemCollapsibleState.None,
					uri: file,
					repoPath: rootUri,
				}),
		);
	}

	private async _getResolvedFileUris(
		repository: GitApiRepository,
		conflictState: ConflictState | undefined,
		unmergedFiles: Uri[],
	): Promise<Uri[]> {
		if (!conflictState) {
			return [];
		}

		const gitDirUri = await getGitDirUri(repository);
		const mergeMsgPath = Uri.joinPath(gitDirUri, "MERGE_MSG");
		const mergeMsgBytes = await workspace.fs.readFile(mergeMsgPath);
		const msg = new TextDecoder("utf-8").decode(mergeMsgBytes);
		const relativePaths = this._parseMergeMsgConflicts(msg.split("\n"));
		const unmergedFileStrings = new Set(
			unmergedFiles.map((f) => f.toString()),
		);
		return relativePaths
			.map((path) => this._createFileUri(repository.rootUri, path))
			.filter((fileUri) => !unmergedFileStrings.has(fileUri.toString()));
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

export { ConflictedFilesProvider, ErrorTreeItem, GitFile };
