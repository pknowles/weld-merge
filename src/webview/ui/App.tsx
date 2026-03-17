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

import debounce from "lodash.debounce";
import type { editor } from "monaco-editor";

import {
	type FC,
	Fragment,
	type PropsWithChildren,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Differ } from "../../matchers/diffutil.ts";
import { CodePane } from "./CodePane.tsx";
import { DiffCurtain } from "./DiffCurtain.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { processChunk } from "./highlightUtil.ts";
import {
	type BaseDiffPayload,
	DIFF_WIDTH,
	type DiffChunk,
	DiffIndex,
	type FileState,
	type Highlight,
	PaneIndex,
} from "./types.ts";
import { useClipboardOverrides } from "./useClipboardOverrides.ts";
import { useSynchronizedScrolling } from "./useSynchronizedScrolling.ts";
import { useVscodeMessageBus } from "./useVSCodeMessageBus.ts";

const ANIMATION_DURATION = 430;
const ANIMATION_TRANSITION = "margin 0.4s cubic-bezier(0.4, 0, 0.2, 1)";
const DEFAULT_DEBOUNCE_DELAY = 300;
const INITIAL_SYNC_DELAY = 50;
const HACK_SYNC_DELAY = 100;

// Must match the splitLines used when initializing the Differ (in diffPayload.ts),
// which pops trailing empty strings. Module-level so it's a stable reference
// (does not need to appear in useCallback dependency arrays).
const splitLines = (text: string) => {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
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
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		if (isOpen) {
			setShouldRender(true);
			const raf = requestAnimationFrame(() => setActive(true));
			return () => cancelAnimationFrame(raf);
		}
		setActive(false);
		timeoutId = setTimeout(
			() => setShouldRender(false),
			ANIMATION_DURATION,
		);

		return () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	}, [isOpen]);

	const div = isOpen ? textColumns : textColumnsAfterAnimation;
	const marginValue = active
		? "0"
		: `calc(-1 * ((100% + var(--meld-diff-width)) / ${div}))`;

	if (!(shouldRender || isOpen)) {
		return null;
	}

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

function usePreviousNonNull<T>(value: T | null): T | null {
	const ref = useRef<T | null>(value);
	useEffect(() => {
		if (value !== null) {
			ref.current = value;
		}
	}, [value]);
	return value !== null ? value : ref.current;
}

type PaneFiles = [
	FileState | null,
	FileState | null,
	FileState | null,
	FileState | null,
	FileState | null,
];
type PaneDiffs = [
	DiffChunk[] | null,
	DiffChunk[] | null,
	DiffChunk[] | null,
	DiffChunk[] | null,
];

