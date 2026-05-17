declare module "xvfb" {
	interface XvfbOptions {
		readonly silent?: boolean;
	}

	class Xvfb {
		constructor(options: XvfbOptions);
		startSync(): void;
		stopSync(): void;
	}

	export = Xvfb;
}
