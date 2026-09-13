import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../src/webview/ui/ErrorBoundary.tsx";
import { ThrowOnRender } from "./helpers/ThrowOnRender.tsx";

const ERROR_MESSAGE_PATTERN = /test explosion/;
const noop = (..._args: unknown[]) => undefined;

const originalConsoleError = console.error;
beforeEach(() => {
	console.error = noop;
});
afterEach(() => {
	console.error = originalConsoleError;
});

describe("ErrorBoundary", () => {
	it("renders children when no error is thrown", () => {
		render(
			<ErrorBoundary>
				<span>safe content</span>
			</ErrorBoundary>,
		);
		expect(screen.getByText("safe content")).toBeDefined();
	});

	it("renders fallback UI instead of children when child throws", () => {
		render(
			<ErrorBoundary>
				<ThrowOnRender />
			</ErrorBoundary>,
		);
		expect(screen.queryByText("safe content")).toBeNull();
		expect(screen.getByText("Something went wrong.")).toBeDefined();
	});

	it("includes the error message in the fallback output", () => {
		render(
			<ErrorBoundary>
				<ThrowOnRender />
			</ErrorBoundary>,
		);
		expect(screen.getByText(ERROR_MESSAGE_PATTERN)).toBeDefined();
	});
});
