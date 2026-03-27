import { type PropsWithChildren, useLayoutEffect, useState } from "react";
import { ANIMATION_TRANSITION } from "./types.ts";

export const AnimatedColumn = ({
	isOpen,
	children,
	side,
	textColumns,
	textColumnsAfterAnimation,
	id,
}: PropsWithChildren<{
	isOpen: boolean;
	side: "left" | "right";
	textColumns: number;
	textColumnsAfterAnimation: number;
	id?: string;
}>) => {
	const [active, setActive] = useState(false);

	useLayoutEffect(() => {
		let cleanup: (() => void) | undefined;
		if (isOpen) {
			// Double RAF to ensure the "off-screen" layout is painted
			// before the transition to active=true starts.
			const raf1 = requestAnimationFrame(() => {
				const raf2 = requestAnimationFrame(() => {
					setActive(true);
				});
				cleanup = () => {
					cancelAnimationFrame(raf2);
				};
			});
			return () => {
				cancelAnimationFrame(raf1);
				if (cleanup) {
					cleanup();
				}
			};
		}
		setActive(false);
		return;
	}, [isOpen]);

	const div = isOpen ? textColumns : textColumnsAfterAnimation;
	const marginValue = active
		? "0"
		: `calc(-1 * ((100% + var(--weld-diff-width)) / ${div || 1}))`;

	return (
		<div
			id={id}
			style={{
				display: "flex",
				overflow: "hidden",
				marginLeft: side === "left" ? marginValue : 0,
				marginRight: side === "right" ? marginValue : 0,
				transition: ANIMATION_TRANSITION,
				flex: 1,
			}}
		>
			{children}
		</div>
	);
};
