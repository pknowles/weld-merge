import { Selection, editor } from "monaco-editor";
import React from "react";
import { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

export function useClipboardOverrides(
	editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
) {
	const vscodeApi = useVscodeMessageBus();
	const clipboardPendingRef = React.useRef<
		Map<number, (text: string) => void>
	>(new Map());
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
				navigator.clipboard.writeText(text).catch(() => {
					// resolve failing is not a critical error
				});
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
			if (!activeEditor) {
				return;
			}

			if (e.type === "paste") {
				if (!activeEditor.getOption(editor.EditorOption.readOnly)) {
					e.preventDefault();
					requestClipboardText().then((text) => {
						activeEditor.trigger("keyboard", "paste", { text });
					});
				}
				return;
			}

			// Copy or Cut
			const selection = activeEditor.getSelection();
			if (!selection) {
				return;
			}

			const model = activeEditor.getModel();
			if (!model) {
				return;
			}

			let text = "";
			let rangeToDelete = selection;

			if (selection.isEmpty()) {
				// Empty selection: copy/cut the whole line (matching native behavior)
				const line = selection.startLineNumber;
				text = `${model.getLineContent(line)}\n`;
				rangeToDelete = new Selection(line, 1, line + 1, 1);
			} else {
				text = model.getValueInRange(selection);
			}

			if (text) {
				e.preventDefault();
				writeClipboardText(text);
				if (
					e.type === "cut" &&
					!activeEditor.getOption(editor.EditorOption.readOnly)
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
