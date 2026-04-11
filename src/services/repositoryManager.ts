import { RepositorySnapshot } from '../api';
import * as path from 'path';
import * as vscode from 'vscode';
import { SvnCli } from '../adapter/svnCli';
import { getAutoRefresh, getRefreshDebounceMs } from '../config';
import { ActionTreeProvider } from '../providers/actionTreeProvider';
import { BlameProvider } from '../providers/blameProvider';
import { BranchTreeItem, BranchTreeProvider } from '../providers/branchTreeProvider';
import { ConflictDecorator } from '../providers/conflictDecorator';
import { SvnContentProvider } from '../providers/contentProviders';
import { HistoryPanel } from '../providers/historyPanel';
import { RevisionDetailsItem, RevisionDetailsProvider, RevisionFileActionFilter, RevisionSelection } from '../providers/revisionDetailsProvider';
import { RepositoryDashboardPanel } from '../providers/repositoryDashboardPanel';
import { RepoBrowserItem, RepoBrowserProvider } from '../providers/repoBrowserProvider';
import { SVN_BASE_SCHEME, SVN_REMOTE_SCHEME, SVN_REVISION_SCHEME } from '../providers/uri';
import { JenkinsService } from './jenkinsService';
import { LogCache } from './logCache';
import { SvnRepository } from './svnRepository';

