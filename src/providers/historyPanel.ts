import * as path from 'path';
import * as vscode from 'vscode';
import { getLogPageSize } from '../config';
import { SvnRepository } from '../services/svnRepository';
import { LogQuery } from '../types';

type RepositoryResolver = (rootUri: vscode.Uri) => SvnRepository | undefined;

interface PanelState {
  mode: 'log' | 'graph' | 'file';
  repositoryRoot: string;
  filePath?: string;
}

export class HistoryPanel {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; state: PanelState }>();

  public constructor(private readonly resolveRepository: RepositoryResolver) {}

  public getPanelKeys(): string[] {
    return [...this.panels.keys()];
  }

  public async showRepositoryLog(repository: SvnRepository, mode: 'log' | 'graph'): Promise<void> {
    const key = `${mode}:${repository.rootUri.toString()}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      await this.sendPage(existing.panel, existing.state, 0, undefined);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      mode === 'graph' ? 'svnLens.graph' : 'svnLens.log',
      mode === 'graph' ? `SVN Graph • ${repository.displayBranch}` : `SVN Log • ${repository.displayBranch}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const state: PanelState = { mode, repositoryRoot: repository.rootUri.toString() };
    this.attachPanel(key, panel, state);
    panel.webview.html = this.renderHtml(mode === 'graph' ? 'SVN Graph' : 'SVN Log');
    await this.sendPage(panel, state, 0, undefined);
  }

  public async showFileHistory(repository: SvnRepository, fileUri: vscode.Uri): Promise<void> {
    const key = `file:${fileUri.toString()}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      await this.sendPage(existing.panel, existing.state, 0, undefined);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'svnLens.fileHistory',
      `SVN File History • ${path.basename(fileUri.fsPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const state: PanelState = {
      mode: 'file',
      repositoryRoot: repository.rootUri.toString(),
      filePath: fileUri.fsPath,
    };
    this.attachPanel(key, panel, state);
    panel.webview.html = this.renderHtml('SVN File History');
    await this.sendPage(panel, state, 0, undefined);
  }

  private attachPanel(key: string, panel: vscode.WebviewPanel, state: PanelState): void {
    this.panels.set(key, { panel, state });
    panel.onDidDispose(() => {
      this.panels.delete(key);
    });

    panel.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
      if (message.type === 'query') {
        await this.sendPage(panel, state, Number(message.page ?? 0), {
          author: typeof message.author === 'string' ? message.author : undefined,
          from: typeof message.from === 'string' ? message.from : undefined,
          to: typeof message.to === 'string' ? message.to : undefined,
        });
      }

      if (message.type === 'compare' && typeof state.filePath === 'string') {
        const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
        if (!repository) {
          return;
        }
        await repository.compareRevisions(
          vscode.Uri.file(state.filePath),
          String(message.leftRevision ?? ''),
          String(message.rightRevision ?? ''),
        );
      }
    });
  }

  private async sendPage(
    panel: vscode.WebviewPanel,
    state: PanelState,
    page: number,
    filters: { author?: string; from?: string; to?: string } | undefined,
  ): Promise<void> {
    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository) {
      return;
    }

    const query: LogQuery = {
      page,
      pageSize: getLogPageSize(repository.rootUri),
      author: filters?.author,
      from: filters?.from,
      to: filters?.to,
    };
    const result =
      state.mode === 'file' && state.filePath
        ? await repository.getFileHistory(vscode.Uri.file(state.filePath), query)
        : await repository.getLogPage(query);

    await panel.webview.postMessage({
      type: 'page',
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      mode: state.mode,
      entries: result.entries,
      filePath: state.filePath,
    });
  }

  private renderHtml(title: string): string {
    const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: linear-gradient(135deg, rgba(10,95,82,0.18), rgba(214,174,88,0.12));
      --panel: rgba(127,144,176,0.08);
      --accent: #0a5f52;
      --muted: #6b7280;
      --border: rgba(127,144,176,0.24);
      --text: var(--vscode-editor-foreground);
    }
    body {
      margin: 0;
      font-family: Georgia, 'Iowan Old Style', serif;
      color: var(--text);
      background: var(--bg);
      min-height: 100vh;
    }
    .shell {
      padding: 20px;
      display: grid;
      gap: 16px;
    }
    .toolbar, .entry, .details {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 16px;
      backdrop-filter: blur(8px);
    }
    .toolbar {
      padding: 16px;
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
    }
    .toolbar input, .toolbar button {
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 10px 12px;
      background: rgba(255,255,255,0.08);
      color: inherit;
    }
    .toolbar button {
      cursor: pointer;
      background: var(--accent);
      color: white;
      font-weight: 600;
    }
    .list {
      display: grid;
      gap: 12px;
    }
    .entry {
      padding: 14px 16px;
      display: grid;
      gap: 10px;
      text-align: left;
      cursor: pointer;
    }
    .entry.graph-mode {
      grid-template-columns: 72px minmax(0, 1fr);
      align-items: start;
    }
    .entry-header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: baseline;
    }
    .entry-meta {
      color: var(--muted);
      font-size: 0.9rem;
    }
    .graph {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 6px rgba(10,95,82,0.12);
    }
    .rail {
      display: grid;
      justify-items: center;
      gap: 10px;
    }
    .rail::after {
      content: '';
      width: 2px;
      min-height: 64px;
      background: linear-gradient(180deg, rgba(10,95,82,0.4), rgba(10,95,82,0));
    }
    .lane-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 48px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(10,95,82,0.12);
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.06);
      font-size: 0.78rem;
      color: var(--muted);
    }
    .chip strong {
      color: var(--text);
    }
    .copy-note {
      color: var(--muted);
      font-size: 0.85rem;
    }
    .details {
      padding: 16px;
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .pager {
      display: flex;
      gap: 12px;
    }
    .pager button {
      flex: 1;
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 10px 12px;
      background: rgba(255,255,255,0.08);
      color: inherit;
      cursor: pointer;
    }
    @media (max-width: 900px) {
      .toolbar {
        grid-template-columns: 1fr 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <input id="author" placeholder="作者过滤" />
      <input id="from" placeholder="开始时间，例如 2024-01-01" />
      <input id="to" placeholder="结束时间，例如 2024-12-31" />
      <button id="apply">应用过滤</button>
      <button id="reload">刷新</button>
    </div>
    <div id="list" class="list"></div>
    <div class="pager">
      <button id="prev">上一页</button>
      <button id="next">下一页</button>
    </div>
    <div id="details" class="details">选择一条提交记录以查看详细信息。</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentPage = 0;
    let latestPage = { hasMore: false, mode: 'log', filePath: undefined, entries: [] };
    const list = document.getElementById('list');
    const details = document.getElementById('details');
    const author = document.getElementById('author');
    const from = document.getElementById('from');
    const to = document.getElementById('to');

    function query(page) {
      currentPage = Math.max(0, page);
      vscode.postMessage({
        type: 'query',
        page: currentPage,
        author: author.value,
        from: from.value,
        to: to.value
      });
    }

    function escapeHtml(value) {
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function shortPath(value) {
      const normalized = String(value || '').replace(/^\//, '');
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length <= 3) {
        return normalized || 'repo';
      }
      return parts.slice(0, 2).concat('…').concat(parts.slice(-1)).join('/');
    }

    function getLane(entry) {
      const firstPath = (entry.changedPaths || [])[0]?.path || '';
      const normalized = String(firstPath).replace(/^\//, '');
      const parts = normalized.split('/').filter(Boolean);
      if (parts[0] === 'branches') {
        return parts[1] ? 'br:' + parts[1] : 'branches';
      }
      if (parts[0] === 'tags') {
        return parts[1] ? 'tag:' + parts[1] : 'tags';
      }
      return parts[0] || 'repo';
    }

    function getCopyNote(entry) {
      const copied = (entry.changedPaths || []).find(item => item.copyFromPath);
      if (!copied) {
        return '';
      }
      return 'Copied from ' + copied.copyFromPath + (copied.copyFromRevision ? '@r' + copied.copyFromRevision : '');
    }

    function renderChips(entry) {
      return (entry.changedPaths || [])
        .slice(0, 6)
        .map(item => '<span class="chip"><strong>' + escapeHtml(item.action) + '</strong>' + escapeHtml(shortPath(item.path)) + '</span>')
        .join('');
    }

    function render(entries, mode, filePath) {
      latestPage = { ...latestPage, entries, mode, filePath };
      list.innerHTML = '';
      entries.forEach((entry, index) => {
        const root = document.createElement('button');
        root.className = mode === 'graph' ? 'entry graph-mode' : 'entry';

        if (mode === 'graph') {
          const lane = getLane(entry);
          const copyNote = getCopyNote(entry);
          root.innerHTML = [
            '<div class="rail">',
            '<span class="lane-pill">' + escapeHtml(lane) + '</span>',
            '<span class="dot"></span>',
            '</div>',
            '<div>',
            '<div class="entry-header">',
            '<div class="graph"><strong>r' + entry.revision + '</strong></div>',
            '<span class="entry-meta">' + escapeHtml(entry.author) + ' · ' + escapeHtml(entry.date || '') + '</span>',
            '</div>',
            '<div>' + escapeHtml(entry.message || '') + '</div>',
            '<div class="chips">' + renderChips(entry) + '</div>',
            (copyNote ? '<div class="copy-note">' + escapeHtml(copyNote) + '</div>' : ''),
            '</div>'
          ].join('');
        } else {
          root.innerHTML = [
            '<div class="entry-header">',
            '<div class="graph"><span class="dot"></span><strong>r' + entry.revision + '</strong></div>',
            '<span class="entry-meta">' + escapeHtml(entry.author) + ' · ' + escapeHtml(entry.date || '') + '</span>',
            '</div>',
            '<div>' + escapeHtml(entry.message || '') + '</div>',
            '<div class="entry-meta">' + entry.changedPaths.length + ' files changed</div>'
          ].join('');
        }

        root.addEventListener('click', () => {
          details.textContent = [
            'Revision: r' + entry.revision,
            'Author: ' + entry.author,
            'Date: ' + (entry.date || ''),
            '',
            entry.message || '',
            '',
            'Changed Paths:',
            ...entry.changedPaths.map(item => item.action + ' ' + item.path)
          ].join('\n');

          if (mode === 'file' && filePath) {
            const previous = entries[index + 1];
            if (previous) {
              const spacer = document.createElement('br');
              const compare = document.createElement('button');
              compare.textContent = '与上一版本比较';
              compare.addEventListener('click', () => {
                vscode.postMessage({ type: 'compare', leftRevision: previous.revision, rightRevision: entry.revision });
              });
              details.appendChild(spacer);
              details.appendChild(compare);
            }
          }
        });

        list.appendChild(root);
      });
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'page') {
        latestPage = { ...latestPage, hasMore: !!message.hasMore };
        render(message.entries || [], message.mode, message.filePath);
      }
    });

    document.getElementById('apply').addEventListener('click', () => query(0));
    document.getElementById('reload').addEventListener('click', () => query(currentPage));
    document.getElementById('prev').addEventListener('click', () => query(Math.max(0, currentPage - 1)));
    document.getElementById('next').addEventListener('click', () => {
      if (latestPage.hasMore) {
        query(currentPage + 1);
      }
    });

    query(0);
  </script>
</body>
</html>`;
  }
}