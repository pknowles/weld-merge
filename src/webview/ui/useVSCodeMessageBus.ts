interface VsCodeApi {
	postMessage: (msg: unknown) => void;
}

let vscodeApi: VsCodeApi | null = null;

export function useVscodeMessageBus() {
	if (!vscodeApi) {
		try {
			vscodeApi = (
				window as unknown as { acquireVsCodeApi: () => VsCodeApi }
			).acquireVsCodeApi();
		} catch {
			// Not in a VS Code webview, ignore
		}
	}
	return vscodeApi;
}
