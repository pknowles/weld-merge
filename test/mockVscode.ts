import { readFileSync, statSync } from "node:fs";

class Uri {
	readonly scheme: string;
	readonly path: string;
	readonly query: string;

	private constructor(scheme: string, path: string, query: string) {
		this.scheme = scheme;
		this.path = path;
		this.query = query;
	}

	get fsPath(): string {
		return this.path;
	}

	static file(path: string): Uri {
		return new Uri("file", path, "");
	}

	static parse(value: string): Uri {
		const parsed = new URL(value);
		return new Uri(
			parsed.protocol.slice(0, -1),
			parsed.pathname,
			parsed.search.slice(1),
		);
	}

	static from(value: { scheme: string; path: string; query?: string }): Uri {
		return new Uri(value.scheme, value.path, value.query ?? "");
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		const suffix = segments
			.flatMap((segment) => segment.split("/"))
			.filter((segment) => segment.length > 0)
			.join("/");
		const basePath = base.path.endsWith("/")
			? base.path.slice(0, -1)
			: base.path;
		return new Uri(
			base.scheme,
			suffix ? `${basePath}/${suffix}` : basePath,
			base.query,
		);
	}

	toString(): string {
		if (this.scheme === "file") {
			return `file://${this.path}`;
		}
		const query = this.query ? `?${this.query}` : "";
		return `${this.scheme}:${this.path}${query}`;
	}
}

class ThemeIcon {
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}
}

const TreeItemCollapsibleState = Object.freeze(
	Object.fromEntries([
		["None", 0],
		["Collapsed", 1],
		["Expanded", 2],
	]),
) as Record<string, number>;
type TreeItemCollapsibleState = number;

class TreeItem {
	label: string;
	collapsibleState: TreeItemCollapsibleState;
	contextValue: string | undefined;
	description: string | undefined;
	tooltip: string | undefined;
	resourceUri: Uri | undefined;
	command:
		| { command: string; title: string; arguments?: unknown[] }
		| undefined;
	iconPath: ThemeIcon | undefined;

	constructor(label: string, collapsibleState: TreeItemCollapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

class EventEmitter<T> {
	readonly listeners: Array<(event: T) => void> = [];
	readonly event = (listener: (event: T) => void) => {
		this.listeners.push(listener);
		return { dispose: () => undefined };
	};

	fire(event: T): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

const fileTypeFile = 1;
const fileTypeDirectory = 2;
const FileType = Object.freeze(
	Object.fromEntries([
		["File", fileTypeFile],
		["Directory", fileTypeDirectory],
	]),
) as Record<string, number>;

const workspace = {
	asRelativePath: (uri: Uri) => uri.fsPath,
	getWorkspaceFolder: () => undefined,
	fs: {
		stat: (uri: Uri) => {
			try {
				const stat = statSync(uri.fsPath);
				return Promise.resolve({
					type: stat.isDirectory() ? fileTypeDirectory : fileTypeFile,
				});
			} catch (error: unknown) {
				return Promise.reject(error);
			}
		},
		readFile: (uri: Uri) => Promise.resolve(readFileSync(uri.fsPath)),
		delete: () => Promise.reject(new Error("not implemented")),
	},
	onDidSaveTextDocument: () => ({ dispose: () => undefined }),
	onDidCloseTextDocument: () => ({ dispose: () => undefined }),
	registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
	openTextDocument: () => Promise.reject(new Error("not implemented")),
	applyEdit: () => Promise.resolve(false),
	getConfiguration: () => ({ get: () => undefined }),
};

const window = {
	registerTreeDataProvider: () => ({ dispose: () => undefined }),
	registerCustomEditorProvider: () => ({ dispose: () => undefined }),
	createOutputChannel: () => ({
		error: () => undefined,
		info: () => undefined,
		warn: () => undefined,
		debug: () => undefined,
		trace: () => undefined,
		append: () => undefined,
		appendLine: () => undefined,
		clear: () => undefined,
		show: () => undefined,
		hide: () => undefined,
		dispose: () => undefined,
		replace: () => undefined,
		name: "Weld",
		logLevel: 0,
		onDidChangeLogLevel: () => ({ dispose: () => undefined }),
	}),
	showInformationMessage: () => Promise.resolve(undefined),
	showWarningMessage: () => Promise.resolve(undefined),
	showErrorMessage: () => Promise.resolve(undefined),
	showTextDocument: () => Promise.resolve(undefined),
	withProgress: (
		_options: unknown,
		task: (progress: {
			report: (value: { message?: string }) => void;
		}) => Promise<void>,
	) => task({ report: () => undefined }),
	activeTextEditor: undefined,
};

const commands = {
	executeCommand: () => Promise.resolve(undefined),
	registerCommand: () => ({ dispose: () => undefined }),
};

const extensions = {
	getExtension: () => {
		const gitExtension = {
			enabled: true,
			onDidChangeEnablement: () => ({ dispose: () => undefined }),
			getAPI: () => ({
				git: { path: "git" },
				state: "initialized",
				repositories: [],
				onDidChangeState: () => ({ dispose: () => undefined }),
				onDidOpenRepository: () => ({ dispose: () => undefined }),
				onDidCloseRepository: () => ({ dispose: () => undefined }),
				getRepository: () => null,
				getRepositoryRoot: () => Promise.resolve(null),
				openRepository: () => Promise.resolve(null),
				toGitUri: (uri: Uri) => uri,
			}),
		};
		return {
			isActive: true,
			exports: gitExtension,
			activate: () => Promise.resolve(gitExtension),
		};
	},
};

class WorkspaceEdit {
	replace(): void {
		return;
	}
}

class Range {
	readonly startLine: number;
	readonly startCharacter: number;
	readonly endLine: number;
	readonly endCharacter: number;

	constructor(
		startLine: number,
		startCharacter: number,
		endLine: number,
		endCharacter: number,
	) {
		this.startLine = startLine;
		this.startCharacter = startCharacter;
		this.endLine = endLine;
		this.endCharacter = endCharacter;
	}
}

const ProgressLocation = Object.freeze(
	Object.fromEntries([["Notification", 15]]),
) as Record<string, number>;

const ViewColumn = Object.freeze(
	Object.fromEntries([["Active", -1]]),
) as Record<string, number>;

class Disposable {
	private readonly callback: () => void;

	constructor(callback: () => void) {
		this.callback = callback;
	}

	static from(...items: Array<{ dispose(): void }>): Disposable {
		return new Disposable(() => {
			for (const item of items) {
				item.dispose();
			}
		});
	}

	dispose(): void {
		this.callback();
	}
}

export {
	commands,
	Disposable,
	EventEmitter,
	extensions,
	FileType,
	ProgressLocation,
	Range,
	ThemeIcon,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	ViewColumn,
	WorkspaceEdit,
	window,
	workspace,
};
