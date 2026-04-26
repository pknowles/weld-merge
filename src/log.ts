import { type LogOutputChannel, window } from "vscode";

let weldLogChannel: LogOutputChannel | null = null;

function initializeWeldLogChannel(): LogOutputChannel {
	if (!weldLogChannel) {
		weldLogChannel = window.createOutputChannel("Weld", { log: true });
	}
	return weldLogChannel;
}

function getWeldLogChannel(): LogOutputChannel {
	if (!weldLogChannel) {
		throw new Error("Weld log channel has not been initialized.");
	}
	return weldLogChannel;
}

export { getWeldLogChannel, initializeWeldLogChannel };
