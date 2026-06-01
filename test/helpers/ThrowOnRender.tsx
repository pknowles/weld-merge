import { type ReactNode, useState } from "react";

export function ThrowOnRender({ children }: { children?: ReactNode }) {
	useState<null>(() => {
		throw new Error("test explosion");
	});
	return <>{children}</>;
}
