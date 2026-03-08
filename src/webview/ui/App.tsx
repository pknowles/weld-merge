// Copyright (C) 2002-2006 Stephen Kennedy <stevek@gnome.org>
// Copyright (C) 2009-2019 Kai Willadsen <kai.willadsen@gmail.com>
// Copyright (C) 2026 Pyarelal Knowles
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 2 of the License, or (at
// your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { diffChars } from "diff";
import debounce from "lodash.debounce";
import type { editor } from "monaco-editor";

import * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Differ } from "../../matchers/diffutil";
import { CodePane } from "./CodePane";
import { DiffCurtain } from "./DiffCurtain";
import { ErrorBoundary } from "./ErrorBoundary";
import type { BaseDiffPayload, DiffChunk, FileState, Highlight } from "./types";
import { DIFF_WIDTH } from "./types";
import { useClipboardOverrides } from "./useClipboardOverrides";
import { useSynchronizedScrolling } from "./useSynchronizedScrolling";
import { useVSCodeMessageBus } from "./useVSCodeMessageBus";

// Must match the splitLines used when initializing the Differ (in diffPayload.ts),
// which pops trailing empty strings. Module-level so it's a stable reference
// (does not need to appear in useCallback dependency arrays).
const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
};

const AnimatedColumn = ({
	isOpen,
	children,
	side,
	textColumns,
	textColumnsAfterAnimation,
	id,
}: React.PropsWithChildren<{
	isOpen: boolean;
	side: "left" | "right";
	textColumns: number;
	textColumnsAfterAnimation: number;
	id?: string;
}>) => {
	const [shouldRender, setShouldRender] = useState(isOpen);
	const [active, setActive] = useState(false);

	useLayoutEffect(() => {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		if (isOpen) {
			setShouldRender(true);
			const raf = requestAnimationFrame(() => setActive(true));
			return () => cancelAnimationFrame(raf);
		} else {
			setActive(false);
			timeoutId = setTimeout(() => setShouldRender(false), 430);
		}

		return () => {
			if (timeoutId) clearTimeout(timeoutId);
		};
	}, [isOpen]);

	const div = isOpen ? textColumns : textColumnsAfterAnimation;
	const marginValue = active
		? "0"
		: `calc(-1 * ((100% + var(--meld-diff-width)) / ${div}))`;

	if (!shouldRender && !isOpen) return null;

	return (
		<div
			id={id}
			style={{
				display: "flex",
				overflow: "hidden",
				marginLeft: side === "left" ? marginValue : 0,
				marginRight: side === "right" ? marginValue : 0,
				transition: "margin 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
				flex: 1,
			}}
		>
			{children}
		</div>
	);
};

function usePreviousNonNull<T>(value: T | null): T | null {
	const ref = useRef<T | null>(value);
	useEffect(() => {
		if (value !== null) {
			ref.current = value;
		}
	}, [value]);
	return value !== null ? value : ref.current;
}

