import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Merger } from './matchers/merge';
import { DiffChunk } from './matchers/myers';

class GitTextMerger extends Merger {
    *merge_3_files_git(mark_conflicts: boolean = true) {
        this.differ.unresolved = [];
        let lastline = 0;
        let mergedline = 0;
        const mergedtext: string[] = [];

        for (const change of this.differ.all_changes()) {
            yield null;
            let low_mark = lastline;
            if (change[0] !== null) low_mark = change[0].start_a;
            if (change[1] !== null && change[1].start_a > low_mark) {
                low_mark = change[1].start_a;
            }

            for (let i = lastline; i < low_mark; i++) {
                mergedtext.push(this.texts[1][i]);
            }
            mergedline += low_mark - lastline;
            lastline = low_mark;

            if (change[0] !== null && change[1] !== null && change[0].tag === 'conflict') {
                const min_mark = Math.min(change[0].start_a, change[1].start_a);
                const high_mark = Math.max(change[0].end_a, change[1].end_a);
                if (mark_conflicts) {
                    mergedtext.push("<<<<<<< HEAD");
                    for (let i = change[0].start_b; i < change[0].end_b; i++) {
                        mergedtext.push(this.texts[0][i]);
                    }
                    mergedtext.push("||||||| BASE");
                    for (let i = min_mark; i < high_mark; i++) {
                        mergedtext.push(this.texts[1][i]);
                    }
                    mergedtext.push("=======");
                    for (let i = change[1].start_b; i < change[1].end_b; i++) {
                        mergedtext.push(this.texts[2][i]);
                    }
                    mergedtext.push(">>>>>>> REMOTE");
                    
                    const added_lines = (change[0].end_b - change[0].start_b) + (high_mark - min_mark) + (change[1].end_b - change[1].start_b) + 4;
                    for (let i = 0; i < added_lines; i++) {
                        this.differ.unresolved.push(mergedline);
                        mergedline += 1;
                    }
                    lastline = high_mark;
                }
            } else if (change[0] !== null) {
                lastline += this._apply_change(this.texts[0], change[0], mergedtext);
                mergedline += change[0].end_b - change[0].start_b;
            } else if (change[1] !== null) {
                lastline += this._apply_change(this.texts[2], change[1], mergedtext);
                mergedline += change[1].end_b - change[1].start_b;
            }
        }

        const baselen = this.texts[1].length;
        for (let i = lastline; i < baselen; i++) {
            mergedtext.push(this.texts[1][i]);
        }

        yield mergedtext.join('\n');
    }
}

