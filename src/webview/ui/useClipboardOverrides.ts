import type { editor } from "monaco-editor";
import React from "react";
import { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

export function useClipboardOverrides(
	_editorRefs: React.MutableRefObject<editor.IStandaloneCodeEditor[]>,
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
			if (!vscodeApi) {
				navigator.clipboard
					.readText()
					.then(resolve)
					.catch(() => resolve(""));
			}
		});
	}, [vscodeApi]);

	const writeClipboardText = React.useCallback(
		async (text: string) => {
			vscodeApi?.postMessage({ command: "writeClipboard", text });
			if (!vscodeApi) {
				try {
					await navigator.clipboard.writeText(text);
				} catch {
					/* ignore */
				}
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

	return { resolveClipboardRead, requestClipboardText, writeClipboardText };
}
