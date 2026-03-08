// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { loader } from "@monaco-editor/react";
// biome-ignore lint/performance/noNamespaceImport: The monaco-editor loader requires the full namespace for proper configuration.
import * as monaco from "monaco-editor";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";

declare global {
	interface Window {
		/* biome-ignore lint/style/useNamingConvention: MonacoEnvironment is a standard Monaco global. */
		MonacoEnvironment?: monaco.Environment;
	}
}

window.MonacoEnvironment = {
	getWorker: (_moduleId, _label) => {
		// Provide a dummy worker to prevent Monaco trying to fetch language workers
		// from its default relative CDN, which would cause an error in VS Code webviews.
		// Since we only use basic syntax highlighting, we don't need language workers.
		const blob = new Blob(["/* dummy worker */"], {
			type: "text/javascript",
		});
		return new Worker(URL.createObjectURL(blob));
	},
};

loader.config({ monaco });

const container = document.getElementById("root");
if (container) {
	const root = createRoot(container);
	root.render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
