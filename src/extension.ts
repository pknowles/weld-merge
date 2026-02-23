import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "meld-auto-merge" is now active!');

    let disposable = vscode.commands.registerCommand('meld-auto-merge.autoMerge', () => {
        vscode.window.showInformationMessage('Meld Auto-Merge Command executed!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
