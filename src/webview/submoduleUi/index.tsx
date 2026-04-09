// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { createRoot } from "react-dom/client";
import { SubmoduleApp } from "./SubmoduleApp.tsx";

const rootElement = document.getElementById("root");
if (rootElement) {
	const root = createRoot(rootElement);
	root.render(<SubmoduleApp />);
}
