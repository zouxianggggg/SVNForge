import * as vscode from 'vscode';
import { getBlameDecorationsEnabled } from '../config';
import { SvnRepository } from '../services/svnRepository';

type RepositoryLookup = (uri: vscode.Uri) => SvnRepository | undefined;

export class BlameProvider implements vscode.Disposable, vscode.HoverProvider {
  private enabled = true;
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('descriptionForeground'),
      margin: '0 0 0 2rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(private readonly getRepository: RepositoryLookup) {
    this.enabled = getBlameDecorationsEnabled();
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.refreshActiveEditor();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        void this.refreshActiveEditor();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
          void this.refreshActiveEditor();
        }
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
    );
  }

  public toggle(): boolean {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      vscode.window.visibleTextEditors.forEach((editor) => editor.setDecorations(this.decorationType, []));
    } else {
      void this.refreshActiveEditor();
    }
    return this.enabled;
  }

  public async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const repository = this.getRepository(document.uri);
    if (!repository) {
      return undefined;
    }

    const lines = await repository.getBlame(document.uri);
    const line = lines[position.line];
    if (!line) {
      return undefined;
    }

    const detail = await repository.getRevisionLog(line.revision, document.uri);
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`**r${line.revision}**  \n`);
    markdown.appendMarkdown(`${line.author}  \n`);
    if (line.date) {
      markdown.appendMarkdown(`${line.date}  \n`);
    }
    if (detail?.message) {
      markdown.appendMarkdown(`\n${detail.message}`);
    }
    return new vscode.Hover(markdown);
  }

  public async refreshActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!this.enabled || !getBlameDecorationsEnabled(editor.document.uri)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const repository = this.getRepository(editor.document.uri);
    if (!repository) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const blameLines = await repository.getBlame(editor.document.uri);
    const fallbackRange = new vscode.Range(0, 0, Math.max(0, editor.document.lineCount - 1), 0);
    const visibleRanges = editor.visibleRanges.length > 0 ? editor.visibleRanges : [fallbackRange];
    const decorations: vscode.DecorationOptions[] = [];
    for (const range of visibleRanges) {
      for (let lineNumber = range.start.line; lineNumber <= range.end.line; lineNumber += 1) {
        const blameLine = blameLines[lineNumber];
        if (!blameLine) {
          continue;
        }
        decorations.push({
          range: new vscode.Range(lineNumber, 0, lineNumber, 0),
          renderOptions: {
            after: {
              contentText: `${blameLine.author} • r${blameLine.revision}`,
            },
          },
        });
      }
    }
    editor.setDecorations(this.decorationType, decorations);
  }

  public dispose(): void {
    this.decorationType.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
