import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import * as React from "react";
import { useVSCodeMessageBus } from "./useVSCodeMessageBus";

export function useClipboardOverrides(
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
) {
	const vscodeApi = useVSCodeMessageBus();
	const clipboardPendingRef = React.useRef<Map<number, (text: string) => void>>(
		new Map(),
	);
	const clipboardRequestIdRef = React.useRef(0);

	const requestClipboardText = React.useCallback((): Promise<string> => {
		const id = ++clipboardRequestIdRef.current;
		return new Promise<string>((resolve) => {
			clipboardPendingRef.current.set(id, resolve);
			vscodeApi?.postMessage({ command: "readClipboard", requestId: id });
			// Fallback: if not in a webview, try the browser clipboard directly
			if (!vscodeApi) {
				navigator.clipboard
					.readText()
					.then(resolve)
					.catch(() => resolve(""));
			}
		});
	}, [vscodeApi]);

	const writeClipboardText = React.useCallback(
		(text: string) => {
			vscodeApi?.postMessage({ command: "writeClipboard", text });
			if (!vscodeApi) {
				navigator.clipboard.writeText(text).catch(() => {});
			}
		},
		[vscodeApi],
	);

	const resolveClipboardRead = React.useCallback(
		(requestId: number, text: string) => {
			const resolve = clipboardPendingRef.current.get(requestId);
			if (resolve) {
				clipboardPendingRef.current.delete(requestId);
				resolve(text);
			}
		},
		[],
	);

	React.useEffect(() => {
		const handleClipboard = (e: ClipboardEvent) => {
			const activeEditor = editorRefs.current.find((ed) =>
				ed?.hasWidgetFocus(),
			);
			if (!activeEditor) return;

			if (e.type === "paste") {
				if (!activeEditor.getOption(monaco.editor.EditorOption.readOnly)) {
					e.preventDefault();
					requestClipboardText().then((text) => {
						activeEditor.trigger("keyboard", "paste", { text });
					});
				}
				return;
			}

			// Copy or Cut
			const selection = activeEditor.getSelection();
			if (!selection) return;

			const model = activeEditor.getModel();
			if (!model) return;

			let text = "";
			let rangeToDelete = selection;

			if (!selection.isEmpty()) {
				text = model.getValueInRange(selection);
			} else {
				// Empty selection: copy/cut the whole line (matching native behavior)
				const line = selection.startLineNumber;
				text = `${model.getLineContent(line)}\n`;
				rangeToDelete = new monaco.Selection(line, 1, line + 1, 1);
			}

			if (text) {
				e.preventDefault();
				writeClipboardText(text);
				if (
					e.type === "cut" &&
					!activeEditor.getOption(monaco.editor.EditorOption.readOnly)
				) {
					activeEditor.executeEdits("cut", [
						{ range: rangeToDelete, text: "" },
					]);
				}
			}
		};

		document.addEventListener("copy", handleClipboard);
		document.addEventListener("cut", handleClipboard);
		document.addEventListener("paste", handleClipboard);

		return () => {
			document.removeEventListener("copy", handleClipboard);
			document.removeEventListener("cut", handleClipboard);
			document.removeEventListener("paste", handleClipboard);
		};
	}, [editorRefs, requestClipboardText, writeClipboardText]);

	return { resolveClipboardRead, requestClipboardText, writeClipboardText };
}
