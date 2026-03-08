interface VsCodeApi {
	postMessage: (msg: unknown) => void;
}

let vscodeApi: VsCodeApi | null = null;
try {
	vscodeApi = (
		window as unknown as { acquireVsCodeApi: () => VsCodeApi }
	).acquireVsCodeApi();
} catch {
	// Not in a VS Code webview, ignore
}

export function useVscodeMessageBus() {
	return vscodeApi;
}