export const App: FC = () => {
	// files length is now always 5: [Base(left), Local, Merged, Remote, Base(right)]
	// Base slots start as null.
	const [files, setFiles] = useState<PaneFiles>([
		null,
		null,
		null,
		null,
		null,
	]);
	const filesRef = useRef<PaneFiles>([null, null, null, null, null]);
	// diffs connects files 0-1, 1-2, 2-3, 3-4
	const [diffs, setDiffs] = useState<PaneDiffs>([null, null, null, null]);
	const diffsRef = useRef<PaneDiffs>([null, null, null, null]);
	const differRef = useRef<Differ | null>(null);
	const [externalSyncId, setExternalSyncId] = useState(0);
	const [debounceDelay, setDebounceDelay] = useState(DEFAULT_DEBOUNCE_DELAY);
	const [syntaxHighlighting, setSyntaxHighlighting] = useState(true);
	const [baseCompareHighlighting, setBaseCompareHighlighting] =
		useState(false);
	const [smoothScrolling, setSmoothScrolling] = useState(true);
	const [renderTrigger, setRenderTrigger] = useState(0);
	const editorRefs = useRef<editor.IStandaloneCodeEditor[]>([]);
	const diffsAreReversedRef = useRef<boolean[]>([false, true, false, false]);

	const [renderBaseLeft, setRenderBaseLeft] = useState(
		Boolean(files[PaneIndex.baseLeft]),
	);
	const [renderBaseRight, setRenderBaseRight] = useState(
		Boolean(files[PaneIndex.baseRight]),
	);

	useLayoutEffect(() => {
		if (files[PaneIndex.baseLeft]) {
			setRenderBaseLeft(true);
			return;
		}
		const t = setTimeout(
			() => setRenderBaseLeft(false),
			ANIMATION_DURATION,
		);
		return () => clearTimeout(t);
	}, [files[PaneIndex.baseLeft]]);

	useLayoutEffect(() => {
		if (files[PaneIndex.baseRight]) {
			setRenderBaseRight(true);
			return;
		}
		const t = setTimeout(
			() => setRenderBaseRight(false),
			ANIMATION_DURATION,
		);
		return () => clearTimeout(t);
	}, [files[PaneIndex.baseRight]]);

	const vscodeApi = useVscodeMessageBus();
	const { resolveClipboardRead, requestClipboardText, writeClipboardText } =
		useClipboardOverrides(editorRefs);
	const { attachScrollListener, forceSyncToPane } = useSynchronizedScrolling(
		editorRefs,
		diffsRef,
		diffsAreReversedRef,
		setRenderTrigger,
		smoothScrolling,
	);

	const prevBaseLeft = usePreviousNonNull(files[PaneIndex.baseLeft] || null);
	const prevBaseLeftDiffs = usePreviousNonNull(
		diffs[DiffIndex.baseLeftToLocal] || null,
	);

	const prevBaseRight = usePreviousNonNull(
		files[PaneIndex.baseRight] || null,
	);
	const prevBaseRightDiffs = usePreviousNonNull(
		diffs[DiffIndex.remoteToBaseRight] || null,
	);

	const commitModelUpdate = useCallback((value: string) => {
		// All computation must happen outside the setFiles updater.
		// Calling setDiffs() inside setFiles(updater) is illegal in React — it causes
		// diffs to become undefined for a frame, DiffCurtain early-outs to null, and
		// the entire UI goes blank.
		const currentFiles = filesRef.current;
		const localFile = currentFiles[PaneIndex.local];
		const midFile = currentFiles[PaneIndex.merged];
		const rightFile = currentFiles[PaneIndex.remote];
		if (!(localFile && midFile && rightFile)) {
			return;
		}

		const oldMidLines = splitLines(midFile.content);
		const newMidLines = splitLines(value);

		let nextDiffs: PaneDiffs | null = null;
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

			differ.changeSequence(1, startidx, sizechange, [
				leftLines,
				newMidLines,
				rightLines,
			]);

			const dedupe = (chunks: DiffChunk[]) => {
				const seen = new Set<string>();
				return chunks.filter((c) => {
					const key = `${c.startA}-${c.endA}-${c.startB}-${c.endB}`;
					if (seen.has(key)) {
						return false;
					}
					seen.add(key);
					return true;
				});
			};

			const leftDiffs = dedupe(
				differ._mergeCache
					.map((pair) => pair[0])
					.filter((c): c is DiffChunk => c !== null),
			);
			const rightDiffs = dedupe(
				differ._mergeCache
					.map((pair) => pair[1])
					.filter((c): c is DiffChunk => c !== null),
			);
			// Replace the inner diffs [1] and [2] while keeping [0] and [3]
			nextDiffs = [...diffsRef.current];
			nextDiffs[DiffIndex.localToMerged] = leftDiffs;
			nextDiffs[DiffIndex.mergedToRemote] = rightDiffs;
			diffsRef.current = nextDiffs;
		}

		filesRef.current = [...currentFiles] as PaneFiles;
		filesRef.current[PaneIndex.merged] = { ...midFile, content: value };
		const newFiles = filesRef.current;
		setFiles(newFiles);
		if (nextDiffs !== null) {
			setDiffs(nextDiffs);
		}
		setRenderTrigger((p) => p + 1);
	}, []);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.command === "loadDiff") {
				// Initialize the 5-element array with nulls for the Base slots
				const initialFiles: PaneFiles = [
					null,
					message.data.files[0],
					message.data.files[1],
					message.data.files[2],
					null,
				];
				initialFiles[PaneIndex.baseLeft] = null;
				initialFiles[PaneIndex.local] = message.data.files[0];
				initialFiles[PaneIndex.merged] = message.data.files[1];
				initialFiles[PaneIndex.remote] = message.data.files[2];
				initialFiles[PaneIndex.baseRight] = null;

				const initialDiffs: PaneDiffs = [
					null,
					message.data.diffs[0],
					message.data.diffs[1],
					null,
				];
				initialDiffs[DiffIndex.baseLeftToLocal] = null;
				initialDiffs[DiffIndex.localToMerged] = message.data.diffs[0];
				initialDiffs[DiffIndex.mergedToRemote] = message.data.diffs[1];
				initialDiffs[DiffIndex.remoteToBaseRight] = null;

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
					setSyntaxHighlighting(
						message.data.config.syntaxHighlighting,
					);
				}
				if (
					message.data.config?.baseCompareHighlighting !== undefined
				) {
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
				const diffInit = differ.setSequencesIter([
					localLines,
					midLines,
					rightLines,
				]);
				let step = diffInit.next();
				while (!step.done) {
					step = diffInit.next();
				}
				differRef.current = differ;

				setTimeout(
					() => setRenderTrigger((prev) => prev + 1),
					HACK_SYNC_DELAY,
				); // HACK: gemini's approach to synchronization
			} else if (message.command === "loadBaseDiff") {
				const {
					side,
					file,
					diffs: payloadDiffs,
				} = message.data as BaseDiffPayload;

				const newFiles = [...filesRef.current] as PaneFiles;
				const fileIndex =
					side === "left" ? PaneIndex.baseLeft : PaneIndex.baseRight;
				newFiles[fileIndex] = file;
				filesRef.current = newFiles;
				setFiles(newFiles);

				const newDiffs = [...diffsRef.current] as PaneDiffs;
				const diffIndex =
					side === "left"
						? DiffIndex.baseLeftToLocal
						: DiffIndex.remoteToBaseRight;

				// Standardize: side 'left' is Base -> Local (A=Base, B=Local). Payload is A=Base, B=Local. OK.
				// side 'right' is Remote -> Base (A=Remote, B=Base). Payload is A=Remote, B=Base. OK.
				// Wait, let's double check buildBaseDiffPayload in diffPayload.ts.
				// side === "left" ? baseLines : targetLines; -> A=Base, B=Local. OK.
				// side === "right" ? baseLines : targetLines; (Wait, I need to check line 282 of diffPayload.ts)
				// diffPayload.ts:282: const seqA = side === "left" ? baseLines : targetLines;
				// side === "right" -> seqA = Remote (targetLines), seqB = Base (baseLines). A=Remote, B=Base. OK.

				newDiffs[diffIndex] = payloadDiffs;
				diffsRef.current = newDiffs;
				setDiffs(newDiffs);
				setTimeout(
					() => setRenderTrigger((prev) => prev + 1),
					HACK_SYNC_DELAY,
				); // HACK: gemini's approach to synchronization
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
					setBaseCompareHighlighting(
						message.config.baseCompareHighlighting,
					);
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

		if (index === PaneIndex.baseLeft) {
			setTimeout(() => {
				forceSyncToPane(PaneIndex.local, PaneIndex.baseLeft);
			}, INITIAL_SYNC_DELAY);
		} else if (index === PaneIndex.baseRight) {
			setTimeout(() => {
				forceSyncToPane(PaneIndex.remote, PaneIndex.baseRight);
			}, INITIAL_SYNC_DELAY);
		}
	};

	const handleEditorChange = useMemo(
		() =>
			debounce((value: string | undefined, index: number) => {
				// files[PaneIndex.merged] is always the Merged index
				if (value === undefined || index !== PaneIndex.merged) {
					return;
				}

				commitModelUpdate(value);

				vscodeApi?.postMessage({
					command: "contentChanged",
					text: value,
				});
			}, debounceDelay),
		[debounceDelay, commitModelUpdate, vscodeApi],
	);

	const getHighlights = useCallback(
		(paneIndex: number) => {
			const highlights: Highlight[] = [];
			const currentFiles = files;
			if (currentFiles.length < 5) {
				return highlights;
			}

			const isLeftBaseComparing =
				baseCompareHighlighting &&
				Boolean(currentFiles[PaneIndex.baseLeft]);
			const isRightBaseComparing =
				baseCompareHighlighting &&
				Boolean(currentFiles[PaneIndex.baseRight]);

			// Pane 0: Base(L)
			if (paneIndex === PaneIndex.baseLeft) {
				const dLocal = diffs[DiffIndex.baseLeftToLocal];
				if (dLocal) {
					for (const d of dLocal) {
						processChunk(
							highlights,
							d,
							true,
							currentFiles[PaneIndex.baseLeft],
							currentFiles[PaneIndex.local],
						);
					}
				}
			}
			// Pane 1: Local
			else if (paneIndex === PaneIndex.local) {
				if (isLeftBaseComparing) {
					const dBaseL = diffs[DiffIndex.baseLeftToLocal];
					if (dBaseL) {
						for (const d of dBaseL) {
							processChunk(
								highlights,
								d,
								false,
								currentFiles[PaneIndex.local],
								currentFiles[PaneIndex.baseLeft],
							);
						}
					}
				} else {
					const dMerged = diffs[DiffIndex.localToMerged];
					if (dMerged) {
						for (const d of dMerged) {
							processChunk(
								highlights,
								d,
								false,
								currentFiles[PaneIndex.local],
								currentFiles[PaneIndex.merged],
							);
						}
					}
				}
			}
			// Pane 2: Merged
			else if (paneIndex === PaneIndex.merged) {
				const dLocalMerged = diffs[DiffIndex.localToMerged];
				if (dLocalMerged) {
					for (const d of dLocalMerged) {
						processChunk(
							highlights,
							d,
							true,
							currentFiles[PaneIndex.merged],
							currentFiles[PaneIndex.local],
						);
					}
				}
				const dMergedRemote = diffs[DiffIndex.mergedToRemote];
				if (dMergedRemote) {
					for (const d of dMergedRemote) {
						processChunk(
							highlights,
							d,
							true,
							currentFiles[PaneIndex.merged],
							currentFiles[PaneIndex.remote],
						);
					}
				}
			}
			// Pane 3: Remote
			else if (paneIndex === PaneIndex.remote) {
				if (isRightBaseComparing) {
					const dRemoteBaseR = diffs[DiffIndex.remoteToBaseRight];
					if (dRemoteBaseR) {
						for (const d of dRemoteBaseR) {
							processChunk(
								highlights,
								d,
								true,
								currentFiles[PaneIndex.remote],
								currentFiles[PaneIndex.baseRight],
							);
						}
					}
				} else {
					const dMergedRemote = diffs[DiffIndex.mergedToRemote];
					if (dMergedRemote) {
						for (const d of dMergedRemote) {
							processChunk(
								highlights,
								d,
								false,
								currentFiles[PaneIndex.remote],
								currentFiles[PaneIndex.merged],
							);
						}
					}
				}
			}
			// Pane 4: Base(R)
			else if (paneIndex === PaneIndex.baseRight) {
				const dRemoteBaseR = diffs[DiffIndex.remoteToBaseRight];
				if (dRemoteBaseR) {
					for (const d of dRemoteBaseR) {
						processChunk(
							highlights,
							d,
							false,
							currentFiles[PaneIndex.baseRight],
							currentFiles[PaneIndex.remote],
						);
					}
				}
			}
			return highlights;
		},
		[diffs, files, baseCompareHighlighting],
	);

	const handleApplyChunk = (paneIndex: number, chunk: DiffChunk) => {
		const sourcePane = paneIndex;
		const sourceEditor = editorRefs.current[sourcePane];
		const mergedEditor = editorRefs.current[2]; // Always target Merged pane at index 2
		if (!(sourceEditor && mergedEditor)) {
			return;
		}
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!(sourceModel && mergedModel)) {
			return;
		}

		let sourceText = "";
		if (chunk.startB < chunk.endB) {
			const startLine = chunk.startB + 1;
			const endLine = chunk.endB;
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
				if (
					chunk.endA < mergedModel.getLineCount() &&
					sourceText !== ""
				) {
					sourceText += "\n";
				}
			}
		}

		let startLine = chunk.startA + 1;
		const endLine = chunk.endA;
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
		if (!mergedEditor) {
			return;
		}
		const mergedModel = mergedEditor.getModel();
		if (!mergedModel) {
			return;
		}

		if (chunk.startA >= chunk.endA) {
			return;
		}

		let startLine = chunk.startA + 1;
		const endLine = chunk.endA;
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
							startColumn:
								mergedModel.getLineMaxColumn(startLine),
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
		if (!(sourceEditor && mergedEditor)) {
			return;
		}
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!(sourceModel && mergedModel)) {
			return;
		}

		let sourceText = "";
		if (chunk.startB < chunk.endB) {
			const startLine = chunk.startB + 1;
			const endLine = chunk.endB;
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

		if (!sourceText) {
			return;
		}

		const startLine = chunk.startA + 1;
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
		if (!(sourceEditor && mergedEditor)) {
			return;
		}
		const sourceModel = sourceEditor.getModel();
		const mergedModel = mergedEditor.getModel();
		if (!(sourceModel && mergedModel)) {
			return;
		}

		let sourceText = "";
		if (chunk.startB < chunk.endB) {
			const startLine = chunk.startB + 1;
			const endLine = chunk.endB;
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
				if (
					chunk.endA < mergedModel.getLineCount() &&
					sourceText !== ""
				) {
					sourceText += "\n";
				}
			}
		}

		if (!sourceText) {
			return;
		}

		const endLine = chunk.endA;
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

	const handleNavigate = useCallback(
		(direction: "prev" | "next", type: "diff" | "conflict") => {
			const mergedEditor = editorRefs.current[2];
			if (!mergedEditor) {
				return;
			}

			const allChunks: DiffChunk[] = [];
			const d1 = diffsRef.current[1];
			if (d1) {
				allChunks.push(...d1);
			}
			const d2 = diffsRef.current[2];
			if (d2) {
				allChunks.push(...d2);
			}

			const targetChunks = allChunks.filter((c) => {
				if (c.tag === "equal") {
					return false;
				}
				if (type === "conflict") {
					return c.tag === "conflict";
				}
				return true;
			});

			if (targetChunks.length === 0) {
				return;
			}

			const sortedChunks = targetChunks
				.sort((a, b) => a.startA - b.startA)
				.filter((c, i, self) => {
					if (i === 0) {
						return true;
					}
					const prev = self[i - 1];
					return prev !== undefined && c.startA !== prev.startA;
				});

			const currentLine = mergedEditor.getPosition()?.lineNumber || 1;
			const currentIdx = sortedChunks.findIndex(
				(c) => c.startA + 1 >= currentLine,
			);

			let targetChunk: DiffChunk | undefined;
			if (direction === "next") {
				if (currentIdx === -1) {
					targetChunk = sortedChunks[0];
				} else {
					const chunkAtCursor = sortedChunks[currentIdx];
					if (
						chunkAtCursor &&
						chunkAtCursor.startA + 1 > currentLine
					) {
						targetChunk = chunkAtCursor;
					} else {
						targetChunk =
							sortedChunks[
								(currentIdx + 1) % sortedChunks.length
							];
					}
				}
			} else if (currentIdx === -1) {
				targetChunk = sortedChunks.at(-1);
			} else {
				const chunkAtCursor = sortedChunks[currentIdx];
				if (chunkAtCursor && chunkAtCursor.startA + 1 < currentLine) {
					targetChunk = chunkAtCursor;
				} else {
					targetChunk =
						sortedChunks[
							(currentIdx - 1 + sortedChunks.length) %
								sortedChunks.length
						];
				}
			}

			if (targetChunk) {
				const line = targetChunk.startA + 1;
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
			const newFiles = [...files] as PaneFiles;
			newFiles[targetIndex] = null;
			filesRef.current = newFiles;
			setFiles(newFiles);

			const nextDiffs = [...diffs] as PaneDiffs;
			const diffIdx = side === "left" ? 0 : 3;
			nextDiffs[diffIdx] = null;
			diffsRef.current = nextDiffs;
			setDiffs(nextDiffs);
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
				{files[1] === null ? (
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
								if (i === index) {
									return false;
								}
								if (i === 1 || i === 2 || i === 3) {
									return Boolean(files[i]);
								}
								if (i === 0) {
									return renderBaseLeft;
								}
								if (i === 4) {
									return renderBaseRight;
								}
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

							if (!activeFile) {
								return null;
							}

							const file = activeFile;
							const isOpen = Boolean(files[index]);

							let onToggleBase: undefined | (() => void);
							let baseSide: "left" | "right" | undefined;
							let isBaseActive = false;

							if (index === 1) {
								// Local
								onToggleBase = () => toggleBaseDiff("left");
								baseSide = "left";
								isBaseActive = Boolean(files[0]);
							} else if (index === 3) {
								// Remote
								onToggleBase = () => toggleBaseDiff("right");
								baseSide = "right";
								isBaseActive = Boolean(files[4]);
							}

							// Calculate which diff segment connects to the next active pane
							let diffsForCurtain:
								| DiffChunk[]
								| null
								| undefined = null;
							let leftEditorIdx = index;
							let rightEditorIdx = index + 1;
							let fadeOutLeft = false;
							let fadeOutRight = false;

							const isLeftBaseComparing =
								baseCompareHighlighting && Boolean(files[0]);
							const isRightBaseComparing =
								baseCompareHighlighting && Boolean(files[4]);

							if (index === 0 && files[1]) {
								diffsForCurtain = diffs[0] || prevBaseLeftDiffs;
								leftEditorIdx = 0;
								rightEditorIdx = 1;
								if (!isLeftBaseComparing) {
									fadeOutRight = true;
								}
							} else if (index === 1 && files[2]) {
								diffsForCurtain = diffs[1];
								leftEditorIdx = 1;
								rightEditorIdx = 2;
								if (isLeftBaseComparing) {
									fadeOutLeft = true;
								}
							} else if (index === 2 && files[3]) {
								diffsForCurtain = diffs[2];
								leftEditorIdx = 2;
								rightEditorIdx = 3;
								if (isRightBaseComparing) {
									fadeOutRight = true;
								}
							} else if (
								index === 3 &&
								activeFile &&
								(files[4] || renderBaseRight)
							) {
								diffsForCurtain =
									diffs[3] || prevBaseRightDiffs;
								leftEditorIdx = 3;
								rightEditorIdx = 4;
								if (!isRightBaseComparing) {
									fadeOutLeft = true;
								}
							}

							const leftEditor =
								editorRefs.current[leftEditorIdx];
							const rightEditor =
								editorRefs.current[rightEditorIdx];

							const curtainContent = diffsForCurtain &&
								leftEditor &&
								rightEditor && (
									<DiffCurtain
										diffs={diffsForCurtain}
										leftEditor={leftEditor}
										rightEditor={rightEditor}
										renderTrigger={renderTrigger}
										reversed={index === 1 || index === 3} // diffs[1] (A=2, B=1) and diff[3] (A=4, B=3) are reversed
										fadeOutLeft={fadeOutLeft}
										fadeOutRight={fadeOutRight}
										onApplyChunk={
											index === 1
												? (chunk) =>
														handleApplyChunk(
															1,
															chunk,
														)
												: index === 2
													? (chunk) =>
															handleApplyChunk(
																3,
																chunk,
															)
													: undefined
										}
										onDeleteChunk={
											index === 1 || index === 2
												? (chunk) =>
														handleDeleteChunk(
															index,
															chunk,
														)
												: undefined
										}
										onCopyUpChunk={
											index === 1
												? (chunk) =>
														handleCopyUpChunk(
															1,
															chunk,
														)
												: index === 2
													? (chunk) =>
															handleCopyUpChunk(
																3,
																chunk,
															)
													: undefined
										}
										onCopyDownChunk={
											index === 1
												? (chunk) =>
														handleCopyDownChunk(
															1,
															chunk,
														)
												: index === 2
													? (chunk) =>
															handleCopyDownChunk(
																3,
																chunk,
															)
													: undefined
										}
									/>
								);

							const paneContent = (
								<>
									<CodePane
										file={file}
										index={index}
										onMount={handleEditorMount}
										onChange={handleEditorChange}
										isMiddle={index === 2}
										highlights={getHighlights(index)}
										onCompleteMerge={
											index === 2
												? handleCompleteMerge
												: undefined
										}
										onCopyHash={handleCopyHash}
										onShowDiff={() => handleShowDiff(index)}
										externalSyncId={
											index === 2
												? externalSyncId
												: undefined
										}
										requestClipboardText={
											index === 2
												? requestClipboardText
												: undefined
										}
										writeClipboardText={writeClipboardText}
										syntaxHighlighting={syntaxHighlighting}
										onToggleBase={onToggleBase}
										baseSide={baseSide}
										isBaseActive={isBaseActive}
										onPrevDiff={
											index === 2
												? () =>
														handleNavigate(
															"prev",
															"diff",
														)
												: undefined
										}
										onNextDiff={
											index === 2
												? () =>
														handleNavigate(
															"next",
															"diff",
														)
												: undefined
										}
										onPrevConflict={
											index === 2
												? () =>
														handleNavigate(
															"prev",
															"conflict",
														)
												: undefined
										}
										onNextConflict={
											index === 2
												? () =>
														handleNavigate(
															"next",
															"conflict",
														)
												: undefined
										}
										autoFocusConflict={index === 2}
									/>
									{curtainContent}
								</>
							);

							if (isLeftBase || isRightBase) {
								// curtainContent is a sibling of AnimatedColumn, NOT inside it.
								// This ensures the animated div only contains the CodePane
								// and is the same width as all other editor columns.
								return (
									<Fragment key={index}>
										<AnimatedColumn
											isOpen={isOpen}
											side={isLeftBase ? "left" : "right"}
											textColumns={peerCount}
											textColumnsAfterAnimation={
												peerCount
											}
										>
											<CodePane
												file={file}
												index={index}
												onMount={handleEditorMount}
												onChange={handleEditorChange}
												isMiddle={false}
												highlights={getHighlights(
													index,
												)}
												onCopyHash={handleCopyHash}
												onShowDiff={() =>
													handleShowDiff(index)
												}
												writeClipboardText={
													writeClipboardText
												}
												syntaxHighlighting={
													syntaxHighlighting
												}
												onToggleBase={onToggleBase}
												baseSide={baseSide}
												isBaseActive={isBaseActive}
											/>
										</AnimatedColumn>
										{isLeftBase
											? (files[0] || renderBaseLeft) &&
												curtainContent
											: curtainContent}
									</Fragment>
								);
							}

							return (
								<Fragment key={index}>{paneContent}</Fragment>
							);
						});
					})()
				)}
			</div>
		</ErrorBoundary>
	);
};
