import { readFileSync, statSync } from "node:fs";

type CommandCallback = (...args: unknown[]) => unknown;
type MessageImplementation = (
	message: string,
	...items: unknown[]
) => Promise<unknown>;
type ProgressTask = (progress: {
	report: (value: { message?: string }) => void;
}) => Promise<unknown>;
type OpenTextDocumentImplementation = (uri: Uri) => Promise<unknown>;
type ApplyEditImplementation = (edit: WorkspaceEdit) => Promise<boolean>;

interface MockTextDocument {
	readonly uri: Uri;
	readonly isUntitled: boolean;
	getText(): string;
	positionAt(offset: number): unknown;
	save(): Promise<boolean>;
}

const registeredCommands = new Map<string, CommandCallback>();
const progressReports: Array<{ message?: string }> = [];
const saveTextDocumentListeners: Array<(document: unknown) => void> = [];

const mockLogChannel = {
	errors: [] as string[],
	infos: [] as string[],
	warnings: [] as string[],
	debugs: [] as string[],
	traces: [] as string[],
	shown: 0,
	error(message: string): void {
		this.errors.push(message);
	},
	info(message: string): void {
		this.infos.push(message);
	},
	warn(message: string): void {
		this.warnings.push(message);
	},
	debug(message: string): void {
		this.debugs.push(message);
	},
	trace(message: string): void {
		this.traces.push(message);
	},
	append(): void {
		return;
	},
	appendLine(): void {
		return;
	},
	clear(): void {
		this.errors = [];
		this.infos = [];
		this.warnings = [];
		this.debugs = [];
		this.traces = [];
	},
	show(): void {
		this.shown += 1;
	},
	hide(): void {
		return;
	},
	dispose(): void {
		return;
	},
	replace(): void {
		return;
	},
	name: "Weld",
	logLevel: 0,
	onDidChangeLogLevel: () => ({ dispose: () => undefined }),
};

let showInformationMessageImpl: MessageImplementation = () =>
	Promise.resolve(undefined);
let showWarningMessageImpl: MessageImplementation = () =>
	Promise.resolve(undefined);
let showErrorMessageImpl: MessageImplementation = () =>
	Promise.resolve(undefined);
let executeCommandImpl: CommandCallback = () => Promise.resolve(undefined);
let openTextDocumentImpl: OpenTextDocumentImplementation = () =>
	Promise.reject(new Error("not implemented"));
