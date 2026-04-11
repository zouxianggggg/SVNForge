import * as vscode from 'vscode';
import { getBlameDecorationsEnabled } from '../config';
import { SvnRepository } from '../services/svnRepository';
import { SvnLogEntry } from '../types';

type RepositoryLookup = (uri: vscode.Uri) => SvnRepository | undefined;

export class BlameProvider implements vscode.Disposable {
  private enabled = true;
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'normal',
      margin: '0 0 0 2.25rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly subscriptions: vscode.Disposable[] = [];
  private refreshToken = 0;

  public constructor(private readonly getRepository: RepositoryLookup) {
    this.enabled = getBlameDecorationsEnabled();
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.refreshActiveEditor();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          void this.refreshActiveEditor();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          void this.refreshActiveEditor();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
          void this.refreshActiveEditor();
        }
      }),
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

  public async refreshActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const requestToken = ++this.refreshToken;
    this.clearInactiveEditors(editor);
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
    const activeLineNumber = editor.selection.active.line;
    const blameLine = blameLines[activeLineNumber];
    if (!blameLine) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const detail = await repository.getRevisionLog(blameLine.revision, editor.document.uri).catch(() => undefined);
    if (requestToken !== this.refreshToken || editor !== vscode.window.activeTextEditor) {
      return;
    }

    const activeLine = editor.document.lineAt(activeLineNumber);
    editor.setDecorations(this.decorationType, [
      {
        range: new vscode.Range(activeLine.range.end, activeLine.range.end),
        hoverMessage: this.buildHoverMessage(blameLine.revision, blameLine.author, blameLine.date, detail),
        renderOptions: {
          after: {
            contentText: this.buildInlineSummary(blameLine.revision, blameLine.author, blameLine.date, detail),
          },
        },
      },
    ]);
  }

  public dispose(): void {
    this.decorationType.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  private clearInactiveEditors(activeEditor: vscode.TextEditor | undefined): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor !== activeEditor) {
        editor.setDecorations(this.decorationType, []);
      }
    }
  }

  private buildInlineSummary(revision: number, author: string, date: string | undefined, detail: SvnLogEntry | undefined): string {
    const subject = this.getMessageSubject(detail?.message);
    const summary = [
      subject,
      author,
      this.formatRelativeTime(date),
      `r${revision}`,
    ]
      .filter((value): value is string => !!value)
      .join('  •  ');
    return summary ? `  ${this.truncate(summary, 120)}` : '';
  }

  private buildHoverMessage(
    revision: number,
    author: string,
    date: string | undefined,
    detail: SvnLogEntry | undefined,
  ): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = false;
    const subject = this.getMessageSubject(detail?.message) ?? 'No commit message';
    markdown.appendMarkdown(`**${this.escapeMarkdown(subject)}**`);
    markdown.appendMarkdown(`\n\nRevision: **r${revision}**`);
    markdown.appendMarkdown(`  \nAuthor: **${this.escapeMarkdown(author)}**`);

    const dateParts = [date, this.formatRelativeTime(date)].filter((value): value is string => !!value);
    if (dateParts.length > 0) {
      markdown.appendMarkdown(`  \nDate: ${dateParts.map((value) => this.escapeMarkdown(value)).join(' • ')}`);
    }

    if (detail?.message) {
      markdown.appendMarkdown(`\n\n${this.toBlockQuote(detail.message)}`);
    }

    const changedPaths = detail?.changedPaths?.slice(0, 6) ?? [];
    if (changedPaths.length > 0) {
      markdown.appendMarkdown(`\n\nChanged paths (${detail?.changedPaths?.length ?? changedPaths.length}):`);
      for (const item of changedPaths) {
        markdown.appendMarkdown(`\n- **${this.escapeMarkdown(item.action)}** ${this.escapeMarkdown(item.path)}`);
      }
      if ((detail?.changedPaths?.length ?? 0) > changedPaths.length) {
        markdown.appendMarkdown(`\n- +${(detail?.changedPaths?.length ?? 0) - changedPaths.length} more`);
      }
    }

    return markdown;
  }

  private formatRelativeTime(date: string | undefined): string | undefined {
    if (!date) {
      return undefined;
    }

    const parsed = Date.parse(date);
    if (Number.isNaN(parsed)) {
      return undefined;
    }

    const diffMs = Date.now() - parsed;
    const absDiffMs = Math.abs(diffMs);
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['year', 1000 * 60 * 60 * 24 * 365],
      ['month', 1000 * 60 * 60 * 24 * 30],
      ['week', 1000 * 60 * 60 * 24 * 7],
      ['day', 1000 * 60 * 60 * 24],
      ['hour', 1000 * 60 * 60],
      ['minute', 1000 * 60],
    ];

    for (const [unit, size] of units) {
      if (absDiffMs >= size) {
        const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
        return formatter.format(-Math.round(diffMs / size), unit);
      }
    }

    return 'just now';
  }

  private getMessageSubject(message: string | undefined): string | undefined {
    const subject = message?.split(/\r?\n/, 1)[0]?.trim();
    return subject ? subject : undefined;
  }

  private toBlockQuote(message: string): string {
    return message
      .split(/\r?\n/)
      .map((line) => `> ${this.escapeMarkdown(line)}`)
      .join('\n');
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
  }
}
