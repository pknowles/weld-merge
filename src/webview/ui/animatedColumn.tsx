import { type PropsWithChildren, useLayoutEffect, useState } from "react";
import { ANIMATION_DURATION, ANIMATION_TRANSITION } from "./types.ts";

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
	const [shouldRender, setShouldRender] = useState(isOpen);
	const [active, setActive] = useState(false);

	useLayoutEffect(() => {
		if (isOpen) {
			setShouldRender(true);
			const raf = requestAnimationFrame(() => {
				setActive(true);
			});
			return () => {
				cancelAnimationFrame(raf);
			};
		}
		setActive(false);
		const t = setTimeout(() => {
			setShouldRender(false);
		}, ANIMATION_DURATION);
		return () => {
			clearTimeout(t);
		};
	}, [isOpen]);

	const div = isOpen ? textColumns : textColumnsAfterAnimation;
	const marginValue = active
		? "0"
		: `calc(-1 * ((100% + var(--meld-diff-width)) / ${div}))`;
	return shouldRender || isOpen ? (
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
	) : null;
};
