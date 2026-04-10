import * as vscode from 'vscode';
import { getLogPageSize } from '../config';
import { SvnRepository } from '../services/svnRepository';

type RepositoryResolver = (rootUri: vscode.Uri) => SvnRepository | undefined;

interface DashboardState {
  repositoryRoot: string;
  currentUrl?: string;
}

export class RepositoryDashboardPanel implements vscode.Disposable {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; state: DashboardState }>();

  public constructor(private readonly resolveRepository: RepositoryResolver) {}

  public getPanelKeys(): string[] {
    return [...this.panels.keys()];
  }

  public async show(repository: SvnRepository): Promise<void> {
    const key = `dashboard:${repository.rootUri.toString()}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      await this.sendState(existing.panel, existing.state);
      return;
    }

    const roots = await repository.getRepoBrowserRoots();
    const panel = vscode.window.createWebviewPanel(
      'svnLens.dashboard',
      `SVN Workspace • ${repository.displayBranch}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const state: DashboardState = {
      repositoryRoot: repository.rootUri.toString(),
      currentUrl: roots[0]?.url,
    };
    this.panels.set(key, { panel, state });
    panel.webview.html = this.renderHtml();
    panel.onDidDispose(() => {
      this.panels.delete(key);
    });

    panel.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
      if (message.type === 'ready' || message.type === 'refresh') {
        await this.sendState(panel, state);
        return;
      }

      const targetRepository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
      if (!targetRepository) {
        return;
      }

      if (message.type === 'root' && typeof message.url === 'string') {
        state.currentUrl = message.url;
        targetRepository.setRepoBrowserRoot(message.url);
        await this.sendState(panel, state);
        return;
      }

      if (message.type === 'navigate' && typeof message.url === 'string') {
        state.currentUrl = message.url;
        await this.sendState(panel, state);
        return;
      }

      if (message.type === 'up') {
        const parentUrl = this.computeParentUrl(state.currentUrl);
        if (parentUrl) {
          state.currentUrl = parentUrl;
          await this.sendState(panel, state);
        }
        return;
      }

      if (message.type === 'open' && typeof message.url === 'string') {
        await targetRepository.openRemote(message.url);
      }
    });

    await this.sendState(panel, state);
  }

  public dispose(): void {
    for (const { panel } of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  private async sendState(panel: vscode.WebviewPanel, state: DashboardState): Promise<void> {
    const repository = this.resolveRepository(vscode.Uri.parse(state.repositoryRoot));
    if (!repository) {
      return;
    }

    const roots = await repository.getRepoBrowserRoots();
    const currentUrl = state.currentUrl ?? roots[0]?.url;
    const items = currentUrl ? await repository.listRemote(currentUrl) : [];
    const logPage = await repository.getLogPage({
      page: 0,
      pageSize: Math.min(25, getLogPageSize(repository.rootUri)),
    });

    await panel.webview.postMessage({
      type: 'state',
      roots,
      currentUrl,
      items,
      graphEntries: logPage.entries,
      branch: repository.displayBranch,
      revision: repository.revision,
    });
  }

  private computeParentUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length === 0) {
        return url;
      }
      segments.pop();
      parsed.pathname = `/${segments.join('/')}`;
      return parsed.toString().replace(/\/$/, '') || url;
    } catch {
      return undefined;
    }
  }

  private renderHtml(): string {
    const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SVN Workspace</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: radial-gradient(circle at top left, rgba(10,95,82,0.28), transparent 38%), linear-gradient(145deg, rgba(15,23,42,0.06), rgba(214,174,88,0.08));
      --panel: rgba(255,255,255,0.06);
      --panel-strong: rgba(10,95,82,0.12);
      --border: rgba(148,163,184,0.24);
      --accent: #0a5f52;
      --accent-soft: rgba(10,95,82,0.12);
      --muted: #6b7280;
      --text: var(--vscode-editor-foreground);
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: 'Avenir Next', 'Segoe UI', sans-serif;
    }
    .shell {
      padding: 18px;
      display: grid;
      gap: 16px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: linear-gradient(145deg, var(--panel-strong), rgba(214,174,88,0.08));
    }
    .hero h1 {
      margin: 0;
      font-size: 1.2rem;
      letter-spacing: 0.02em;
    }
    .hero p {
      margin: 6px 0 0;
      color: var(--muted);
    }
    .hero .badge {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      border: 1px solid var(--border);
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(320px, 0.95fr) minmax(360px, 1.05fr);
      gap: 16px;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--panel);
      backdrop-filter: blur(10px);
      overflow: hidden;
    }
    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .panel-header strong {
      font-size: 0.95rem;
      letter-spacing: 0.02em;
    }
    .panel-body {
      padding: 14px 16px 16px;
      display: grid;
      gap: 12px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
    }
    select, button {
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.08);
      color: inherit;
      padding: 10px 12px;
      box-sizing: border-box;
    }
    button {
      cursor: pointer;
    }
    .path {
      font-size: 0.85rem;
      color: var(--muted);
      word-break: break-all;
    }
    .items, .graph {
      display: grid;
      gap: 10px;
      max-height: 65vh;
      overflow: auto;
    }
    .item, .entry {
      border-radius: 14px;
      border: 1px solid var(--border);
      padding: 12px 14px;
      background: rgba(255,255,255,0.05);
    }
    .item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .item-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .item-main strong, .entry strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-meta, .entry-meta {
      color: var(--muted);
      font-size: 0.82rem;
    }
    .item-actions {
      display: flex;
      gap: 8px;
    }
    .item-actions button.primary {
      background: var(--accent);
      color: white;
    }
    .entry {
      position: relative;
      padding-left: 18px;
    }
    .entry::before {
      content: '';
      position: absolute;
      left: 6px;
      top: 18px;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .chip {
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--border);
      font-size: 0.76rem;
      color: var(--muted);
    }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .toolbar {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div>
        <h1>SVN Workspace Dashboard</h1>
        <p id="summary">Loading repository state…</p>
      </div>
      <div id="badge" class="badge">r0</div>
    </div>
    <div class="grid">
      <section class="panel">
        <div class="panel-header">
          <strong>Remote Browser</strong>
        </div>
        <div class="panel-body">
          <div class="toolbar">
            <select id="rootSelect"></select>
            <button id="upButton">Up</button>
            <button id="refreshButton">Refresh</button>
          </div>
          <div id="currentPath" class="path"></div>
          <div id="items" class="items"></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <strong>Recent Graph</strong>
        </div>
        <div class="panel-body">
          <div id="graph" class="graph"></div>
        </div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const summary = document.getElementById('summary');
    const badge = document.getElementById('badge');
    const rootSelect = document.getElementById('rootSelect');
    const currentPath = document.getElementById('currentPath');
    const items = document.getElementById('items');
    const graph = document.getElementById('graph');

    function escapeHtml(value) {
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function shortPath(value) {
      const parts = String(value || '').split('/').filter(Boolean);
      if (parts.length <= 3) {
        return parts.join('/');
      }
      return parts.slice(0, 2).concat('…').concat(parts.slice(-1)).join('/');
    }

    function renderState(state) {
      summary.textContent = state.branch + ' • ' + (state.currentUrl || 'No remote root');
      badge.textContent = 'r' + state.revision;
      currentPath.textContent = state.currentUrl || '';

      rootSelect.innerHTML = '';
      (state.roots || []).forEach(root => {
        const option = document.createElement('option');
        option.value = root.url;
        option.textContent = root.label + ' — ' + root.description;
        if (root.url === state.currentUrl) {
          option.selected = true;
        }
        rootSelect.appendChild(option);
      });

      items.innerHTML = '';
      (state.items || []).forEach(item => {
        const wrapper = document.createElement('div');
        wrapper.className = 'item';
        const primaryLabel = item.kind === 'dir' ? 'Browse' : 'Open';
        wrapper.innerHTML = [
          '<div class="item-main">',
          '<strong>' + escapeHtml(item.name) + '</strong>',
          '<div class="item-meta">' + escapeHtml(item.kind === 'dir' ? 'directory' : 'file') + (item.revision ? ' • r' + item.revision : '') + '</div>',
          '</div>',
          '<div class="item-actions">',
          '<button class="primary" data-action="primary">' + primaryLabel + '</button>',
          (item.kind === 'dir' ? '<button data-action="open">Open</button>' : ''),
          '</div>'
        ].join('');

        wrapper.querySelector('[data-action="primary"]').addEventListener('click', () => {
          if (item.kind === 'dir') {
            vscode.postMessage({ type: 'navigate', url: item.url });
          } else {
            vscode.postMessage({ type: 'open', url: item.url });
          }
        });

        const secondary = wrapper.querySelector('[data-action="open"]');
        if (secondary) {
          secondary.addEventListener('click', () => {
            vscode.postMessage({ type: 'open', url: item.url });
          });
        }
        items.appendChild(wrapper);
      });

      graph.innerHTML = '';
      (state.graphEntries || []).forEach(entry => {
        const wrapper = document.createElement('div');
        wrapper.className = 'entry';
        wrapper.innerHTML = [
          '<strong>r' + entry.revision + ' · ' + escapeHtml(entry.author) + '</strong>',
          '<div class="entry-meta">' + escapeHtml(entry.date || '') + '</div>',
          '<div>' + escapeHtml(entry.message || '') + '</div>',
          '<div class="chips">' + (entry.changedPaths || []).slice(0, 5).map(item => '<span class="chip">' + escapeHtml(item.action + ' ' + shortPath(item.path)) + '</span>').join('') + '</div>'
        ].join('');
        graph.appendChild(wrapper);
      });
    }

    rootSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'root', url: rootSelect.value });
    });
    document.getElementById('upButton').addEventListener('click', () => {
      vscode.postMessage({ type: 'up' });
    });
    document.getElementById('refreshButton').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        renderState(message);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
