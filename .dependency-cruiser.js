/** @type {import('dependency-cruiser').IConfiguration} */
export default {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment: "Warns on cyclic dependencies",
			from: {},
			to: { circular: true },
		},
		{
			name: "not-to-unresolvable",
			comment: "Cannot resolve the module",
			severity: "error",
			from: {},
			to: { couldNotResolve: true },
		},
		{
			name: "no-orphans",
			severity: "error",
			from: { orphan: true },
			to: {},
		},
		// Core must not depend on UI
		{
			name: "core-no-webview-deps",
			severity: "error",
			from: {
				path: "^src/(repoContext|gitUtils|gitPath|matchers|log)\\/",
			},
			to: {
				path: "^src/webview",
			},
		},

		// Matchers must stay pure (no UI / vscode / webview)
		{
			name: "matchers-are-pure",
			severity: "error",
			from: {
				path: "^src/matchers/",
			},
			to: {
				path: "^src/(webview|treeView|extension)",
			},
		},

		// Webview UI cannot touch core internals directly
		{
			name: "webview-ui-no-core-leaks",
			severity: "error",
			from: {
				path: "^src/webview/ui/",
			},
			to: {
				path: "^src/(repoContext|gitUtils|gitPath)",
			},
		},

		// Prevent UI importing extension entry point
		{
			name: "ui-no-extension-import",
			severity: "error",
			from: {
				path: "^src/webview/",
			},
			to: {
				path: "^src/extension",
			},
		},
	],
	options: {
		doNotFollow: {
			path: "node_modules",
			dependencyTypes: [
				"npm",
				"npm-dev",
				"npm-optional",
				"npm-peer",
				"npm-bundled",
				"npm-no-pkg",
			],
		},
		tsPreCompilationDeps: true,
		tsConfig: {
			fileName: "tsconfig.json",
		},
	},
};
