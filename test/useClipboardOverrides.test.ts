import { describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import { useClipboardOverrides } from "../src/webview/ui/useClipboardOverrides.ts";

// Stub useVscodeMessageBus so tests control whether VS Code API is present.
const mockPostMessage = jest.fn<(msg: unknown) => void>();
let mockVscodeApi: { postMessage: (msg: unknown) => void } | null = null;

jest.mock("../src/webview/ui/useVSCodeMessageBus.ts", () => ({
	useVscodeMessageBus: () => mockVscodeApi,
}));

// Stub navigator.clipboard for the browser-fallback path.
const mockReadText = jest.fn<() => Promise<string>>();
const mockWriteText = jest.fn<(text: string) => Promise<void>>();
Object.defineProperty(navigator, "clipboard", {
	value: { readText: mockReadText, writeText: mockWriteText },
	configurable: true,
});

function makeHook() {
	return renderHook(() => useClipboardOverrides({ current: [] } as never));
}

describe("useClipboardOverrides / VS Code path", () => {
	beforeEach(() => {
		mockVscodeApi = { postMessage: mockPostMessage };
		mockPostMessage.mockClear();
	});

	it("requestClipboardText sends readClipboard postMessage with a request ID", async () => {
		const { result } = makeHook();

		let promise: Promise<string> = Promise.resolve("");
		act(() => {
			promise = result.current.requestClipboardText();
		});

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({ command: "readClipboard" }),
		);
		const call = mockPostMessage.mock.calls[0]?.[0] as {
			requestId: number;
		};
		expect(typeof call.requestId).toBe("number");

		// Resolve so the promise doesn't leak.
		act(() => {
			result.current.resolveClipboardRead(
				call.requestId,
				"clipboard text",
			);
		});
		expect(await (promise as Promise<string>)).toBe("clipboard text");
	});

	it("resolveClipboardRead resolves the pending promise with the given text", async () => {
		const { result } = makeHook();

		let resolve!: Promise<string>;
		act(() => {
			resolve = result.current.requestClipboardText();
		});
		const id = (mockPostMessage.mock.calls[0]?.[0] as { requestId: number })
			.requestId;

		act(() => {
			result.current.resolveClipboardRead(id, "hello");
		});
		expect(await resolve).toBe("hello");
	});

	it("unknown request ID does not crash or resolve anything", () => {
		const { result } = makeHook();
		expect(() => {
			act(() => {
				result.current.resolveClipboardRead(99_999, "orphan");
			});
		}).not.toThrow();
	});

	it("writeClipboardText sends writeClipboard postMessage with the text", async () => {
		const { result } = makeHook();
		await act(async () => {
			await result.current.writeClipboardText("copied!");
		});
		expect(mockPostMessage).toHaveBeenCalledWith({
			command: "writeClipboard",
			text: "copied!",
		});
	});

	it("each request gets a unique incrementing ID", () => {
		const { result } = makeHook();

		act(() => {
			result.current.requestClipboardText();
			result.current.requestClipboardText();
		});

		const ids = mockPostMessage.mock.calls.map(
			(c) => (c[0] as { requestId: number }).requestId,
		);
		const id0 = ids[0] ?? 0;
		const id1 = ids[1] ?? 0;
		expect(id0).not.toBe(id1);
		expect(id1 - id0).toBe(1);
	});
});

describe("useClipboardOverrides / browser fallback path", () => {
	beforeEach(() => {
		mockVscodeApi = null;
		mockReadText.mockClear();
		mockWriteText.mockClear();
		mockPostMessage.mockClear();
	});

	it("requestClipboardText uses navigator.clipboard when no VS Code API", async () => {
		mockReadText.mockResolvedValue("browser clipboard");
		const { result } = makeHook();

		let text!: string;
		await act(async () => {
			text = await result.current.requestClipboardText();
		});
		expect(mockReadText).toHaveBeenCalled();
		expect(text).toBe("browser clipboard");
	});

	it("writeClipboardText uses navigator.clipboard when no VS Code API", async () => {
		mockWriteText.mockResolvedValue(undefined);
		const { result } = makeHook();

		await act(async () => {
			await result.current.writeClipboardText("browser write");
		});
		expect(mockWriteText).toHaveBeenCalledWith("browser write");
	});

	it("requestClipboardText resolves empty string when clipboard read fails", async () => {
		mockReadText.mockRejectedValue(new Error("denied"));
		const { result } = makeHook();

		let text!: string;
		await act(async () => {
			text = await result.current.requestClipboardText();
		});
		expect(text).toBe("");
	});
});