const App: React.FC = () => {
	// files length is now always 5: [Base(left), Local, Merged, Remote, Base(right)]
	// Base slots start as null.
	const [files, setFiles] = useState<(FileState | null)[]>([]);
	const filesRef = useRef<(FileState | null)[]>([]);
	// diffs connects files 0-1, 1-2, 2-3, 3-4
	const [diffs, setDiffs] = useState<(DiffChunk[] | null)[]>([]);
	const diffsRef = useRef<(DiffChunk[] | null)[]>([]);
	const differRef = useRef<Differ | null>(null);
	const [externalSyncId, setExternalSyncId] = useState(0);
	const [debounceDelay, setDebounceDelay] = useState(300);
	const [syntaxHighlighting, setSyntaxHighlighting] = useState(true);
	const [baseCompareHighlighting, setBaseCompareHighlighting] = useState(false);
	const [smoothScrolling, setSmoothScrolling] = useState(true);
	const [renderTrigger, setRenderTrigger] = useState(0);
	const editorRefs = useRef<editor.IStandaloneCodeEditor[]>([]);

	const [renderBaseLeft, setRenderBaseLeft] = useState(!!files[0]);
	const [renderBaseRight, setRenderBaseRight] = useState(!!files[4]);

	useLayoutEffect(() => {
		if (files[0]) {
			setRenderBaseLeft(true);
		} else {
			const t = setTimeout(() => setRenderBaseLeft(false), 430);
			return () => clearTimeout(t);
		}
		return undefined;
	}, [files[0]]);

	useLayoutEffect(() => {
		if (files[4]) {
			setRenderBaseRight(true);
		} else {
			const t = setTimeout(() => setRenderBaseRight(false), 430);
			return () => clearTimeout(t);
		}
		return undefined;
	}, [files[4]]);

	const vscodeApi = useVSCodeMessageBus();
	const { resolveClipboardRead, requestClipboardText, writeClipboardText } =
		useClipboardOverrides(editorRefs);
	const { attachScrollListener, forceSyncToPane } = useSynchronizedScrolling(
		editorRefs,
		diffsRef,
		setRenderTrigger,
		smoothScrolling,
	);

	const prevBaseLeft = usePreviousNonNull(files[0] || null);
	const prevBaseLeftDiffs = usePreviousNonNull(diffs[0] || null);

	const prevBaseRight = usePreviousNonNull(files[4] || null);
	const prevBaseRightDiffs = usePreviousNonNull(diffs[3] || null);

	const commitModelUpdate = React.useCallback((value: string) => {
		// All computation must happen outside the setFiles updater.
		// Calling setDiffs() inside setFiles(updater) is illegal in React — it causes
		// diffs to become undefined for a frame, DiffCurtain early-outs to null, and
		// the entire UI goes blank.
		const files = filesRef.current;
		const localFile = files[1];
		const midFile = files[2];
		const rightFile = files[3];
		if (!files || !localFile || !midFile || !rightFile) return;

		const oldMidLines = splitLines(midFile.content);
		const newMidLines = splitLines(value);

		let newDiffs: (DiffChunk[] | null)[] | null = null;
		const differ = differRef.current;
		if (differ) {
			let startidx = 0;
			const minLen = Math.min(oldMidLines.length, newMidLines.length);
			while (
				startidx < minLen &&
				oldMidLines[startidx] === newMidLines[startidx]
			) {
				startidx++;
			}
			const sizechange = newMidLines.length - oldMidLines.length;

			const leftLines = splitLines(localFile.content);
			const rightLines = splitLines(rightFile.content);

			differ.change_sequence(1, startidx, sizechange, [
				leftLines,
				newMidLines,
				rightLines,
			]);

			const leftDiffs = differ._merge_cache
				.map((pair) => pair[0])
				.filter((c): c is NonNullable<typeof c> => c !== null);
			const rightDiffs = differ._merge_cache
				.map((pair) => pair[1])
				.filter((c): c is NonNullable<typeof c> => c !== null);
			// Replace the inner diffs [1] and [2] while keeping [0] and [3]
			newDiffs = [...diffsRef.current];
			newDiffs[1] = leftDiffs;
			newDiffs[2] = rightDiffs;
			diffsRef.current = newDiffs;
		}

		const newFiles = [...files];
		newFiles[2] = { ...midFile, content: value };
		filesRef.current = newFiles;
		setFiles(newFiles);
		if (newDiffs !== null) {
			setDiffs(newDiffs);
		}
		setRenderTrigger((p) => p + 1);
	}, []);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.command === "loadDiff") {
				// Initialize the 5-element array with nulls for the Base slots
				const initialFiles = [
					null,
					message.data.files[0],
					message.data.files[1],
					message.data.files[2],
					null,
				];
				const initialDiffs = [
					null,
					message.data.diffs[0],
					message.data.diffs[1],
					null,
				];

				filesRef.current = initialFiles;
				setFiles(initialFiles);
				setDiffs(initialDiffs);
				diffsRef.current = initialDiffs;
				// We bump externalSyncId here because a loadDiff is conceptually an external sync
				// from the extension that provides entirely new file contents we need to push into Monaco
				// via computeMinimalEdits, preserving the undo stack.
				setExternalSyncId((id) => id + 1);
				if (message.data.config?.debounceDelay !== undefined) {
					setDebounceDelay(message.data.config.debounceDelay);
				}
				if (message.data.config?.syntaxHighlighting !== undefined) {
					setSyntaxHighlighting(message.data.config.syntaxHighlighting);
				}
				if (message.data.config?.baseCompareHighlighting !== undefined) {
					setBaseCompareHighlighting(
						message.data.config.baseCompareHighlighting,
					);
				}
				if (message.data.config?.smoothScrolling !== undefined) {
					setSmoothScrolling(message.data.config.smoothScrolling);
				}

				const localLines = splitLines(message.data.files[0].content);
				const midLines = splitLines(message.data.files[1].content);
				const rightLines = splitLines(message.data.files[2].content);

				const differ = new Differ();
				const init = differ.set_sequences_iter([
					localLines,
					midLines,
					rightLines,
				]);
				let step = init.next();
				while (!step.done) {
					step = init.next();
				}
				differRef.current = differ;

				setTimeout(() => setRenderTrigger((prev) => prev + 1), 100); // HACK: gemini's approach to synchronization
			} else if (message.command === "loadBaseDiff") {
				const {
					side,
					file,
					diffs: payloadDiffs,
				} = message.data as BaseDiffPayload;

				const newFiles = [...filesRef.current];
				const fileIndex = side === "left" ? 0 : 4;
				newFiles[fileIndex] = file;
				filesRef.current = newFiles;
				setFiles(newFiles);

				const newDiffs = [...diffsRef.current];
				const diffIndex = side === "left" ? 0 : 3;
				newDiffs[diffIndex] = payloadDiffs;
				diffsRef.current = newDiffs;
				setDiffs(newDiffs);
				setTimeout(() => setRenderTrigger((prev) => prev + 1), 100); // HACK: gemini's approach to synchronization
			} else if (message.command === "updateContent") {
				setExternalSyncId((id) => id + 1);
				commitModelUpdate(message.text);
			} else if (message.command === "updateConfig") {
				if (message.config?.debounceDelay !== undefined) {
					setDebounceDelay(message.config.debounceDelay);
				}
				if (message.config?.syntaxHighlighting !== undefined) {
					setSyntaxHighlighting(message.config.syntaxHighlighting);
				}
				if (message.config?.baseCompareHighlighting !== undefined) {
					setBaseCompareHighlighting(message.config.baseCompareHighlighting);
				}
				if (message.config?.smoothScrolling !== undefined) {
					setSmoothScrolling(message.config.smoothScrolling);
				}
			} else if (message.command === "clipboardText") {
				resolveClipboardRead(message.requestId, message.text as string);
			}
		};
		window.addEventListener("message", handleMessage);

		if (vscodeApi) {
			vscodeApi.postMessage({ command: "ready" });
		}

		return () => {
			window.removeEventListener("message", handleMessage);
		};
	}, [commitModelUpdate, resolveClipboardRead, vscodeApi]);

	const handleEditorMount = (
		editor: editor.IStandaloneCodeEditor,
		index: number,
	) => {
		editorRefs.current[index] = editor;
		attachScrollListener(editor, index);

		if (index === 0) {
			setTimeout(() => {
				forceSyncToPane(1, 0);
			}, 50);
		} else if (index === 4) {
			setTimeout(() => {
				forceSyncToPane(3, 4);
			}, 50);
		}
	};

	const handleEditorChange = React.useMemo(
		() =>
			debounce((value: string | undefined, index: number) => {
				// files[2] is always the Merged index
				if (value === undefined || index !== 2) return;

				commitModelUpdate(value);

				vscodeApi?.postMessage({ command: "contentChanged", text: value });
			}, debounceDelay),
		[debounceDelay, commitModelUpdate, vscodeApi],
	);

	const getHighlights = React.useCallback(
		(paneIndex: number) => {
			const highlights: Highlight[] = [];
			const currentFiles = files;
			if (currentFiles.length < 5) return highlights;

			const processChunk = (
				chunk: DiffChunk | null,
				useA: boolean,
				otherPaneIndex: number,
			) => {
				if (!chunk || chunk.tag === "equal") return;
				const startLine = useA ? chunk.start_a : chunk.start_b;
				const endLine = useA ? chunk.end_a : chunk.end_b;

				highlights.push({
					startLine: startLine + 1,
					startColumn: 1,
					endLine: endLine,
					endColumn: 1,
					isWholeLine: true,
					tag: chunk.tag,
				});

				if (chunk.tag === "replace" && startLine < endLine) {
					const otherStartLine = useA ? chunk.start_b : chunk.start_a;
					const otherEndLine = useA ? chunk.end_b : chunk.end_a;

					const outerFile = currentFiles[otherPaneIndex];
					const innerFile = currentFiles[paneIndex];
					if (!innerFile || !outerFile) return;

					// Our text
					const myLines = splitLines(innerFile.content).slice(
						startLine,
						endLine,
					);
					const myText = myLines.join("\n") + (myLines.length > 0 ? "\n" : "");

					// Other text
					const otherLines = splitLines(outerFile.content).slice(
						otherStartLine,
						otherEndLine,
					);
					const otherText =
						otherLines.join("\n") + (otherLines.length > 0 ? "\n" : "");

					const changes = diffChars(myText, otherText);
					let currentLine = startLine + 1;
					let currentColumn = 1;

					for (const change of changes) {
						const lines = change.value.split("\n");
						const nextLine = currentLine + lines.length - 1;
						const nextColumn =
							lines.length === 1
								? currentColumn + lines[0].length
								: lines[lines.length - 1].length + 1;

						// the diffChars output is relative to myText. So removed means it's in myText but not otherText
						if (change.removed) {
							highlights.push({
								startLine: currentLine,
								startColumn: currentColumn,
								endLine: nextLine,
								endColumn: nextColumn,
								isWholeLine: false,
								tag: "replace",
							});
						}

						// We only advance our position for text that exists in myText (removed or equal)
						if (!change.added) {
							currentLine = nextLine;
							currentColumn = nextColumn;
						}
					}
				}
			};

			const isLeftBaseComparing = baseCompareHighlighting && !!currentFiles[0];
			const isRightBaseComparing = baseCompareHighlighting && !!currentFiles[4];

			// Pane 0: Base(L)
			if (paneIndex === 0 && diffs[0]) {
				diffs[0].forEach((d) => {
					processChunk(d, true, 1);
				});
			}
			// Pane 1: Local
			else if (paneIndex === 1) {
				if (isLeftBaseComparing) {
					if (diffs[0])
						diffs[0].forEach((d) => {
							processChunk(d, false, 0);
						});
				} else {
					if (diffs[1])
						diffs[1].forEach((d) => {
							processChunk(d, false, 2);
						});
				}
			}
			// Pane 2: Merged
			else if (paneIndex === 2) {
				if (diffs[1])
					diffs[1].forEach((d) => {
						processChunk(d, true, 1);
					});
				if (diffs[2])
					diffs[2].forEach((d) => {
						processChunk(d, true, 3);
					});
			}
			// Pane 3: Remote
			else if (paneIndex === 3) {
				if (isRightBaseComparing) {
					if (diffs[3])
						diffs[3].forEach((d) => {
							processChunk(d, true, 4);
						});
				} else {
					if (diffs[2])
						diffs[2].forEach((d) => {
							processChunk(d, false, 2);
						});
				}
			}
			// Pane 4: Base(R)
			else if (paneIndex === 4 && diffs[3]) {
				diffs[3].forEach((d) => {
					processChunk(d, false, 3);
				});
			}
			return highlights;
		},
		[diffs, files, baseCompareHighlighting],
	);

	const handleApplyChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[2]; // Always target Merged pane at index 2
		if (!sourceEditor || !mergedEditor) return;
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!sourceModel || !mergedModel) return;

		let sourceText = "";
		if (chunk.start_b < chunk.end_b) {
			const startLine = chunk.start_b + 1;
			const endLine = chunk.end_b;
			const maxEndLine = sourceModel.getLineCount();
			if (endLine < maxEndLine) {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine + 1,
					endColumn: 1,
				});
			} else {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: maxEndLine,
					endColumn: sourceModel.getLineMaxColumn(maxEndLine),
				});
				if (chunk.end_a < mergedModel.getLineCount() && sourceText !== "") {
					sourceText += "\n";
				}
			}
		}

		let startLine = chunk.start_a + 1;
		const endLine = chunk.end_a;
		const mergedMaxLine = mergedModel.getLineCount();

		let eLine = endLine + 1;
		let eCol = 1;
		if (endLine >= mergedMaxLine) {
			eLine = mergedMaxLine;
			eCol = mergedModel.getLineMaxColumn(mergedMaxLine);
		}

		if (startLine > mergedMaxLine) {
			startLine = mergedMaxLine;
			eLine = mergedMaxLine;
			const maxCol = mergedModel.getLineMaxColumn(mergedMaxLine);
			if (sourceText && !sourceText.startsWith("\n")) {
				sourceText = `\n${sourceText}`;
			}
			mergedEditor.executeEdits("meld-action", [
				{
					range: {
						startLineNumber: startLine,
						startColumn: maxCol,
						endLineNumber: eLine,
						endColumn: maxCol,
					},
					text: sourceText,
					forceMoveMarkers: true,
				},
			]);
			return;
		}

		mergedEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: eLine,
					endColumn: eCol,
				},
				text: sourceText,
				forceMoveMarkers: true,
			},
		]);
	};

	const handleDeleteChunk = (_paneIndex: number, chunk: DiffChunk) => {
		const mergedEditor = editorRefs.current[2];
		if (!mergedEditor) return;
		const mergedModel = mergedEditor.getModel();
		if (!mergedModel) return;

		if (chunk.start_a >= chunk.end_a) return;

		let startLine = chunk.start_a + 1;
		const endLine = chunk.end_a;
		const mergedMaxLine = mergedModel.getLineCount();

		let eLine = endLine + 1;
		let eCol = 1;
		if (endLine >= mergedMaxLine) {
			eLine = mergedMaxLine;
			eCol = mergedModel.getLineMaxColumn(mergedMaxLine);
			if (startLine > 1) {
				startLine -= 1;
				eCol = mergedModel.getLineMaxColumn(mergedMaxLine);
				mergedEditor.executeEdits("meld-action", [
					{
						range: {
							startLineNumber: startLine,
							startColumn: mergedModel.getLineMaxColumn(startLine),
							endLineNumber: eLine,
							endColumn: eCol,
						},
						text: "",
						forceMoveMarkers: true,
					},
				]);
				return;
			}
		}

		mergedEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: eLine,
					endColumn: eCol,
				},
				text: "",
				forceMoveMarkers: true,
			},
		]);
	};

	const handleCopyUpChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[2];
		if (!sourceEditor || !mergedEditor) return;
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!sourceModel || !mergedModel) return;

		let sourceText = "";
		if (chunk.start_b < chunk.end_b) {
			const startLine = chunk.start_b + 1;
			const endLine = chunk.end_b;
			const maxEndLine = sourceModel.getLineCount();
			if (endLine < maxEndLine) {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine + 1,
					endColumn: 1,
				});
			} else {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: maxEndLine,
					endColumn: sourceModel.getLineMaxColumn(maxEndLine),
				});
				sourceText += "\n";
			}
		}

		if (!sourceText) return;

		const startLine = chunk.start_a + 1;
		const maxLine = mergedModel.getLineCount();
		if (startLine > maxLine) {
			const maxCol = mergedModel.getLineMaxColumn(maxLine);
			if (!sourceText.startsWith("\n")) {
				sourceText = `\n${sourceText}`;
			}
			mergedEditor.executeEdits("meld-action", [
				{
					range: {
						startLineNumber: maxLine,
						startColumn: maxCol,
						endLineNumber: maxLine,
						endColumn: maxCol,
					},
					text: sourceText,
					forceMoveMarkers: true,
				},
			]);
			return;
		}

		mergedEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: startLine,
					endColumn: 1,
				},
				text: sourceText,
				forceMoveMarkers: true,
			},
		]);
	};

	const handleCopyDownChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[2];
		if (!sourceEditor || !mergedEditor) return;
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!sourceModel || !mergedModel) return;

		let sourceText = "";
		if (chunk.start_b < chunk.end_b) {
			const startLine = chunk.start_b + 1;
			const endLine = chunk.end_b;
			const maxEndLine = sourceModel.getLineCount();
			if (endLine < maxEndLine) {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine + 1,
					endColumn: 1,
				});
			} else {
				sourceText = sourceModel.getValueInRange({
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: maxEndLine,
					endColumn: sourceModel.getLineMaxColumn(maxEndLine),
				});
				if (chunk.end_a < mergedModel.getLineCount() && sourceText !== "") {
					sourceText += "\n";
				}
			}
		}

		if (!sourceText) return;

		const endLine = chunk.end_a;
		const maxLine = mergedModel.getLineCount();
		const insertLine = endLine + 1;

		if (insertLine > maxLine) {
			const maxCol = mergedModel.getLineMaxColumn(maxLine);
			if (sourceText && !sourceText.startsWith("\n")) {
				sourceText = `\n${sourceText}`;
			}
			mergedEditor.executeEdits("meld-action", [
				{
					range: {
						startLineNumber: maxLine,
						startColumn: maxCol,
						endLineNumber: maxLine,
						endColumn: maxCol,
					},
					text: sourceText,
					forceMoveMarkers: true,
				},
			]);
			return;
		}

		mergedEditor.executeEdits("meld-action", [
			{
				range: {
					startLineNumber: insertLine,
					startColumn: 1,
					endLineNumber: insertLine,
					endColumn: 1,
				},
				text: sourceText,
				forceMoveMarkers: true,
			},
		]);
	};

	const handleCopyHash = (hash: string) => {
		vscodeApi?.postMessage({ command: "copyHash", hash });
	};

	const handleShowDiff = (paneIndex: number) => {
		vscodeApi?.postMessage({ command: "showDiff", paneIndex });
	};

	const handleCompleteMerge = () => {
		vscodeApi?.postMessage({ command: "completeMerge" });
	};

	const handleNavigate = React.useCallback(
		(direction: "prev" | "next", type: "diff" | "conflict") => {
			const mergedEditor = editorRefs.current[2];
			if (!mergedEditor) return;

			const allChunks: DiffChunk[] = [];
			if (diffsRef.current[1]) allChunks.push(...diffsRef.current[1]);
			if (diffsRef.current[2]) allChunks.push(...diffsRef.current[2]);

			const targetChunks = allChunks.filter((c) => {
				if (c.tag === "equal") return false;
				if (type === "conflict") return c.tag === "conflict";
				return true;
			});

			if (targetChunks.length === 0) return;

			const sortedChunks = targetChunks
				.sort((a, b) => a.start_a - b.start_a)
				.filter((c, i, self) => i === 0 || c.start_a !== self[i - 1].start_a);

			const currentLine = mergedEditor.getPosition()?.lineNumber || 1;
			const currentIdx = sortedChunks.findIndex(
				(c) => c.start_a + 1 >= currentLine,
			);

			let targetChunk: DiffChunk | undefined;
			if (direction === "next") {
				if (currentIdx === -1) {
					targetChunk = sortedChunks[0];
				} else {
					const chunkAtCursor = sortedChunks[currentIdx];
					if (chunkAtCursor.start_a + 1 > currentLine) {
						targetChunk = chunkAtCursor;
					} else {
						targetChunk = sortedChunks[(currentIdx + 1) % sortedChunks.length];
					}
				}
			} else {
				if (currentIdx === -1) {
					targetChunk = sortedChunks[sortedChunks.length - 1];
				} else {
					const chunkAtCursor = sortedChunks[currentIdx];
					if (chunkAtCursor.start_a + 1 < currentLine) {
						targetChunk = chunkAtCursor;
					} else {
						targetChunk =
							sortedChunks[
								(currentIdx - 1 + sortedChunks.length) % sortedChunks.length
							];
					}
				}
			}

			if (targetChunk) {
				const line = targetChunk.start_a + 1;
				mergedEditor.revealLineInCenter(line);
				mergedEditor.setPosition({ lineNumber: line, column: 1 });
				mergedEditor.focus();
			}
		},
		[],
	);

	const toggleBaseDiff = (side: "left" | "right") => {
		const targetIndex = side === "left" ? 0 : 4;
		if (files[targetIndex]) {
			// Clear it out
			const newFiles = [...files];
			newFiles[targetIndex] = null;
			filesRef.current = newFiles;
			setFiles(newFiles);

			const newDiffs = [...diffs];
			const diffIdx = side === "left" ? 0 : 3;
			newDiffs[diffIdx] = null;
			diffsRef.current = newDiffs;
			setDiffs(newDiffs);
		} else {
			vscodeApi?.postMessage({ command: "requestBaseDiff", side });
		}
	};

	return (
		<ErrorBoundary>
			<div
				style={{
					display: "flex",
					width: "100vw",
					height: "100vh",
					flexDirection: "row",
					backgroundColor: "#1e1e1e",
					overflow: "hidden",
					...({ "--meld-diff-width": `${DIFF_WIDTH}px` } as Record<
						string,
						string
					>),
				}}
			>
				<style>{`
					.diff-insert { background-color: var(--vscode-meldMerge-diffInsertBackground, rgba(0, 200, 0, 0.15)) !important; }
					.diff-delete { background-color: var(--vscode-meldMerge-diffDeleteBackground, rgba(0, 200, 0, 0.15)) !important; }
					.diff-replace { background-color: var(--vscode-meldMerge-diffReplaceBackground, rgba(0, 100, 255, 0.15)) !important; }
					.diff-conflict { background-color: var(--vscode-meldMerge-diffConflictBackground, rgba(255, 0, 0, 0.15)) !important; }
					.diff-margin { background-color: transparent !important; }
					
					.diff-insert-margin { background-color: var(--vscode-meldMerge-diffInsertBackground, rgba(0, 200, 0, 0.15)) !important; }
					.diff-delete-margin { background-color: var(--vscode-meldMerge-diffDeleteBackground, rgba(0, 200, 0, 0.15)) !important; }
					.diff-replace-margin { background-color: var(--vscode-meldMerge-diffReplaceBackground, rgba(0, 100, 255, 0.15)) !important; }
					.diff-conflict-margin { background-color: var(--vscode-meldMerge-diffConflictBackground, rgba(255, 0, 0, 0.15)) !important; }

					.diff-replace-inline { background-color: var(--vscode-meldMerge-diffReplaceInlineBackground, rgba(0, 100, 255, 0.35)) !important; }
				`}</style>
				{files.length === 0 || files[1] === null ? (
					<div
						style={{
							color: "white",
							padding: "20px",
							fontFamily: "sans-serif",
						}}
					>
						Loading Diff...
					</div>
				) : (
					(() => {
						return [0, 1, 2, 3, 4].map((index) => {
							const peerCount = [0, 1, 2, 3, 4].filter((i) => {
								if (i === index) return false;
								if (i === 1 || i === 2 || i === 3) return !!files[i];
								if (i === 0) return renderBaseLeft;
								if (i === 4) return renderBaseRight;
								return false;
							}).length;
							const isLeftBase = index === 0;
							const isRightBase = index === 4;
							const activeFile =
								files[index] ||
								(isLeftBase
									? prevBaseLeft
									: isRightBase
										? prevBaseRight
										: null);

							if (!activeFile) return null;

							const file = activeFile;
							const isOpen = !!files[index];

							let onToggleBase: undefined | (() => void);
							let baseSide: "left" | "right" | undefined;
							let isBaseActive = false;

							if (index === 1) {
								// Local
								onToggleBase = () => toggleBaseDiff("left");
								baseSide = "left";
								isBaseActive = !!files[0];
							} else if (index === 3) {
								// Remote
								onToggleBase = () => toggleBaseDiff("right");
								baseSide = "right";
								isBaseActive = !!files[4];
							}

							// Calculate which diff segment connects to the next active pane
							let diffsForCurtain: DiffChunk[] | null | undefined = null;
							let leftEditorIdx = index;
							let rightEditorIdx = index + 1;
							let fadeOutLeft = false;
							let fadeOutRight = false;

							const isLeftBaseComparing = baseCompareHighlighting && !!files[0];
							const isRightBaseComparing =
								baseCompareHighlighting && !!files[4];

							if (index === 0 && files[1]) {
								diffsForCurtain = diffs[0] || prevBaseLeftDiffs;
								leftEditorIdx = 0;
								rightEditorIdx = 1;
								if (!isLeftBaseComparing) fadeOutRight = true;
							} else if (index === 1 && files[2]) {
								diffsForCurtain = diffs[1];
								leftEditorIdx = 1;
								rightEditorIdx = 2;
								if (isLeftBaseComparing) fadeOutLeft = true;
							} else if (index === 2 && files[3]) {
								diffsForCurtain = diffs[2];
								leftEditorIdx = 2;
								rightEditorIdx = 3;
								if (isRightBaseComparing) fadeOutRight = true;
							} else if (
								index === 3 &&
								activeFile &&
								(files[4] || renderBaseRight)
							) {
								diffsForCurtain = diffs[3] || prevBaseRightDiffs;
								leftEditorIdx = 3;
								rightEditorIdx = 4;
								if (!isRightBaseComparing) fadeOutLeft = true;
							}

							const curtainContent = diffsForCurtain &&
								editorRefs.current[leftEditorIdx] &&
								editorRefs.current[rightEditorIdx] && (
									<DiffCurtain
										diffs={diffsForCurtain}
										leftEditor={editorRefs.current[leftEditorIdx]}
										rightEditor={editorRefs.current[rightEditorIdx]}
										renderTrigger={renderTrigger}
										reversed={index === 1 || index === 3} // diffs[1] (A=2, B=1) and diff[3] (A=4, B=3) are reversed
										fadeOutLeft={fadeOutLeft}
										fadeOutRight={fadeOutRight}
										onApplyChunk={
											index === 1
												? (chunk) => handleApplyChunk(1, chunk)
												: index === 2
													? (chunk) => handleApplyChunk(3, chunk)
													: undefined
										}
										onDeleteChunk={
											index === 1 || index === 2
												? (chunk) => handleDeleteChunk(index, chunk)
												: undefined
										}
										onCopyUpChunk={
											index === 1
												? (chunk) => handleCopyUpChunk(1, chunk)
												: index === 2
													? (chunk) => handleCopyUpChunk(3, chunk)
													: undefined
										}
										onCopyDownChunk={
											index === 1
												? (chunk) => handleCopyDownChunk(1, chunk)
												: index === 2
													? (chunk) => handleCopyDownChunk(3, chunk)
													: undefined
										}
									/>
								);

							const paneContent = (
								<React.Fragment>
									<CodePane
										file={file}
										index={index}
										onMount={handleEditorMount}
										onChange={handleEditorChange}
										isMiddle={index === 2}
										highlights={getHighlights(index)}
										onCompleteMerge={
											index === 2 ? handleCompleteMerge : undefined
										}
										onCopyHash={handleCopyHash}
										onShowDiff={() => handleShowDiff(index)}
										externalSyncId={index === 2 ? externalSyncId : undefined}
										requestClipboardText={
											index === 2 ? requestClipboardText : undefined
										}
										writeClipboardText={writeClipboardText}
										syntaxHighlighting={syntaxHighlighting}
										onToggleBase={onToggleBase}
										baseSide={baseSide}
										isBaseActive={isBaseActive}
										onPrevDiff={
											index === 2
												? () => handleNavigate("prev", "diff")
												: undefined
										}
										onNextDiff={
											index === 2
												? () => handleNavigate("next", "diff")
												: undefined
										}
										onPrevConflict={
											index === 2
												? () => handleNavigate("prev", "conflict")
												: undefined
										}
										onNextConflict={
											index === 2
												? () => handleNavigate("next", "conflict")
												: undefined
										}
										autoFocusConflict={index === 2}
									/>
									{curtainContent}
								</React.Fragment>
							);

							if (isLeftBase || isRightBase) {
								// curtainContent is a sibling of AnimatedColumn, NOT inside it.
								// This ensures the animated div only contains the CodePane
								// and is the same width as all other editor columns.
								return (
									<React.Fragment key={index}>
										<AnimatedColumn
											isOpen={isOpen}
											side={isLeftBase ? "left" : "right"}
											textColumns={peerCount}
											textColumnsAfterAnimation={peerCount}
										>
											<CodePane
												file={file}
												index={index}
												onMount={handleEditorMount}
												onChange={handleEditorChange}
												isMiddle={false}
												highlights={getHighlights(index)}
												onCopyHash={handleCopyHash}
												onShowDiff={() => handleShowDiff(index)}
												writeClipboardText={writeClipboardText}
												syntaxHighlighting={syntaxHighlighting}
												onToggleBase={onToggleBase}
												baseSide={baseSide}
												isBaseActive={isBaseActive}
											/>
										</AnimatedColumn>
										{isLeftBase
											? (files[0] || renderBaseLeft) && curtainContent
											: curtainContent}
									</React.Fragment>
								);
							}

							return <React.Fragment key={index}>{paneContent}</React.Fragment>;
						});
					})()
				)}
			</div>
		</ErrorBoundary>
	);
};

export default App;
