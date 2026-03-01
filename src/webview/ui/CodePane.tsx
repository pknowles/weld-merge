import * as React from "react";
import Editor from "@monaco-editor/react";
import type { FileState } from "./types";
import type { editor } from "monaco-editor";

interface CodePaneProps {
	file: FileState;
	index: number;
	onMount: (editor: editor.IStandaloneCodeEditor, index: number) => void;
	onChange: (value: string | undefined, index: number) => void;
	isMiddle: boolean;
	highlights?: { start: number; end: number; tag: string }[];
	onSave?: (value: string) => void;
	onShowCommit?: (hash: string) => void;
}

export const CodePane: React.FC<CodePaneProps> = ({
	file,
	index,
	onMount,
	onChange,
	isMiddle,
	highlights,
	onSave,
	onShowCommit,
}) => {
	const [editorInstance, setEditorInstance] =
		React.useState<editor.IStandaloneCodeEditor | null>(null);
	const decorationsRef = React.useRef<string[]>([]);

	React.useEffect(() => {
		if (!editorInstance || !highlights) return;

		const newDecorations = highlights
			.filter((h) => h.start <= h.end)
			.map((h) => ({
				range: {
					startLineNumber: h.start,
					startColumn: 1,
					endLineNumber: h.end,
					endColumn: 1,
				},
				options: {
					isWholeLine: true,
					className: `diff-${h.tag}`,
				},
			}));

		decorationsRef.current = editorInstance.deltaDecorations(
			decorationsRef.current,
			newDecorations,
		);
	}, [editorInstance, highlights]);

	const handleMount = (editor: editor.IStandaloneCodeEditor, monaco: unknown) => {
		setEditorInstance(editor);
		
		if (onSave) {
			// monaco typing can be tricky but addCommand works dynamically if we use any
			const monacoLib = monaco as typeof import("monaco-editor");
			editor.addCommand(monacoLib.KeyMod.CtrlCmd | monacoLib.KeyCode.KeyS, () => {
				onSave(editor.getValue());
			});
		}
		
		onMount(editor, index);
	};

	return (
		<div
			style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: "#2d2d2d",
					color: "#cccccc",
					padding: "8px",
					fontFamily: "sans-serif",
					fontSize: "12px",
					borderBottom: "1px solid #444",
					minWidth: 0,
				}}
			>
				<span style={{ flexShrink: 0 }}>
					{file.label.replace("BASE", "Merge Result")}
				</span>
				{file.commit && (
					<span
						style={{
							marginLeft: "8px",
							opacity: 0.7,
							cursor: "pointer",
							textDecoration: "underline",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
						title={`View Commit ${file.commit.hash}: ${file.commit.title}`}
						onClick={() => file.commit && onShowCommit?.(file.commit.hash)}
					>
						[{file.commit.title}]
					</span>
				)}
			</div>
			<div style={{ flex: 1, position: "relative", minHeight: 0 }}>
				<Editor
					defaultLanguage="typescript"
					value={file.content}
					theme="vs-dark"
					options={{
						minimap: { enabled: false },
						readOnly: !isMiddle,
						scrollBeyondLastLine: false,
						wordWrap: "off",
						renderWhitespace: "all",
					}}
					onMount={handleMount}
					onChange={(value) => onChange(value, index)}
				/>
			</div>
		</div>
	);
};