function execShell(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(cmd, { cwd, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

function getRelativeRepoPath(documentUri: vscode.Uri): string | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder) return null;
    return path.relative(workspaceFolder.uri.fsPath, documentUri.fsPath).replace(/\\/g, '/');
}

async function getGitFileContent(repoPath: string, relativeFilePath: string, stage: number): Promise<string> {
    try {
        const content = await execShell(`git show :${stage}:"${relativeFilePath}"`, repoPath);
        return content;
    } catch (e) {
        throw new Error(`Could not get git content for stage ${stage} of ${relativeFilePath}. Is it in conflict?`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('meld-auto-merge.autoMerge', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active text editor found.');
            return;
        }

        const document = editor.document;
        if (document.isUntitled) {
            vscode.window.showErrorMessage('Cannot merge untitled files.');
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File must be in a workspace to use git commands.');
            return;
        }

        const repoPath = workspaceFolder.uri.fsPath;
        const relativeFilePath = getRelativeRepoPath(document.uri);
        if (!relativeFilePath) {
            vscode.window.showErrorMessage('Could not determine relative file path.');
            return;
        }

        try {
            const baseContent = await getGitFileContent(repoPath, relativeFilePath, 1);
            const localContent = await getGitFileContent(repoPath, relativeFilePath, 2);
            const remoteContent = await getGitFileContent(repoPath, relativeFilePath, 3);

            vscode.window.showInformationMessage('Running Meld auto-merge heuristics...');

            const merger = new GitTextMerger();
            
            // Meld sequences are expected to be arrays of lines WITHOUT trailing newlines (joined by \n later)
            const splitLines = (text: string) => {
                const lines = text.split('\n');
                if (lines.length > 0 && lines[lines.length - 1] === '') {
                    lines.pop(); // remove trailing empty string from trailing newline
                }
                return lines;
            };

            const localLines = splitLines(localContent);
            const baseLines = splitLines(baseContent);
            const remoteLines = splitLines(remoteContent);

            const sequences = [localLines, baseLines, remoteLines];
            
            const initGen = merger.initialize(sequences, sequences);
            let val = initGen.next();
            while (!val.done) {
                val = initGen.next();
            }

            const mergeGen = merger.merge_3_files_git(true);
            let finalMergedText: string | null = null;
            for (const res of mergeGen) {
                if (res !== null && typeof res === 'string') {
                    finalMergedText = res;
                }
            }

            if (finalMergedText === null) {
                throw new Error("Merge generation failed to produce text.");
            }

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );

            const success = await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, finalMergedText as string);
            });

            if (success) {
                vscode.window.showInformationMessage(`Meld Auto-Merge complete! Unresolved conflicts marked.`);
            } else {
                vscode.window.showErrorMessage(`Failed to apply merged text to editor.`);
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Meld Auto-Merge Error: ${e.message}`);
        }
    });

    let disposableCheckout = vscode.commands.registerCommand('meld-auto-merge.checkoutConflicted', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document || editor.document.isUntitled) return;
        const documentUri = editor.document.uri;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!workspaceFolder) return;

        const repoPath = workspaceFolder.uri.fsPath;
        const relativeFilePath = getRelativeRepoPath(documentUri);
        if (!relativeFilePath) return;

        try {
            await execShell(`git checkout -m -- "${relativeFilePath}"`, repoPath);
            vscode.window.showInformationMessage(`Checked out conflicted version of ${relativeFilePath}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Checkout failed: ${e.message}`);
        }
    });

    let disposableRerere = vscode.commands.registerCommand('meld-auto-merge.rerereForget', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document || editor.document.isUntitled) return;
        const documentUri = editor.document.uri;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!workspaceFolder) return;

        const repoPath = workspaceFolder.uri.fsPath;
        const relativeFilePath = getRelativeRepoPath(documentUri);
        if (!relativeFilePath) return;

        try {
            await execShell(`git rerere forget "${relativeFilePath}"`, repoPath);
            vscode.window.showInformationMessage(`Forgot recorded resolution for ${relativeFilePath}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Rerere forget failed: ${e.message}`);
        }
    });

    let disposableSmartAdd = vscode.commands.registerCommand('meld-auto-merge.smartAdd', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document || editor.document.isUntitled) return;
        
        await editor.document.save(); // ensure saved
        const text = editor.document.getText();
        
        if (text.includes('<<<<<<<') || text.includes('=======') || text.includes('>>>>>>>')) {
            vscode.window.showErrorMessage('Cannot add file: Conflict markers still remain in the text.');
            return;
        }

        const documentUri = editor.document.uri;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!workspaceFolder) return;

        const repoPath = workspaceFolder.uri.fsPath;
        const relativeFilePath = getRelativeRepoPath(documentUri);
        if (!relativeFilePath) return;

        try {
            await execShell(`git add "${relativeFilePath}"`, repoPath);
            vscode.window.showInformationMessage(`Successfully added ${relativeFilePath}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Git Add failed: ${e.message}`);
        }
    });

    let disposableListFiles = vscode.commands.registerCommand('meld-auto-merge.listConflicted', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return;

        const repoPath = workspaceFolders[0].uri.fsPath;
        try {
            const output = await execShell(`git diff --name-only --diff-filter=U`, repoPath);
            const files = output.trim().split('\n').filter(f => f);
            if (files.length === 0) {
                vscode.window.showInformationMessage('No conflicted files found.');
                return;
            }
            
            const selected = await vscode.window.showQuickPick(files, {
                placeHolder: 'Select a conflicted file to open'
            });

            if (selected) {
                const uri = vscode.Uri.file(path.join(repoPath, selected));
                vscode.window.showTextDocument(uri);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to list conflicted files: ${e.message}`);
        }
    });

    context.subscriptions.push(disposable, disposableCheckout, disposableRerere, disposableSmartAdd, disposableListFiles);
}

export function deactivate() {}
