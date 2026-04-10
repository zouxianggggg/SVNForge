import * as vscode from 'vscode';
import { SvnRepository } from '../services/svnRepository';

export class ConflictDecorator implements vscode.Disposable {
  private readonly currentType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  });

  private readonly incomingType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
  });

  private readonly markerType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });

  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor() {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.refresh();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
          this.refresh();
        }
      }),
    );
  }

  public refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const currentRanges: vscode.Range[] = [];
    const incomingRanges: vscode.Range[] = [];
    const markerRanges: vscode.Range[] = [];
    let mode: 'current' | 'incoming' | undefined;

    for (let lineNumber = 0; lineNumber < editor.document.lineCount; lineNumber += 1) {
      const line = editor.document.lineAt(lineNumber).text;
      if (line.startsWith('<<<<<<<')) {
        mode = 'current';
        markerRanges.push(new vscode.Range(lineNumber, 0, lineNumber, line.length));
        continue;
      }
      if (line.startsWith('=======')) {
        mode = 'incoming';
        markerRanges.push(new vscode.Range(lineNumber, 0, lineNumber, line.length));
        continue;
      }
      if (line.startsWith('>>>>>>>')) {
        mode = undefined;
        markerRanges.push(new vscode.Range(lineNumber, 0, lineNumber, line.length));
        continue;
      }

      if (mode === 'current') {
        currentRanges.push(new vscode.Range(lineNumber, 0, lineNumber, line.length));
      } else if (mode === 'incoming') {
        incomingRanges.push(new vscode.Range(lineNumber, 0, lineNumber, line.length));
      }
    }

    editor.setDecorations(this.currentType, currentRanges);
    editor.setDecorations(this.incomingType, incomingRanges);
    editor.setDecorations(this.markerType, markerRanges);
  }

  public async openConflictDiff(repository: SvnRepository, target: vscode.Uri): Promise<void> {
    const artifacts = await repository.findConflictArtifacts(target);
    if (artifacts.mine && artifacts.theirs) {
      await vscode.commands.executeCommand(
        'vscode.diff',
        artifacts.mine,
        artifacts.theirs,
        `${target.path.split('/').at(-1) ?? target.fsPath}: mine ↔ theirs`,
      );
      return;
    }
    await repository.openWorkingDiff(target);
  }

  public dispose(): void {
    this.currentType.dispose();
    this.incomingType.dispose();
    this.markerType.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}