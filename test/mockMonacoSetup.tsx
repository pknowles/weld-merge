import { jest } from "@jest/globals";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";
import { createMockEditor } from "./mockEditor.ts";

interface MockedEditorProps {
	onMount?: (ed: ReturnType<typeof createMockEditor>) => void;
	value?: string;
	defaultValue?: string;
	options?: { readOnly?: boolean };
}

interface MountedEditorEntry {
	mock: ReturnType<typeof createMockEditor>;
	props: MockedEditorProps;
}

const mountedEditorsStore: MountedEditorEntry[] = [];

const normalizeMockedEditorProps = (
	onMount?: MockedEditorProps["onMount"],
	value?: MockedEditorProps["value"],
	defaultValue?: MockedEditorProps["defaultValue"],
	options?: MockedEditorProps["options"],
): MockedEditorProps => {
	const normalized: MockedEditorProps = {};
	if (onMount !== undefined) {
		normalized.onMount = onMount;
	}
	if (value !== undefined) {
		normalized.value = value;
	}
	if (defaultValue !== undefined) {
		normalized.defaultValue = defaultValue;
	}
	if (options !== undefined) {
		normalized.options = options;
	}
	return normalized;
};

const createMonacoMockImpl = () => {
	const mock = {} as unknown as typeof import("monaco-editor");

	const mockEditor = {} as typeof editor;
	Object.defineProperty(mock, "editor", { value: mockEditor });

	Object.defineProperty(mockEditor, "EditorOption", {
		value: { lineHeight: 1, readOnly: 1 },
	});

	Object.defineProperty(mock, "Selection", {
		value: {
			createWithSelection() {
				return {};
			},
		},
	});

	const mockKeyMod = {};
	Object.defineProperty(mockKeyMod, "Alt", { value: 512 });
	Object.defineProperty(mockKeyMod, "CtrlCmd", { value: 2048 });
	Object.defineProperty(mock, "KeyMod", { value: mockKeyMod });

	const mockKeyCode = {};
	Object.defineProperty(mockKeyCode, "KeyJ", { value: 40 });
	Object.defineProperty(mockKeyCode, "KeyK", { value: 41 });
	Object.defineProperty(mockKeyCode, "Alt", { value: 512 });
	Object.defineProperty(mockKeyCode, "UpArrow", { value: 1 });
	Object.defineProperty(mockKeyCode, "DownArrow", { value: 2 });
	Object.defineProperty(mockKeyCode, "KeyC", { value: 3 });
	Object.defineProperty(mockKeyCode, "KeyX", { value: 4 });
	Object.defineProperty(mockKeyCode, "KeyV", { value: 5 });
	Object.defineProperty(mock, "KeyCode", { value: mockKeyCode });

	Object.defineProperty(mockEditor, "IStandaloneCodeEditor", { value: {} });

	return mock;
};

const createMonacoReactMockComponentImpl = () =>
	function MockedEditor(props: MockedEditorProps) {
		const { defaultValue, onMount, options, value } = props;
		const editorRef = useRef<ReturnType<typeof createMockEditor> | null>(
			null,
		);
		const entryRef = useRef<MountedEditorEntry | null>(null);

		if (editorRef.current && value !== undefined) {
			editorRef.current.setValue(value);
		}

		useEffect(() => {
			if (onMount && !editorRef.current) {
				const mock = createMockEditor(value || defaultValue || "");
				editorRef.current = mock;
				const entry: MountedEditorEntry = {
					mock,
					props: normalizeMockedEditorProps(
						onMount,
						value,
						defaultValue,
						options,
					),
				};
				mountedEditorsStore.push(entry);
				entryRef.current = entry;
				onMount(mock);
			}
		}, [defaultValue, onMount, options, value]);

		if (entryRef.current) {
			entryRef.current.props = normalizeMockedEditorProps(
				onMount,
				value,
				defaultValue,
				options,
			);
		}

		return <div data-testid="monaco-editor" />;
	};

const createVscodeStubImpl = () => {
	const messagesSent: unknown[] = [];
	const postMessage = jest.fn((msg: unknown) => {
		messagesSent.push(msg);
	});
	const getState = jest.fn((): unknown => ({}));
	const setState = jest.fn((_state: unknown) => undefined);
	return { postMessage, getState, setState, messagesSent };
};

const installResizeObserverMockImpl = (): void => {
	global.ResizeObserver = class ResizeObserver {
		observe() {
			/* mock */
		}
		unobserve() {
			/* mock */
		}
		disconnect() {
			/* mock */
		}
	};
};

const installVscodeApiImpl = <
	T extends ReturnType<typeof createVscodeStubImpl>,
>(
	stub: T,
): void => {
	(window as unknown as { acquireVsCodeApi: () => T }).acquireVsCodeApi =
		() => stub;
};

const uninstallVscodeApiImpl = (): void => {
	(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi =
		undefined;
};

const resetMountedEditorsImpl = (): void => {
	mountedEditorsStore.length = 0;
};

export type VscodeStub = ReturnType<typeof createVscodeStubImpl>;
export {
	createMonacoMockImpl as createMonacoMock,
	createMonacoReactMockComponentImpl as createMonacoReactMockComponent,
	createVscodeStubImpl as createVscodeStub,
	installResizeObserverMockImpl as installResizeObserverMock,
	installVscodeApiImpl as installVscodeApi,
	mountedEditorsStore as mountedEditors,
	resetMountedEditorsImpl as resetMountedEditors,
	uninstallVscodeApiImpl as uninstallVscodeApi,
};
