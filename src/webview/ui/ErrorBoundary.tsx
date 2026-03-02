// Copyright (C) 2026 Pyarelal Knowles, GPL v2

import * as React from "react";

interface Props {
	children: React.ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error, errorInfo: null };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("Uncaught error:", error, errorInfo);
		this.setState({ errorInfo });
	}

	render() {
		if (this.state.hasError) {
			return (
				<div style={{ padding: "20px", color: "white", backgroundColor: "#333", height: "100vh", overflow: "auto" }}>
					<h1>Something went wrong.</h1>
					<pre style={{ color: "red" }}>{this.state.error?.toString()}</pre>
					<pre style={{ fontSize: "12px", whiteSpace: "pre-wrap" }}>
						{this.state.errorInfo?.componentStack}
					</pre>
				</div>
			);
		}

		return this.props.children;
	}
}
