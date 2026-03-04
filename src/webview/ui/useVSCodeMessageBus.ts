interface VsCodeApi {
	postMessage: (msg: unknown) => void;
}

let vscodeApi: VsCodeApi | null = null;
try {
	vscodeApi = (
		window as unknown as { acquireVsCodeApi: () => VsCodeApi }
	).acquireVsCodeApi();
} catch (_e) {
	// Not in a VS Code webview
}

export function useVSCodeMessageBus() {
	return vscodeApi;
}