let applyEditImpl: ApplyEditImplementation = () => Promise.resolve(false);
let configurationValues = new Map<string, unknown>();
let activeTextEditorValue: unknown;
let getExtensionImpl: (extensionId: string) => unknown;

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

	with(change: { scheme?: string; path?: string; query?: string }): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.path ?? this.path,
			change.query ?? this.query,
		);
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
		return {
			dispose: () => {
				const index = this.listeners.indexOf(listener);
				if (index !== -1) {
					this.listeners.splice(index, 1);
				}
			},
		};
	};

	fire(event: T): void {
		for (const listener of [...this.listeners]) {
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
	onDidSaveTextDocument: (listener: (document: unknown) => void) => {
		saveTextDocumentListeners.push(listener);
		return {
			dispose: () => {
				const index = saveTextDocumentListeners.indexOf(listener);
				if (index !== -1) {
					saveTextDocumentListeners.splice(index, 1);
				}
			},
		};
	},
	onDidCloseTextDocument: () => ({ dispose: () => undefined }),
	registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
	openTextDocument: (uri: Uri) => openTextDocumentImpl(uri),
	applyEdit: (edit: WorkspaceEdit) => applyEditImpl(edit),
	getConfiguration: (section: string) => ({
		get: (key: string) => configurationValues.get(`${section}.${key}`),
	}),
};

const window = {
	registerTreeDataProvider: () => ({ dispose: () => undefined }),
	registerCustomEditorProvider: () => ({ dispose: () => undefined }),
	createOutputChannel: () => mockLogChannel,
	showInformationMessage: (message: string, ...items: unknown[]) =>
		showInformationMessageImpl(message, ...items),
	showWarningMessage: (message: string, ...items: unknown[]) =>
		showWarningMessageImpl(message, ...items),
	showErrorMessage: (message: string, ...items: unknown[]) =>
		showErrorMessageImpl(message, ...items),
	showTextDocument: (uri: Uri) => Promise.resolve(uri),
	withProgress: (_options: unknown, task: ProgressTask) =>
		task({
			report: (value: { message?: string }) => {
				progressReports.push(value);
			},
		}),
	get activeTextEditor(): unknown {
		return activeTextEditorValue;
	},
	set activeTextEditor(value: unknown) {
		activeTextEditorValue = value;
	},
};

const commands = {
	executeCommand: (command: string, ...args: unknown[]) =>
		executeCommandImpl(command, ...args),
	registerCommand: (command: string, callback: CommandCallback) => {
		registeredCommands.set(command, callback);
		return {
			dispose: () => {
				registeredCommands.delete(command);
			},
		};
	},
};

function defaultGetExtension(_extensionId: string): unknown {
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
}

getExtensionImpl = defaultGetExtension;

const extensions = {
	getExtension: (extensionId: string) => getExtensionImpl(extensionId),
};

class WorkspaceEdit {
	readonly replacements: Array<{
		uri: Uri;
		range: Range;
		text: string;
	}> = [];

	replace(uri: Uri, range: Range, text: string): void {
		this.replacements.push({ uri, range, text });
	}
}

class Range {
	readonly start: unknown;
	readonly end: unknown;

	constructor(start: unknown, end: unknown) {
		this.start = start;
		this.end = end;
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

function mockVscodeGetCommand(command: string): CommandCallback {
	const callback = registeredCommands.get(command);
	if (!callback) {
		throw new Error(`Command was not registered: ${command}`);
	}
	return callback;
}

function mockVscodeSetInformationMessageResult(value: unknown): void {
	showInformationMessageImpl = () => Promise.resolve(value);
}

function mockVscodeSetWarningMessageResult(value: unknown): void {
	showWarningMessageImpl = () => Promise.resolve(value);
}

function mockVscodeSetErrorMessageResult(value: unknown): void {
	showErrorMessageImpl = () => Promise.resolve(value);
}

function mockVscodeSetOpenTextDocument(
	implementation: OpenTextDocumentImplementation,
): void {
	openTextDocumentImpl = implementation;
}

function mockVscodeSetApplyEdit(implementation: ApplyEditImplementation): void {
	applyEditImpl = implementation;
}

function mockVscodeSetExecuteCommand(implementation: CommandCallback): void {
	executeCommandImpl = implementation;
}

function mockVscodeSetConfiguration(values: Map<string, unknown>): void {
	configurationValues = new Map(values);
}

function mockVscodeSetActiveTextEditor(editor: unknown): void {
	activeTextEditorValue = editor;
}

function mockVscodeSetGetExtension(
	implementation: (extensionId: string) => unknown,
): void {
	getExtensionImpl = implementation;
}

function mockVscodeProgressReports(): Array<{ message?: string }> {
	return progressReports;
}

function mockVscodeFireDidSaveTextDocument(document: unknown): void {
	for (const listener of [...saveTextDocumentListeners]) {
		listener(document);
	}
}

function mockVscodeLogChannel(): typeof mockLogChannel {
	return mockLogChannel;
}

function mockVscodeReset(): void {
	registeredCommands.clear();
	progressReports.length = 0;
	saveTextDocumentListeners.length = 0;
	mockLogChannel.clear();
	mockLogChannel.shown = 0;
	showInformationMessageImpl = () => Promise.resolve(undefined);
	showWarningMessageImpl = () => Promise.resolve(undefined);
	showErrorMessageImpl = () => Promise.resolve(undefined);
	executeCommandImpl = () => Promise.resolve(undefined);
	openTextDocumentImpl = () => Promise.reject(new Error("not implemented"));
	applyEditImpl = () => Promise.resolve(false);
	configurationValues = new Map();
	activeTextEditorValue = undefined;
	getExtensionImpl = defaultGetExtension;
}

export {
	commands,
	Disposable,
	EventEmitter,
	extensions,
	FileType,
	type MockTextDocument,
	mockVscodeFireDidSaveTextDocument,
	mockVscodeGetCommand,
	mockVscodeLogChannel,
	mockVscodeProgressReports,
	mockVscodeReset,
	mockVscodeSetActiveTextEditor,
	mockVscodeSetApplyEdit,
	mockVscodeSetConfiguration,
	mockVscodeSetErrorMessageResult,
	mockVscodeSetExecuteCommand,
	mockVscodeSetGetExtension,
	mockVscodeSetInformationMessageResult,
	mockVscodeSetOpenTextDocument,
	mockVscodeSetWarningMessageResult,
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
