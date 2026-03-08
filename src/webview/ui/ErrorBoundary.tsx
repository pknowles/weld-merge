// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	children?: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
}

const ERROR_TITLE = "Something went wrong.";

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error, errorInfo: null };
	}

	override componentDidCatch(_error: Error, errorInfo: ErrorInfo) {
		this.setState({ errorInfo });
	}

	override render() {
		if (this.state.hasError) {
			return (
				<div
					style={{
						padding: "20px",
						color: "white",
						backgroundColor: "#333",
						height: "100vh",
						overflow: "auto",
					}}
				>
					<h1>{ERROR_TITLE}</h1>
					<pre style={{ color: "red" }}>
						{this.state.error?.toString()}
					</pre>
					<pre style={{ fontSize: "12px", whiteSpace: "pre-wrap" }}>
						{this.state.errorInfo?.componentStack}
					</pre>
				</div>
			);
		}

		return this.props.children;
	}
}
