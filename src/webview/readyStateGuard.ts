import type { WebviewPayload } from "./ui/types.ts";

export interface ReadyState {
	snapshot: WebviewPayload["data"] | null;
	handled: boolean;
	handling: boolean;
}

export const assertReadyMessageIsFirst = (
	readyState: ReadyState,
	documentUri: string,
): void => {
	if (readyState.handling || readyState.handled) {
		throw new Error(
			`Unexpected duplicate ready message for ${documentUri}.`,
		);
	}
};
