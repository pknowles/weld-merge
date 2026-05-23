// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { createRoot } from "react-dom/client";
import { SubmoduleApp } from "./SubmoduleApp.tsx";
import type {} from "./style.css.d.ts";
import "./style.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Missing root element for Weld submodule conflict UI.");
}

createRoot(rootElement).render(<SubmoduleApp />);
