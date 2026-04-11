import * as path from 'path';
import * as vscode from 'vscode';
import { getLogPageSize } from '../config';
import { RevisionSelection } from './revisionDetailsProvider';
import { SvnRepository } from '../services/svnRepository';
import { LogQuery, SvnLogEntry } from '../types';

type RepositoryResolver = (rootUri: vscode.Uri) => SvnRepository | undefined;
type RevisionSelectionHandler = (selection: RevisionSelection | undefined) => void;

interface PanelState {
  mode: 'log' | 'graph' | 'file';
  repositoryRoot: string;
  filePath?: string;
}

interface PanelEntryPreviewPath {
  action: string;
  path: string;
  copyFromPath?: string;
  copyFromRevision?: number;
}

interface PanelEntrySummary {
  revision: number;
  author: string;
  date: string;
  message: string;
  changedPathCount: number;
  previewPaths: PanelEntryPreviewPath[];
  firstPath?: string;
  copyNote?: string;
}

interface PanelPagePayload {
  type: 'page';
  page: number;
  pageSize: number;
  hasMore: boolean;
  mode: PanelState['mode'];
  entries: PanelEntrySummary[];
  listHtml: string;
  detailsHtml: string;
  filePath?: string;
  error?: string;
}

export class HistoryPanel {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; state: PanelState }>();

  public constructor(
    private readonly resolveRepository: RepositoryResolver,
    private readonly onDidSelectRevision?: RevisionSelectionHandler,
  ) {}

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
    const initialPage = await this.getPagePayload(state, 0, undefined);
    this.attachPanel(key, panel, state);
    panel.webview.html = this.renderHtml(mode === 'graph' ? 'SVN Graph' : 'SVN Log', initialPage);
    await this.syncSelectionFromPayload(state, initialPage);
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
    const initialPage = await this.getPagePayload(state, 0, undefined);
    this.attachPanel(key, panel, state);
    panel.webview.html = this.renderHtml('SVN File History', initialPage);
    await this.syncSelectionFromPayload(state, initialPage);
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

      if (message.type === 'details') {
        await this.sendDetails(
          panel,
          state,
          Number(message.revision ?? 0),
          typeof message.previousRevision === 'number' ? message.previousRevision : undefined,
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
    const payload = await this.getPagePayload(state, page, filters);
    await panel.webview.postMessage(payload);
    await this.syncSelectionFromPayload(state, payload);
  }

  private async getPagePayload(
    state: PanelState,
    page: number,
    filters: { author?: string; from?: string; to?: string } | undefined,
  ): Promise<PanelPagePayload> {
    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository) {
      return {
        type: 'page',
        page,
        pageSize: 0,
        hasMore: false,
        mode: state.mode,
        entries: [],
        listHtml: '<div class="empty-state">当前工作区没有可用的 SVN 仓库。</div>',
        detailsHtml: '当前工作区没有可用的 SVN 仓库。',
        filePath: state.filePath,
        error: '当前工作区没有可用的 SVN 仓库。',
      };
    }

    try {
      const query: LogQuery = {
        page,
        pageSize: Math.min(25, getLogPageSize(repository.rootUri)),
        author: filters?.author,
        from: filters?.from,
        to: filters?.to,
      };
      const result =
        state.mode === 'file' && state.filePath
          ? await repository.getFileHistory(vscode.Uri.file(state.filePath), query)
          : await repository.getLogPage(query);
      const summaries = result.entries.map((entry) => this.toPanelEntrySummary(entry));

      return {
        type: 'page',
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        mode: state.mode,
        entries: summaries,
        listHtml: this.renderListHtml(summaries, state.mode),
        detailsHtml: this.renderDetailsHtml(result.entries[0], state.mode, result.entries[1]?.revision),
        filePath: state.filePath,
        error: undefined,
      };
    } catch (error) {
      return {
        type: 'page',
        page,
        pageSize: getLogPageSize(repository.rootUri),
        hasMore: false,
        mode: state.mode,
        entries: [],
        listHtml: `<div class="empty-state">加载提交记录失败：${this.escapeHtml(error instanceof Error ? error.message : String(error))}</div>`,
        detailsHtml: error instanceof Error ? error.message : String(error),
        filePath: state.filePath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async sendDetails(
    panel: vscode.WebviewPanel,
    state: PanelState,
    revision: number,
    previousRevision?: number,
  ): Promise<void> {
    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository || revision <= 0) {
      await panel.webview.postMessage({
        type: 'details',
        revision,
        html: this.escapeHtml('无法读取该修订版本的详细信息。'),
        error: '无法读取该修订版本的详细信息。',
      });
      return;
    }

    try {
      const target = state.mode === 'file' && state.filePath ? vscode.Uri.file(state.filePath) : undefined;
      const detail = await repository.getRevisionLog(revision, target);
      if (!detail) {
        await panel.webview.postMessage({
          type: 'details',
          revision,
          html: this.escapeHtml(`未找到 r${revision} 的详细信息。`),
          error: `未找到 r${revision} 的详细信息。`,
        });
        return;
      }

      await panel.webview.postMessage({
        type: 'details',
        revision,
        html: this.renderDetailsHtml(detail, state.mode, previousRevision),
        error: undefined,
      });
      this.onDidSelectRevision?.({
        repository,
        entry: detail,
        previousRevision,
        targetUri: state.mode === 'file' && state.filePath ? vscode.Uri.file(state.filePath) : undefined,
      });
    } catch (error) {
      await panel.webview.postMessage({
        type: 'details',
        revision,
        html: this.escapeHtml(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private toPanelEntrySummary(entry: SvnLogEntry): PanelEntrySummary {
    const previewPaths = entry.changedPaths.slice(0, 6).map((item) => ({
      action: item.action,
      path: item.path,
      copyFromPath: item.copyFromPath,
      copyFromRevision: item.copyFromRevision,
    }));
    const copied = entry.changedPaths.find((item) => item.copyFromPath);
    return {
      revision: entry.revision,
      author: entry.author,
      date: entry.date,
      message: entry.message,
      changedPathCount: entry.changedPaths.length,
      previewPaths,
      firstPath: entry.changedPaths[0]?.path,
      copyNote: copied
        ? `Copied from ${copied.copyFromPath}${copied.copyFromRevision ? `@r${copied.copyFromRevision}` : ''}`
        : undefined,
    };
  }

  private renderListHtml(entries: PanelEntrySummary[], mode: PanelState['mode']): string {
    if (entries.length === 0) {
      return '<div class="empty-state">没有匹配的提交记录。</div>';
    }

    return entries
      .map((entry, index) => {
        const previousRevision = entries[index + 1]?.revision;
        const attrs = [
          'class="entry-trigger"',
          `data-revision="${entry.revision}"`,
          previousRevision ? `data-previous-revision="${previousRevision}"` : '',
          'role="button"',
          'tabindex="0"',
        ]
          .filter(Boolean)
          .join(' ');

        if (mode === 'graph') {
          const lane = this.getLane(entry);
          return [
            `<div class="entry graph-mode" ${attrs}>`,
            '<div class="rail">',
            `<span class="lane-pill">${this.escapeHtml(lane)}</span>`,
            '<span class="dot"></span>',
            '</div>',
            '<div>',
            '<div class="entry-header">',
            `<div class="graph"><strong>r${entry.revision}</strong></div>`,
            `<span class="entry-meta">${this.escapeHtml(entry.author)} · ${this.escapeHtml(entry.date || '')}</span>`,
            '</div>',
            `<div>${this.escapeHtml(entry.message || '')}</div>`,
            `<div class="chips">${this.renderChipsHtml(entry.previewPaths)}</div>`,
            entry.copyNote ? `<div class="copy-note">${this.escapeHtml(entry.copyNote)}</div>` : '',
            '</div>',
            '</div>',
          ].join('');
        }

        return [
          `<div class="entry" ${attrs}>`,
          '<div class="entry-header">',
          `<div class="graph"><span class="dot"></span><strong>r${entry.revision}</strong></div>`,
          `<span class="entry-meta">${this.escapeHtml(entry.author)} · ${this.escapeHtml(entry.date || '')}</span>`,
          '</div>',
          `<div>${this.escapeHtml(entry.message || '')}</div>`,
          `<div class="entry-meta">${entry.changedPathCount} files changed</div>`,
          '</div>',
        ].join('');
      })
      .join('');
  }

  private renderChipsHtml(paths: PanelEntryPreviewPath[]): string {
    return paths
      .map(
        (item) =>
          `<span class="chip"><strong>${this.escapeHtml(item.action)}</strong>${this.escapeHtml(this.shortPath(item.path))}</span>`,
      )
      .join('');
  }

  private renderDetailsHtml(entry: SvnLogEntry | undefined, mode: PanelState['mode'], previousRevision?: number): string {
    if (!entry) {
      return '当前筛选条件下没有可显示的提交记录。';
    }

    const lines = [
      `Revision: r${entry.revision}`,
      `Author: ${entry.author}`,
      `Date: ${entry.date || ''}`,
      '',
      entry.message || '',
      '',
      'Changed Paths:',
      ...entry.changedPaths.map((item) => `${item.action} ${item.path}`),
    ];

    const compareButton =
      mode === 'file' && previousRevision
        ? `<div class="details-actions"><button class="detail-button" data-action="compare" data-left-revision="${previousRevision}" data-right-revision="${entry.revision}">与上一版本比较</button></div>`
        : '';

    return `${this.escapeHtml(lines.join('\n'))}${compareButton}`;
  }

  private getLane(entry: PanelEntrySummary): string {
    const firstPath = entry.firstPath || '';
    const normalized = String(firstPath).replace(/^\//, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts[0] === 'branches') {
      return parts[1] ? `br:${parts[1]}` : 'branches';
    }
    if (parts[0] === 'tags') {
      return parts[1] ? `tag:${parts[1]}` : 'tags';
    }
    return parts[0] || 'repo';
  }

  private shortPath(value: string): string {
    const normalized = String(value || '').replace(/^\//, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 3) {
      return normalized || 'repo';
    }
    return parts.slice(0, 2).concat('…').concat(parts.slice(-1)).join('/');
  }

  private escapeHtml(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async syncSelectionFromPayload(state: PanelState, payload: PanelPagePayload): Promise<void> {
    if (!this.onDidSelectRevision) {
      return;
    }

    const revision = payload.entries[0]?.revision;
    if (!revision) {
      this.onDidSelectRevision(undefined);
      return;
    }

    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository) {
      this.onDidSelectRevision(undefined);
      return;
    }

    const targetUri = state.mode === 'file' && state.filePath ? vscode.Uri.file(state.filePath) : undefined;
    const entry = await repository.getRevisionLog(revision, targetUri).catch(() => undefined);
    if (!entry) {
      this.onDidSelectRevision(undefined);
      return;
    }

    this.onDidSelectRevision({
      repository,
      entry,
      previousRevision: payload.entries[1]?.revision,
      targetUri,
    });
  }

  private renderHtml(title: string, initialPage: PanelPagePayload): string {
    const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const initialPageJson = JSON.stringify(initialPage).replace(/</g, '\\u003c');
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
      width: 100%;
      font: inherit;
      color: inherit;
      box-sizing: border-box;
    }
    .entry-trigger {
      display: contents;
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
    .details-actions {
      margin-top: 12px;
    }
    .detail-button {
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 10px 12px;
      background: rgba(255,255,255,0.08);
      color: inherit;
      cursor: pointer;
    }
    .empty-state {
      padding: 24px 20px;
      border: 1px dashed var(--border);
      border-radius: 16px;
      color: var(--muted);
      text-align: center;
      background: rgba(255,255,255,0.05);
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
    const initialPage = ${initialPageJson};
    let currentPage = Number(initialPage.page || 0);
    let latestPage = { hasMore: false, mode: 'log', filePath: undefined, entries: [], error: undefined };
    const list = document.getElementById('list');
    const details = document.getElementById('details');
    const author = document.getElementById('author');
    const from = document.getElementById('from');
    const to = document.getElementById('to');

    function query(page) {
      currentPage = Math.max(0, page);
      details.textContent = '正在加载提交记录...';
      vscode.postMessage({
        type: 'query',
        page: currentPage,
        author: author.value,
        from: from.value,
        to: to.value
      });
    }

    function applyPage(message) {
      latestPage = { ...latestPage, entries: message.entries || [], mode: message.mode, filePath: message.filePath, error: message.error, hasMore: !!message.hasMore };
      list.innerHTML = message.listHtml || '';
      details.innerHTML = message.detailsHtml || '当前筛选条件下没有可显示的提交记录。';
    }

    function requestDetailsFromElement(element) {
      const revision = Number(element.dataset.revision || 0);
      const previousRevision = Number(element.dataset.previousRevision || 0) || undefined;
      if (!revision) {
        return;
      }
      details.textContent = '正在加载 r' + revision + ' 的详细信息...';
      vscode.postMessage({ type: 'details', revision, previousRevision });
    }

    function closestElement(target, selector) {
      if (!target) {
        return null;
      }
      if (typeof target.closest === 'function') {
        return target.closest(selector);
      }
      if (target.parentElement && typeof target.parentElement.closest === 'function') {
        return target.parentElement.closest(selector);
      }
      return null;
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'page') {
        applyPage(message);
      }
      if (message.type === 'details') {
        details.innerHTML = message.html || ('加载详情失败：' + (message.error || '未知错误'));
      }
    });

    list.addEventListener('click', (event) => {
      const target = closestElement(event.target, '[data-revision]');
      if (target) {
        requestDetailsFromElement(target);
      }
    });

    list.addEventListener('keydown', (event) => {
      const target = closestElement(event.target, '[data-revision]');
      if (target && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        requestDetailsFromElement(target);
      }
    });

    details.addEventListener('click', (event) => {
      const target = closestElement(event.target, '[data-action="compare"]');
      if (!target) {
        return;
      }
      vscode.postMessage({
        type: 'compare',
        leftRevision: target.dataset.leftRevision,
        rightRevision: target.dataset.rightRevision,
      });
    });

    document.getElementById('apply').addEventListener('click', () => query(0));
    document.getElementById('reload').addEventListener('click', () => query(currentPage));
    document.getElementById('prev').addEventListener('click', () => query(Math.max(0, currentPage - 1)));
    document.getElementById('next').addEventListener('click', () => {
      if (latestPage.hasMore) {
        query(currentPage + 1);
      }
    });

    applyPage(initialPage);
  </script>
</body>
</html>`;
  }
}