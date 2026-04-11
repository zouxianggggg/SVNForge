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
  entryCache: Map<number, { entry: SvnLogEntry; previousRevision?: number }>;
  selectedRevision?: number;
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
  requestId?: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  mode: PanelState['mode'];
  entries: PanelEntrySummary[];
  listHtml: string;
  detailsHtml: string;
  resultLabel: string;
  selectedRevision?: number;
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
    const state: PanelState = { mode, repositoryRoot: repository.rootUri.toString(), entryCache: new Map() };
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
      entryCache: new Map(),
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
        }, typeof message.requestId === 'number' ? message.requestId : undefined);
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
          typeof message.requestId === 'number' ? message.requestId : undefined,
        );
      }
    });
  }

  private async sendPage(
    panel: vscode.WebviewPanel,
    state: PanelState,
    page: number,
    filters: { author?: string; from?: string; to?: string } | undefined,
    requestId?: number,
  ): Promise<void> {
    const startedAt = Date.now();
    const payload = await this.getPagePayload(state, page, filters, requestId);
    payload.resultLabel = `${payload.resultLabel} · ${Date.now() - startedAt} ms`;
    await panel.webview.postMessage(payload);
    await this.syncSelectionFromPayload(state, payload);
  }

  private async getPagePayload(
    state: PanelState,
    page: number,
    filters: { author?: string; from?: string; to?: string } | undefined,
    requestId?: number,
  ): Promise<PanelPagePayload> {
    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository) {
      return {
        type: 'page',
        requestId,
        page,
        pageSize: 0,
        hasMore: false,
        mode: state.mode,
        entries: [],
        listHtml: '<div class="empty-state">当前工作区没有可用的 SVN 仓库。</div>',
        detailsHtml: '当前工作区没有可用的 SVN 仓库。',
        resultLabel: '未找到 SVN 仓库',
        selectedRevision: undefined,
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
      this.primeEntryCache(state, result.entries);
      const summaries = result.entries.map((entry) => this.toPanelEntrySummary(entry));
      const selectedRevision = result.entries[0]?.revision;
      state.selectedRevision = selectedRevision;

      return {
        type: 'page',
        requestId,
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        mode: state.mode,
        entries: summaries,
        listHtml: this.renderListHtml(summaries, state.mode),
        detailsHtml: this.renderDetailsHtml(result.entries[0], state.mode, result.entries[1]?.revision),
        resultLabel: this.buildResultLabel(state.mode, result.page, result.entries.length, result.hasMore),
        selectedRevision,
        filePath: state.filePath,
        error: undefined,
      };
    } catch (error) {
      state.entryCache.clear();
      state.selectedRevision = undefined;
      return {
        type: 'page',
        requestId,
        page,
        pageSize: getLogPageSize(repository.rootUri),
        hasMore: false,
        mode: state.mode,
        entries: [],
        listHtml: `<div class="empty-state">加载提交记录失败：${this.escapeHtml(error instanceof Error ? error.message : String(error))}</div>`,
        detailsHtml: error instanceof Error ? error.message : String(error),
        resultLabel: '加载失败',
        selectedRevision: undefined,
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
    requestId?: number,
  ): Promise<void> {
    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository || revision <= 0) {
      await panel.webview.postMessage({
        type: 'details',
        requestId,
        revision,
        html: this.escapeHtml('无法读取该修订版本的详细信息。'),
        error: '无法读取该修订版本的详细信息。',
        summary: '无法读取详细信息',
      });
      return;
    }

    try {
      const target = state.mode === 'file' && state.filePath ? vscode.Uri.file(state.filePath) : undefined;
      const cached = state.entryCache.get(revision);
      const resolvedPreviousRevision = previousRevision ?? cached?.previousRevision;
      const detail = cached?.entry ?? (await repository.getRevisionLog(revision, target));
      if (!detail) {
        await panel.webview.postMessage({
          type: 'details',
          requestId,
          revision,
          html: this.escapeHtml(`未找到 r${revision} 的详细信息。`),
          error: `未找到 r${revision} 的详细信息。`,
          summary: `r${revision} 不存在`,
        });
        return;
      }

      state.entryCache.set(revision, { entry: detail, previousRevision: resolvedPreviousRevision });
      state.selectedRevision = revision;

      await panel.webview.postMessage({
        type: 'details',
        requestId,
        revision,
        html: this.renderDetailsHtml(detail, state.mode, resolvedPreviousRevision),
        error: undefined,
        summary: `已加载 r${revision} 详情`,
      });
      this.pushRevisionSelection(repository, state, detail, resolvedPreviousRevision);
    } catch (error) {
      await panel.webview.postMessage({
        type: 'details',
        requestId,
        revision,
        html: this.escapeHtml(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
        summary: `加载 r${revision} 失败`,
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
            `<div class="graph"><strong>r${entry.revision}</strong><span class="entry-count">${entry.changedPathCount} paths</span></div>`,
            `<span class="entry-meta">${this.escapeHtml(entry.author)} · ${this.escapeHtml(entry.date || '')}</span>`,
            '</div>',
            `<div class="entry-subject">${this.escapeHtml(this.getMessageSubject(entry.message) || 'No commit message')}</div>`,
            `<div class="entry-body">${this.escapeHtml(this.getMessageExcerpt(entry.message))}</div>`,
            `<div class="chips">${this.renderChipsHtml(entry.previewPaths)}</div>`,
            entry.copyNote ? `<div class="copy-note">${this.escapeHtml(entry.copyNote)}</div>` : '',
            '</div>',
            '</div>',
          ].join('');
        }

        return [
          `<div class="entry" ${attrs}>`,
          '<div class="entry-header">',
          `<div class="graph"><span class="dot"></span><strong>r${entry.revision}</strong><span class="entry-count">${entry.changedPathCount} files</span></div>`,
          `<span class="entry-meta">${this.escapeHtml(entry.author)} · ${this.escapeHtml(entry.date || '')}</span>`,
          '</div>',
          `<div class="entry-subject">${this.escapeHtml(this.getMessageSubject(entry.message) || 'No commit message')}</div>`,
          `<div class="entry-body">${this.escapeHtml(this.getMessageExcerpt(entry.message))}</div>`,
          entry.previewPaths.length > 0 ? `<div class="chips">${this.renderChipsHtml(entry.previewPaths)}</div>` : '',
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
      return '<div class="empty-state details-empty">当前筛选条件下没有可显示的提交记录。</div>';
    }

    const compareButton =
      mode === 'file' && previousRevision
        ? `<div class="details-actions"><button class="detail-button" data-action="compare" data-left-revision="${previousRevision}" data-right-revision="${entry.revision}">与上一版本比较</button></div>`
        : '';

    return [
      '<div class="details-card">',
      '<div class="details-header">',
      `<div class="details-title"><span class="revision-pill">r${entry.revision}</span><strong>${this.escapeHtml(this.getMessageSubject(entry.message) || 'No commit message')}</strong></div>`,
      `<div class="entry-meta">${this.escapeHtml(entry.author)} · ${this.escapeHtml(entry.date || '')}</div>`,
      '</div>',
      `<div class="details-message">${this.escapeHtml(entry.message || 'No commit message').replace(/\n/g, '<br />')}</div>`,
      '<div class="details-section">',
      `<div class="details-section-title">Changed Paths <span class="entry-count">${entry.changedPaths.length}</span></div>`,
      '<div class="details-paths">',
      ...entry.changedPaths.map((item) =>
        `<div class="details-path"><span class="path-action action-${this.escapeHtml(item.action)}">${this.escapeHtml(item.action)}</span><span class="path-text">${this.escapeHtml(item.path)}</span></div>`),
      '</div>',
      '</div>',
      compareButton,
      '</div>',
    ].join('');
  }

  private primeEntryCache(state: PanelState, entries: readonly SvnLogEntry[]): void {
    state.entryCache.clear();
    entries.forEach((entry, index) => {
      state.entryCache.set(entry.revision, {
        entry,
        previousRevision: entries[index + 1]?.revision,
      });
    });
  }

  private buildResultLabel(mode: PanelState['mode'], page: number, count: number, hasMore: boolean): string {
    const modeLabel = mode === 'graph' ? 'Graph' : mode === 'file' ? 'File History' : 'Log';
    return `${modeLabel} · 第 ${page + 1} 页 · ${count} 条${hasMore ? '，可继续翻页' : ''}`;
  }

  private pushRevisionSelection(
    repository: SvnRepository,
    state: PanelState,
    entry: SvnLogEntry,
    previousRevision?: number,
  ): void {
    this.onDidSelectRevision?.({
      repository,
      entry,
      previousRevision,
      targetUri: state.mode === 'file' && state.filePath ? vscode.Uri.file(state.filePath) : undefined,
    });
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

    const revision = payload.selectedRevision ?? payload.entries[0]?.revision;
    if (!revision) {
      state.selectedRevision = undefined;
      this.onDidSelectRevision(undefined);
      return;
    }

    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository) {
      this.onDidSelectRevision(undefined);
      return;
    }

    const cached = state.entryCache.get(revision)?.entry;
    const previousRevision = state.entryCache.get(revision)?.previousRevision ?? payload.entries[1]?.revision;
    const entry = cached;
    if (!entry) {
      this.onDidSelectRevision(undefined);
      return;
    }

    state.selectedRevision = revision;
    this.pushRevisionSelection(repository, state, entry, previousRevision);
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
      --page-bg: var(--vscode-editor-background);
      --card-bg: var(--vscode-sideBar-background);
      --card-muted-bg: var(--vscode-editorWidget-background);
      --card-hover: var(--vscode-list-hoverBackground);
      --card-active: var(--vscode-list-activeSelectionBackground);
      --border: var(--vscode-widget-border, var(--vscode-panel-border));
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-foreground: var(--vscode-button-foreground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --input-foreground: var(--vscode-input-foreground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --link: var(--vscode-textLink-foreground);
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
    }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--text);
      background: var(--page-bg);
      min-height: 100vh;
    }
    .shell {
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    .topbar, .pane, .entry, .details-card {
      border: 1px solid var(--border);
      background: var(--card-bg);
      border-radius: 10px;
      box-shadow: var(--shadow);
    }
    .topbar {
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .hero-copy {
      display: grid;
      gap: 6px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .hero h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 600;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 24px;
      color: var(--muted);
      font-size: 12px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--badge-bg);
      opacity: 0.85;
    }
    .status[data-busy="true"] .status-dot {
      animation: pulse 1.1s ease-in-out infinite;
      background: var(--accent);
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto auto;
      gap: 10px;
    }
    .toolbar input, .toolbar button, .pager button {
      width: 100%;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid var(--input-border);
      padding: 8px 10px;
      background: var(--input-bg);
      color: var(--input-foreground);
    }
    .toolbar button.primary {
      cursor: pointer;
      background: var(--accent);
      color: var(--accent-foreground);
      font-weight: 600;
    }
    .toolbar button.secondary, .pager button {
      cursor: pointer;
      background: var(--card-muted-bg);
      color: var(--text);
    }
    .toolbar button:disabled, .pager button:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .content {
      display: grid;
      grid-template-columns: minmax(340px, 0.95fr) minmax(320px, 1.05fr);
      gap: 12px;
      align-items: start;
    }
    .pane {
      min-height: 540px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      overflow: hidden;
    }
    .pane-header {
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--card-bg) 84%, transparent);
    }
    .pane-title {
      font-size: 13px;
      font-weight: 600;
    }
    .pane-meta {
      color: var(--muted);
      font-size: 12px;
    }
    .list-wrap {
      position: relative;
      min-height: 320px;
    }
    .list {
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .entry {
      padding: 12px 14px;
      display: grid;
      gap: 8px;
      text-align: left;
      cursor: pointer;
      width: 100%;
      font: inherit;
      color: inherit;
      box-sizing: border-box;
      border-radius: 8px;
      background: var(--card-muted-bg);
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
      box-shadow: none;
    }
    .entry-trigger {
      display: contents;
    }
    .entry:hover {
      background: var(--card-hover);
    }
    .entry.is-selected {
      background: var(--card-active);
      border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
    }
    .entry.graph-mode {
      grid-template-columns: 68px minmax(0, 1fr);
      align-items: start;
    }
    .entry-header {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
    }
    .entry-meta {
      color: var(--muted);
      font-size: 12px;
    }
    .graph {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .entry-subject {
      font-weight: 600;
      line-height: 1.35;
    }
    .entry-body {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .entry-count, .revision-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 20px;
      padding: 0 8px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 11px;
      font-weight: 600;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 24%, transparent);
    }
    .rail {
      display: grid;
      justify-items: center;
      gap: 8px;
    }
    .rail::after {
      content: '';
      width: 2px;
      min-height: 64px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 55%, transparent), transparent);
    }
    .lane-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 48px;
      padding: 4px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--badge-bg) 75%, transparent);
      color: var(--badge-fg);
      font-size: 11px;
      font-weight: 700;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: transparent;
      font-size: 11px;
      color: var(--muted);
    }
    .chip strong {
      color: var(--text);
    }
    .copy-note {
      color: var(--muted);
      font-size: 12px;
    }
    .details {
      padding: 12px;
      overflow: auto;
    }
    .details-empty {
      margin: 0;
    }
    .details-card {
      padding: 14px;
      display: grid;
      gap: 14px;
      background: var(--card-muted-bg);
    }
    .details-header {
      display: grid;
      gap: 6px;
    }
    .details-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      line-height: 1.4;
    }
    .details-message {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card-bg);
      line-height: 1.55;
    }
    .details-section {
      display: grid;
      gap: 10px;
    }
    .details-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .details-paths {
      display: grid;
      gap: 6px;
    }
    .details-path {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card-bg);
    }
    .path-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }
    .path-text {
      word-break: break-word;
      line-height: 1.45;
    }
    .details-actions {
      margin-top: -2px;
    }
    .detail-button {
      border-radius: 6px;
      border: 1px solid var(--input-border);
      padding: 8px 10px;
      background: var(--card-bg);
      color: var(--text);
      cursor: pointer;
    }
    .empty-state {
      padding: 28px 20px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      background: var(--card-muted-bg);
    }
    .pager {
      display: flex;
      gap: 10px;
      padding: 12px;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--card-bg) 84%, transparent);
    }
    .pager button {
      flex: 1;
    }
    .busy-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: color-mix(in srgb, var(--page-bg) 72%, transparent);
      backdrop-filter: blur(2px);
      z-index: 2;
    }
    .busy-overlay.hidden {
      display: none;
    }
    .busy-card {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text);
      font-size: 12px;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
      border-top-color: var(--accent);
      animation: spin 0.8s linear infinite;
    }
    .skeleton {
      display: grid;
      gap: 10px;
    }
    .skeleton-line {
      height: 12px;
      border-radius: 999px;
      background: linear-gradient(90deg, color-mix(in srgb, var(--card-muted-bg) 86%, transparent), color-mix(in srgb, var(--badge-bg) 22%, transparent), color-mix(in srgb, var(--card-muted-bg) 86%, transparent));
      background-size: 200% 100%;
      animation: shimmer 1.4s ease infinite;
    }
    .skeleton-line.wide { width: 100%; }
    .skeleton-line.medium { width: 68%; }
    .skeleton-line.short { width: 42%; }
    .hidden {
      display: none;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 0.8; }
      50% { transform: scale(1.25); opacity: 1; }
    }
    @keyframes shimmer {
      from { background-position: 200% 0; }
      to { background-position: -200% 0; }
    }
    @media (max-width: 900px) {
      .hero {
        display: grid;
      }
      .toolbar {
        grid-template-columns: 1fr 1fr;
      }
      .content {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="hero">
        <div class="hero-copy">
          <div class="eyebrow">SVNForge</div>
          <h1>${title}</h1>
          <div id="status" class="status" data-busy="false"><span class="status-dot"></span><span id="statusText">准备就绪</span></div>
        </div>
        <div id="resultMeta" class="pane-meta"></div>
      </div>
      <div class="toolbar">
        <input id="author" placeholder="作者过滤" />
        <input id="from" placeholder="开始时间，例如 2024-01-01" />
        <input id="to" placeholder="结束时间，例如 2024-12-31" />
        <button id="apply" class="primary">应用过滤</button>
        <button id="reload" class="secondary">刷新</button>
      </div>
    </div>
    <div class="content">
      <section class="pane">
        <div class="pane-header">
          <div class="pane-title">Revisions</div>
          <div id="listMeta" class="pane-meta"></div>
        </div>
        <div class="list-wrap">
          <div id="busyOverlay" class="busy-overlay hidden"><div class="busy-card"><span class="spinner"></span><span id="busyText">正在加载提交记录...</span></div></div>
          <div id="list" class="list"></div>
        </div>
        <div class="pager">
          <button id="prev">上一页</button>
          <button id="next">下一页</button>
        </div>
      </section>
      <section class="pane">
        <div class="pane-header">
          <div class="pane-title">Details</div>
          <div id="detailsMeta" class="pane-meta"></div>
        </div>
        <div id="details" class="details">选择一条提交记录以查看详细信息。</div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialPage = ${initialPageJson};
    let currentPage = Number(initialPage.page || 0);
    let latestPage = { hasMore: false, mode: 'log', filePath: undefined, entries: [], error: undefined };
    let latestQueryRequestId = 0;
    let latestDetailRequestId = 0;
    let currentSelectionRevision = Number(initialPage.selectedRevision || 0);
    const list = document.getElementById('list');
    const details = document.getElementById('details');
    const author = document.getElementById('author');
    const from = document.getElementById('from');
    const to = document.getElementById('to');
    const applyButton = document.getElementById('apply');
    const reloadButton = document.getElementById('reload');
    const prevButton = document.getElementById('prev');
    const nextButton = document.getElementById('next');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const resultMeta = document.getElementById('resultMeta');
    const listMeta = document.getElementById('listMeta');
    const detailsMeta = document.getElementById('detailsMeta');
    const busyOverlay = document.getElementById('busyOverlay');
    const busyText = document.getElementById('busyText');

    function renderSkeleton() {
      return [
        '<div class="skeleton">',
        '<div class="skeleton-line wide"></div>',
        '<div class="skeleton-line medium"></div>',
        '<div class="skeleton-line short"></div>',
        '<div class="skeleton-line wide"></div>',
        '<div class="skeleton-line medium"></div>',
        '</div>'
      ].join('');
    }

    function setStatus(message, busy) {
      status.dataset.busy = busy ? 'true' : 'false';
      statusText.textContent = message;
    }

    function syncControls() {
      const queryBusy = busyOverlay && !busyOverlay.classList.contains('hidden');
      author.disabled = queryBusy;
      from.disabled = queryBusy;
      to.disabled = queryBusy;
      applyButton.disabled = queryBusy;
      reloadButton.disabled = queryBusy;
      prevButton.disabled = queryBusy || currentPage <= 0;
      nextButton.disabled = queryBusy || !latestPage.hasMore;
    }

    function setQueryBusy(isBusy, message) {
      busyOverlay.classList.toggle('hidden', !isBusy);
      busyText.textContent = message;
      setStatus(message, isBusy);
      syncControls();
    }

    function setDetailsBusy(message) {
      details.innerHTML = renderSkeleton();
      detailsMeta.textContent = message;
      setStatus(message, true);
    }

    function query(page) {
      currentPage = Math.max(0, page);
      latestQueryRequestId += 1;
      setQueryBusy(true, '正在加载提交记录...');
      detailsMeta.textContent = '等待列表结果';
      vscode.postMessage({
        type: 'query',
        requestId: latestQueryRequestId,
        page: currentPage,
        author: author.value,
        from: from.value,
        to: to.value
      });
    }

    function applyPage(message) {
      latestPage = { ...latestPage, entries: message.entries || [], mode: message.mode, filePath: message.filePath, error: message.error, hasMore: !!message.hasMore };
      currentSelectionRevision = Number(message.selectedRevision || 0);
      list.innerHTML = message.listHtml || '';
      details.innerHTML = message.detailsHtml || '当前筛选条件下没有可显示的提交记录。';
      resultMeta.textContent = message.resultLabel || '';
      listMeta.textContent = message.resultLabel || '';
      detailsMeta.textContent = currentSelectionRevision ? ('当前选中 r' + currentSelectionRevision) : '没有选中 revision';
      setQueryBusy(false, message.error ? ('加载失败：' + message.error) : (message.resultLabel || '加载完成'));
      updateSelectionState();
    }

    function requestDetailsFromElement(element) {
      const revision = Number(element.dataset.revision || 0);
      const previousRevision = Number(element.dataset.previousRevision || 0) || undefined;
      if (!revision) {
        return;
      }
      latestDetailRequestId += 1;
      currentSelectionRevision = revision;
      updateSelectionState();
      setDetailsBusy('正在加载 r' + revision + ' 详情...');
      vscode.postMessage({ type: 'details', requestId: latestDetailRequestId, revision, previousRevision });
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
        if (typeof message.requestId === 'number' && message.requestId !== latestQueryRequestId) {
          return;
        }
        applyPage(message);
      }
      if (message.type === 'details') {
        if (typeof message.requestId === 'number' && message.requestId !== latestDetailRequestId) {
          return;
        }
        details.innerHTML = message.html || ('加载详情失败：' + (message.error || '未知错误'));
        detailsMeta.textContent = message.summary || (message.error ? '加载失败' : '详情已更新');
        setStatus(message.error ? ('加载失败：' + message.error) : (message.summary || '详情已更新'), false);
        updateSelectionState();
      }
    });

    function updateSelectionState() {
      list.querySelectorAll('[data-revision]').forEach((item) => {
        const revision = Number(item.dataset.revision || 0);
        item.classList.toggle('is-selected', revision === currentSelectionRevision);
      });
      detailsMeta.textContent = currentSelectionRevision ? ('当前选中 r' + currentSelectionRevision) : '没有选中 revision';
      syncControls();
    }

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

    applyButton.addEventListener('click', () => query(0));
    reloadButton.addEventListener('click', () => query(currentPage));
    prevButton.addEventListener('click', () => query(Math.max(0, currentPage - 1)));
    nextButton.addEventListener('click', () => {
      if (latestPage.hasMore) {
        query(currentPage + 1);
      }
    });

    applyPage(initialPage);
  </script>
</body>
</html>`;
  }

  private getMessageSubject(message: string | undefined): string | undefined {
    const subject = message?.split(/\r?\n/, 1)[0]?.trim();
    return subject ? subject : undefined;
  }

  private getMessageExcerpt(message: string | undefined): string {
    if (!message) {
      return '';
    }

    const normalized = message.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 140) {
      return normalized;
    }
    return `${normalized.slice(0, 139).trimEnd()}…`;
  }
}