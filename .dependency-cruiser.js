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
			to: { resolvable: false },
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