export class RepositoryManager implements vscode.Disposable {
  private readonly repositories = new Map<string, SvnRepository>();
  private readonly cli = new SvnCli();
  private readonly logCache: LogCache;
  private readonly jenkins = new JenkinsService();
  private readonly repoBrowserProvider: RepoBrowserProvider;
  private readonly branchTreeProvider: BranchTreeProvider;
  private readonly actionTreeProvider: ActionTreeProvider;
  private readonly revisionDetailsProvider: RevisionDetailsProvider;
  private readonly blameProvider: BlameProvider;
  private readonly conflictDecorator = new ConflictDecorator();
  private readonly historyPanel: HistoryPanel;
  private readonly dashboardPanel: RepositoryDashboardPanel;
  private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly autoRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private selectedRevision: RevisionSelection | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.logCache = new LogCache(context);
    this.repoBrowserProvider = new RepoBrowserProvider(() => this.getRepositories());
    this.branchTreeProvider = new BranchTreeProvider(() => this.getRepositories());
    this.actionTreeProvider = new ActionTreeProvider(() => this.getPreferredRepository(), () => vscode.window.activeTextEditor?.document.uri);
    this.revisionDetailsProvider = new RevisionDetailsProvider();
    this.historyPanel = new HistoryPanel((rootUri) => this.repositories.get(rootUri.fsPath), (selection) => this.setSelectedRevision(selection));
    this.dashboardPanel = new RepositoryDashboardPanel((rootUri) => this.repositories.get(rootUri.fsPath));
    this.blameProvider = new BlameProvider((uri) => this.getRepositoryForUri(uri));
  }

  public async activate(): Promise<void> {
    await this.logCache.initialize();

    const contentProvider = new SvnContentProvider((repoRoot, filePath) => {
      if (repoRoot) {
        const repository = this.repositories.get(repoRoot);
        if (repository) {
          return repository;
        }
      }
      if (filePath) {
        return this.getRepositoryForUri(vscode.Uri.file(filePath));
      }
      return undefined;
    });

    this.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SVN_BASE_SCHEME, contentProvider),
      vscode.workspace.registerTextDocumentContentProvider(SVN_REVISION_SCHEME, contentProvider),
      vscode.workspace.registerTextDocumentContentProvider(SVN_REMOTE_SCHEME, contentProvider),
      vscode.window.createTreeView('svnLens.actions', { treeDataProvider: this.actionTreeProvider }),
      vscode.window.createTreeView('svnLens.revisionDetails', { treeDataProvider: this.revisionDetailsProvider }),
      vscode.window.createTreeView('svnLens.repoBrowser', { treeDataProvider: this.repoBrowserProvider }),
      vscode.window.createTreeView('svnLens.branches', { treeDataProvider: this.branchTreeProvider }),
      this.statusBarItem,
      this.blameProvider,
      this.conflictDecorator,
      this.dashboardPanel,
      this.logCache,
    );

    this.registerCommands();
    this.registerEventHandlers();
    await this.scanWorkspace();
    await this.blameProvider.refreshActiveEditor();
    this.conflictDecorator.refresh();
  }

  public dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    for (const timer of this.autoRefreshTimers.values()) {
      clearTimeout(timer);
    }
    for (const repository of this.repositories.values()) {
      repository.dispose();
    }
  }

  public getRepositories(): readonly SvnRepository[] {
    return [...this.repositories.values()];
  }

  public async refreshAllFromApi(): Promise<void> {
    await this.scanWorkspace();
  }

  public async getRepositorySnapshots(): Promise<RepositorySnapshot[]> {
    const snapshots: RepositorySnapshot[] = [];
    for (const repository of this.getRepositories()) {
      const roots = await repository.getRepoBrowserRoots();
      snapshots.push({
        rootPath: repository.rootUri.fsPath,
        branch: repository.displayBranch,
        revision: repository.revision,
        statuses: repository.statuses.map((entry) => entry.status),
        repoBrowserRoots: roots.map((root) => root.url),
      });
    }
    return snapshots;
  }

  public getOpenPanelKeys(): string[] {
    return [...this.historyPanel.getPanelKeys(), ...this.dashboardPanel.getPanelKeys()];
  }

  public async getRepositoryLogPreview(
    rootPath: string,
    pageSize = 10,
  ): Promise<Array<{ revision: number; author: string; date: string; message: string }>> {
    const repository = this.repositories.get(rootPath);
    if (!repository) {
      return [];
    }

    const page = await repository.getLogPage({ page: 0, pageSize });
    return page.entries.map((entry) => ({
      revision: entry.revision,
      author: entry.author,
      date: entry.date,
      message: entry.message,
    }));
  }

  public async getFileHistoryPreview(
    filePath: string,
    pageSize = 10,
  ): Promise<Array<{ revision: number; author: string; date: string; message: string }>> {
    const fileUri = vscode.Uri.file(filePath);
    const repository = this.getRepositoryForUri(fileUri);
    if (!repository) {
      return [];
    }

    const page = await repository.getFileHistory(fileUri, { page: 0, pageSize });
    return page.entries.map((entry) => ({
      revision: entry.revision,
      author: entry.author,
      date: entry.date,
      message: entry.message,
    }));
  }

  public async getBlamePreview(
    filePath: string,
    maxLines = 10,
  ): Promise<Array<{ lineNumber: number; revision: number; author: string; date?: string }>> {
    const fileUri = vscode.Uri.file(filePath);
    const repository = this.getRepositoryForUri(fileUri);
    if (!repository) {
      return [];
    }

    const lines = await repository.getBlame(fileUri);
    return lines.slice(0, maxLines).map((line) => ({
      lineNumber: line.lineNumber,
      revision: line.revision,
      author: line.author,
      date: line.date,
    }));
  }

  public getRepositoryForUri(uri: vscode.Uri): SvnRepository | undefined {
    const target = uri.fsPath;
    return [...this.repositories.values()]
      .sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length)
      .find((repository) => target.startsWith(repository.rootUri.fsPath));
  }

  private registerEventHandlers(): void {
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.scanWorkspace();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.scheduleRefresh(document.uri);
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        event.files.forEach((file) => this.scheduleRefresh(file));
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        event.files.forEach((file) => this.scheduleRefresh(file));
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((change) => this.scheduleRefresh(change.newUri));
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatusBar();
        this.actionTreeProvider.refresh();
        this.conflictDecorator.refresh();
        void this.blameProvider.refreshActiveEditor();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('svnLens')) {
          void this.refreshAll();
        }
      }),
    );
  }

  private registerCommands(): void {
    const command = (name: string, handler: (...args: any[]) => unknown) => {
      this.subscriptions.push(vscode.commands.registerCommand(name, handler));
    };

    command('svnLens.checkout', () => this.checkout());
    command('svnLens.import', () => this.importRepository());
    command('svnLens.refresh', (rootUri?: vscode.Uri) => this.refresh(rootUri));
    command('svnLens.update', (rootUri?: vscode.Uri) => this.update(rootUri));
    command('svnLens.commit', (rootUri?: vscode.Uri) => this.commit(rootUri));
    command('svnLens.switch', (rootUri?: vscode.Uri) => this.switch(rootUri));
    command('svnLens.showInfo', (rootUri?: vscode.Uri) => this.showInfo(rootUri));
    command('svnLens.showLog', (rootUri?: vscode.Uri) => this.showLog(rootUri));
    command('svnLens.showGraph', (rootUri?: vscode.Uri) => this.showGraph(rootUri));
    command('svnLens.showFileHistory', (uri?: vscode.Uri) => this.showFileHistory(uri));
    command('svnLens.compareRevisions', (uri?: vscode.Uri) => this.compareRevisions(uri));
    command('svnLens.openDiff', (uri?: vscode.Uri) => this.openDiff(uri));
    command('svnLens.exportPatch', (rootUri?: vscode.Uri) => this.exportPatch(rootUri));
    command('svnLens.applyPatch', (rootUri?: vscode.Uri) => this.applyPatch(rootUri));
    command('svnLens.manageIgnore', (uri?: vscode.Uri) => this.manageIgnore(uri));
    command('svnLens.openRepoBrowser', () => this.openRepoBrowser());
    command('svnLens.resetRepoBrowserRoot', () => this.resetRepoBrowserRoot());
    command('svnLens.openRemoteItem', (item: RepoBrowserItem) => item?.repository.openRemote(item.url));
    command('svnLens.createBranch', (item?: BranchTreeItem) => this.createBranch(item));
    command('svnLens.createTag', (item?: BranchTreeItem) => this.createTag(item));
    command('svnLens.mergeBranch', (item?: BranchTreeItem) => this.mergeBranch(item));
    command('svnLens.toggleBlame', () => this.toggleBlame());
    command('svnLens.acceptMine', (uri?: vscode.Uri) => this.resolveConflict(uri, 'mine-full'));
    command('svnLens.acceptTheirs', (uri?: vscode.Uri) => this.resolveConflict(uri, 'theirs-full'));
    command('svnLens.markResolved', (uri?: vscode.Uri) => this.markResolved(uri));
    command('svnLens.openConflictDiff', (uri?: vscode.Uri) => this.openConflictDiff(uri));
    command('svnLens.openSelectedRevisionPath', (item?: RevisionDetailsItem) => this.openSelectedRevisionPath(item));
    command('svnLens.filterSelectedRevisionFiles', () => this.filterSelectedRevisionFiles());
    command('svnLens.clearSelectedRevisionFilesFilter', () => this.clearSelectedRevisionFilesFilter());
  }

  private async scanWorkspace(): Promise<void> {
    const currentRoots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const isWorkingCopy = await this.cli.isWorkingCopy(folder.uri.fsPath);
      if (!isWorkingCopy) {
        continue;
      }

      currentRoots.add(folder.uri.fsPath);
      if (!this.repositories.has(folder.uri.fsPath)) {
        const repository = new SvnRepository(folder.uri, this.cli, this.logCache, this.jenkins, () => {
          this.repoBrowserProvider.refresh();
          this.branchTreeProvider.refresh();
          this.updateStatusBar();
        });
        this.repositories.set(folder.uri.fsPath, repository);
      }

      await this.repositories.get(folder.uri.fsPath)?.refresh();
    }

    for (const [rootPath, repository] of [...this.repositories.entries()]) {
      if (!currentRoots.has(rootPath)) {
        repository.dispose();
        this.repositories.delete(rootPath);
      }
    }

    this.repoBrowserProvider.refresh();
    this.branchTreeProvider.refresh();
    this.actionTreeProvider.refresh();
    if (this.selectedRevision && !this.repositories.has(this.selectedRevision.repository.rootUri.fsPath)) {
      this.setSelectedRevision(undefined);
    }
    this.updateStatusBar();
  }

  private async refresh(rootUri?: vscode.Uri): Promise<void> {
    if (rootUri) {
      const repository = this.repositories.get(rootUri.fsPath);
      if (repository) {
        await repository.refresh();
      }
      return;
    }
    await this.refreshAll();
  }

  private async refreshAll(): Promise<void> {
    for (const repository of this.repositories.values()) {
      await repository.refresh();
    }
    this.repoBrowserProvider.refresh();
    this.branchTreeProvider.refresh();
    this.actionTreeProvider.refresh();
    this.updateStatusBar();
  }

  private async checkout(): Promise<void> {
    const url = await vscode.window.showInputBox({ title: 'SVN Checkout', prompt: 'Repository URL' });
    if (!url) {
      return;
    }

    const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select checkout folder' });
    if (!folder?.[0]) {
      return;
    }

    await this.cli.checkout(url, folder[0].fsPath);
    if (!(vscode.workspace.workspaceFolders ?? []).some((workspaceFolder) => workspaceFolder.uri.fsPath === folder[0].fsPath)) {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
        uri: folder[0],
        name: path.basename(folder[0].fsPath),
      });
    }
    await this.scanWorkspace();
    void vscode.window.showInformationMessage(`SVN checkout completed: ${url}`);
  }

  private async importRepository(): Promise<void> {
    const source = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select folder to import' });
    if (!source?.[0]) {
      return;
    }

    const url = await vscode.window.showInputBox({ title: 'SVN Import', prompt: 'Target repository URL' });
    if (!url) {
      return;
    }
    const message = await vscode.window.showInputBox({ title: 'SVN Import', prompt: 'Import message', value: 'Initial import' });
    if (!message) {
      return;
    }

    await this.cli.import(source[0].fsPath, url, message);
    void vscode.window.showInformationMessage(`SVN import completed: ${url}`);
  }

  private async update(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (!repository) {
      return;
    }
    const output = await repository.update();
    void vscode.window.showInformationMessage(output.trim() || 'SVN update completed.');
  }

  private async commit(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (!repository) {
      return;
    }
    const output = await repository.commit();
    void vscode.window.showInformationMessage(output.trim() || 'SVN commit completed.');
  }

  private async switch(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (!repository) {
      return;
    }
    const info = await repository.getInfo();
    const targetUrl = await vscode.window.showInputBox({ title: 'SVN Switch', prompt: 'Target branch/tag URL', value: info.url });
    if (!targetUrl) {
      return;
    }
    await repository.switch(targetUrl);
  }

  private async showInfo(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (!repository) {
      return;
    }
    const info = await repository.getInfo();
    void vscode.window.showInformationMessage(`${info.relativeUrl} • r${info.revision} • ${info.url}`);
  }

  private async showLog(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (repository) {
      await this.historyPanel.showRepositoryLog(repository, 'log');
    }
  }

  private async showGraph(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (repository) {
      await this.historyPanel.showRepositoryLog(repository, 'graph');
    }
  }

  private async showFileHistory(uri?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveUri(uri);
    if (!targetUri) {
      return;
    }
    let repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      await this.scanWorkspace();
      repository = this.getRepositoryForUri(targetUri);
    }
    if (!repository) {
      return;
    }
    await this.historyPanel.showFileHistory(repository, targetUri);
  }

  private async compareRevisions(uri?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveUri(uri);
    if (!targetUri) {
      return;
    }
    const repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      return;
    }
    const leftRevision = await vscode.window.showInputBox({ title: 'SVN Compare', prompt: 'Left revision' });
    const rightRevision = await vscode.window.showInputBox({ title: 'SVN Compare', prompt: 'Right revision' });
    if (!leftRevision || !rightRevision) {
      return;
    }
    await repository.compareRevisions(targetUri, leftRevision, rightRevision);
  }

  private async openDiff(uri?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveUri(uri);
    if (!targetUri) {
      return;
    }
    const repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      return;
    }
    await repository.openWorkingDiff(targetUri);
  }

  private async exportPatch(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (!repository) {
      return;
    }
    const target = await vscode.window.showSaveDialog({ title: 'Export SVN Patch', defaultUri: vscode.Uri.file(path.join(repository.rootUri.fsPath, 'changes.patch')) });
    if (!target) {
      return;
    }
    await repository.exportPatch(target.fsPath);
    void vscode.window.showInformationMessage(`Patch exported to ${target.fsPath}`);
  }

  private async applyPatch(rootUri?: vscode.Uri): Promise<void> {
    const repository = await this.pickRepository(rootUri);
    if (!repository) {
      return;
    }
    const patchFile = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { Patch: ['patch', 'diff'] } });
    if (!patchFile?.[0]) {
      return;
    }
    await repository.applyPatch(patchFile[0].fsPath);
  }

  private async manageIgnore(uri?: vscode.Uri): Promise<void> {
    const targetUri = this.resolveUri(uri) ?? (await this.pickRepository())?.rootUri;
    if (!targetUri) {
      return;
    }
    const repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      return;
    }
    let fileType: vscode.FileType;
    try {
      fileType = (await vscode.workspace.fs.stat(targetUri)).type;
    } catch {
      fileType = vscode.FileType.File;
    }
    const directory = fileType === vscode.FileType.Directory ? targetUri : vscode.Uri.file(path.dirname(targetUri.fsPath));
    await repository.manageIgnore(directory);
  }

  private async openRepoBrowser(): Promise<void> {
    const repository = await this.pickRepository();
    if (!repository) {
      return;
    }
    await this.dashboardPanel.show(repository);
    try {
      await vscode.commands.executeCommand('workbench.view.extension.svnLens');
    } catch {
      // Ignore if the container command is unavailable on the current VS Code build.
    }
  }

  private async resetRepoBrowserRoot(): Promise<void> {
    const repository = await this.pickRepository();
    if (!repository) {
      return;
    }
    repository.setRepoBrowserRoot(undefined);
    this.repoBrowserProvider.refresh();
    void vscode.window.showInformationMessage('Repository browser root reset to default SVN layout.');
  }

  private async createBranch(item?: BranchTreeItem): Promise<void> {
    const repository = item?.repository ?? (await this.pickRepository());
    if (!repository) {
      return;
    }
    const name = await vscode.window.showInputBox({ title: 'Create SVN Branch', prompt: 'Branch name' });
    if (!name) {
      return;
    }
    const message = await vscode.window.showInputBox({ title: 'Create SVN Branch', prompt: 'Commit message', value: `Create branch ${name}` });
    await repository.createBranch(name, item?.url, message ?? undefined);
    this.branchTreeProvider.refresh();
    this.repoBrowserProvider.refresh();
  }

  private async createTag(item?: BranchTreeItem): Promise<void> {
    const repository = item?.repository ?? (await this.pickRepository());
    if (!repository) {
      return;
    }
    const name = await vscode.window.showInputBox({ title: 'Create SVN Tag', prompt: 'Tag name' });
    if (!name) {
      return;
    }
    const message = await vscode.window.showInputBox({ title: 'Create SVN Tag', prompt: 'Commit message', value: `Create tag ${name}` });
    await repository.createTag(name, item?.url, message ?? undefined);
    this.branchTreeProvider.refresh();
    this.repoBrowserProvider.refresh();
  }

  private async mergeBranch(item?: BranchTreeItem): Promise<void> {
    const repository = item?.repository ?? (await this.pickRepository());
    if (!repository) {
      return;
    }
    const sourceUrl = item?.url ?? (await vscode.window.showInputBox({ title: 'SVN Merge', prompt: 'Source branch URL' }));
    if (!sourceUrl) {
      return;
    }
    const revisionRange = await vscode.window.showInputBox({ title: 'SVN Merge', prompt: 'Optional revision range, for example 120:150' });
    await repository.merge(sourceUrl, revisionRange || undefined);
  }

  private async toggleBlame(): Promise<void> {
    const enabled = this.blameProvider.toggle();
    this.updateStatusBar();
    void vscode.window.showInformationMessage(`SVN blame ${enabled ? 'enabled' : 'disabled'}.`);
  }

  private async resolveConflict(uri: vscode.Uri | undefined, accept: 'mine-full' | 'theirs-full'): Promise<void> {
    const targetUri = this.resolveUri(uri);
    if (!targetUri) {
      return;
    }
    const repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      return;
    }
    await repository.resolve(targetUri, accept);
  }

  private async markResolved(uri: vscode.Uri | undefined): Promise<void> {
    const targetUri = this.resolveUri(uri);
    if (!targetUri) {
      return;
    }
    const repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      return;
    }
    await repository.markResolved(targetUri);
  }

  private async openConflictDiff(uri: vscode.Uri | undefined): Promise<void> {
    const targetUri = this.resolveUri(uri);
    if (!targetUri) {
      return;
    }
    const repository = this.getRepositoryForUri(targetUri);
    if (!repository) {
      return;
    }
    await this.conflictDecorator.openConflictDiff(repository, targetUri);
  }

  private async openSelectedRevisionPath(item?: RevisionDetailsItem): Promise<void> {
    if (!item?.selection || !item.changedPath) {
      return;
    }

    await item.selection.repository.openChangedPathRevision(
      item.changedPath.path,
      item.changedPath.action,
      item.selection.entry.revision,
      item.selection.previousRevision,
    );
  }

  private updateStatusBar(): void {
    const repository = this.getPreferredRepository();
    if (!repository) {
      this.statusBarItem.hide();
      this.actionTreeProvider.refresh();
      return;
    }

    const ciText = repository.buildStatus ? ` • ${repository.buildStatus.label}` : '';
    this.statusBarItem.text = `$(source-control) ${repository.displayBranch} • r${repository.revision}${ciText}`;
    this.statusBarItem.tooltip = repository.rootUri.fsPath;
    this.statusBarItem.command = 'svnLens.showLog';
    this.statusBarItem.show();
    this.actionTreeProvider.refresh();
  }

  private getPreferredRepository(): SvnRepository | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      return this.getRepositoryForUri(activeUri) ?? this.getRepositories()[0];
    }
    return this.getRepositories()[0];
  }

  private async pickRepository(rootUri?: vscode.Uri): Promise<SvnRepository | undefined> {
    if (this.repositories.size === 0 || (rootUri && !this.repositories.has(rootUri.fsPath))) {
      await this.scanWorkspace();
    }

    if (rootUri) {
      return this.repositories.get(rootUri.fsPath);
    }
    const preferred = this.getPreferredRepository();
    if (this.repositories.size <= 1) {
      return preferred;
    }

    const picked = await vscode.window.showQuickPick(
      this.getRepositories().map((repository) => ({
        label: repository.displayBranch,
        description: repository.rootUri.fsPath,
        repository,
      })),
      { title: 'Choose SVN repository' },
    );
    return picked?.repository ?? preferred;
  }

  private resolveUri(uri?: vscode.Uri): vscode.Uri | undefined {
    return uri ?? vscode.window.activeTextEditor?.document.uri;
  }

  private scheduleRefresh(uri: vscode.Uri): void {
    const repository = this.getRepositoryForUri(uri);
    if (!repository) {
      return;
    }
    if (!getAutoRefresh(repository.rootUri)) {
      return;
    }

    const key = repository.rootUri.fsPath;
    const existing = this.autoRefreshTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      void repository.refresh();
    }, getRefreshDebounceMs(repository.rootUri));
    this.autoRefreshTimers.set(key, timer);
  }

  private setSelectedRevision(selection: RevisionSelection | undefined): void {
    this.selectedRevision = selection;
    this.revisionDetailsProvider.setSelection(selection);
  }

  private async filterSelectedRevisionFiles(): Promise<void> {
    if (!this.selectedRevision) {
      void vscode.window.showInformationMessage('Select a revision first.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      [
        { label: 'All actions', value: 'all' as RevisionFileActionFilter },
        { label: 'Added only', value: 'A' as RevisionFileActionFilter },
        { label: 'Modified only', value: 'M' as RevisionFileActionFilter },
        { label: 'Deleted only', value: 'D' as RevisionFileActionFilter },
        { label: 'Replaced only', value: 'R' as RevisionFileActionFilter },
        { label: 'Other actions', value: 'other' as RevisionFileActionFilter },
      ],
      {
        title: 'Filter changed files',
        placeHolder: `Current filter: ${this.revisionDetailsProvider.getActionFilter()}`,
      },
    );
    if (!picked) {
      return;
    }

    this.revisionDetailsProvider.setActionFilter(picked.value);
  }

  private async clearSelectedRevisionFilesFilter(): Promise<void> {
    this.revisionDetailsProvider.setActionFilter('all');
    void vscode.window.showInformationMessage('Revision file filter cleared.');
  }
}
