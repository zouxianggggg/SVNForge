import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCommitMessagePattern, getDefaultBranchRoots, getPreCommitCommand } from '../config';
import { SvnCli } from '../adapter/svnCli';
import {
  CachedBlameDocument,
  JenkinsBuildStatus,
  LogPage,
  LogQuery,
  SvnBlameLine,
  SvnInfo,
  SvnListEntry,
  SvnLogEntry,
  SvnStatusEntry,
} from '../types';
import { execShellText } from '../utils/process';
import { buildBaseUri, buildRemoteUri, buildRevisionUri } from '../providers/uri';
import { JenkinsService } from './jenkinsService';
import { LogCache } from './logCache';

function sanitizeSourceControlId(input: string): string {
  return `svnLens.${Buffer.from(input).toString('hex').slice(0, 24)}`;
}

function branchLabelFromInfo(info: SvnInfo): string {
  const relative = info.relativeUrl.replace(/^\^\//, '').replace(/^\//, '');
  return relative || 'working-copy';
}

function scopeIdForFile(uri: vscode.Uri): string {
  return `file:${uri.fsPath}`;
}

export class SvnRepository implements vscode.Disposable {
  public readonly sourceControl: vscode.SourceControl;
  public readonly modifiedGroup: vscode.SourceControlResourceGroup;
  public readonly addedGroup: vscode.SourceControlResourceGroup;
  public readonly deletedGroup: vscode.SourceControlResourceGroup;
  public readonly conflictedGroup: vscode.SourceControlResourceGroup;
  public readonly unversionedGroup: vscode.SourceControlResourceGroup;

  private infoCache: SvnInfo | undefined;
  private lastStatuses: SvnStatusEntry[] = [];
  private lastBlameDocuments = new Map<string, CachedBlameDocument>();
  private ciStatus: JenkinsBuildStatus | undefined;
  private refreshTask: Promise<void> | undefined;
  private preferredRepoBrowserUrl: string | undefined;

  public constructor(
    public readonly rootUri: vscode.Uri,
    private readonly cli: SvnCli,
    private readonly logCache: LogCache,
    private readonly jenkins: JenkinsService,
    private readonly onDidChange: () => void,
  ) {
    this.sourceControl = vscode.scm.createSourceControl(sanitizeSourceControlId(rootUri.fsPath), 'SVN', rootUri);
    this.sourceControl.acceptInputCommand = {
      command: 'svnLens.commit',
      title: 'Commit',
      arguments: [rootUri],
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri) => buildBaseUri(uri, this.rootUri),
    };
    this.sourceControl.statusBarCommands = [
      { command: 'svnLens.update', title: 'Update', arguments: [rootUri] },
      { command: 'svnLens.showLog', title: 'Log', arguments: [rootUri] },
      { command: 'svnLens.refresh', title: 'Refresh', arguments: [rootUri] },
    ];

    this.modifiedGroup = this.sourceControl.createResourceGroup('modified', 'Modified');
    this.addedGroup = this.sourceControl.createResourceGroup('added', 'Added');
    this.deletedGroup = this.sourceControl.createResourceGroup('deleted', 'Deleted');
    this.conflictedGroup = this.sourceControl.createResourceGroup('conflicted', 'Conflicted');
    this.unversionedGroup = this.sourceControl.createResourceGroup('unversioned', 'Unversioned');
  }

  public get scopeId(): string {
    return `repo:${this.rootUri.fsPath}`;
  }

  public get displayBranch(): string {
    return this.infoCache ? branchLabelFromInfo(this.infoCache) : 'loading';
  }

  public get revision(): number {
    return this.infoCache?.revision ?? 0;
  }

  public get buildStatus(): JenkinsBuildStatus | undefined {
    return this.ciStatus;
  }

  public get statuses(): readonly SvnStatusEntry[] {
    return this.lastStatuses;
  }

  public async refresh(): Promise<void> {
    if (!this.refreshTask) {
      this.refreshTask = this.doRefresh().finally(() => {
        this.refreshTask = undefined;
      });
    }
    await this.refreshTask;
  }

  public async getInfo(): Promise<SvnInfo> {
    if (!this.infoCache) {
      this.infoCache = await this.cli.info(this.rootUri.fsPath);
    }
    return this.infoCache;
  }

  public async update(): Promise<string> {
    const result = await this.cli.update(this.rootUri.fsPath);
    await this.refresh();
    return result;
  }

  public async commit(message?: string): Promise<string> {
    const finalMessage = message ?? this.sourceControl.inputBox.value.trim();
    if (!finalMessage) {
      throw new Error('Commit message cannot be empty.');
    }

    await this.runPreCommitChecks(finalMessage);
    const result = await this.cli.commit(this.rootUri.fsPath, finalMessage);
    this.sourceControl.inputBox.value = '';
    await this.refresh();
    return result;
  }

  public async switch(url: string): Promise<string> {
    const result = await this.cli.switch(this.rootUri.fsPath, url);
    await this.refresh();
    return result;
  }

  public async merge(sourceUrl: string, revisionRange?: string): Promise<string> {
    const result = await this.cli.merge(this.rootUri.fsPath, sourceUrl, revisionRange);
    await this.refresh();
    return result;
  }

  public async resolve(target: vscode.Uri, accept: 'mine-full' | 'theirs-full' | 'working'): Promise<void> {
    await this.cli.resolve(this.rootUri.fsPath, target.fsPath, accept);
    await this.refresh();
  }

  public async markResolved(target: vscode.Uri): Promise<void> {
    await this.cli.markResolved(this.rootUri.fsPath, target.fsPath);
    await this.refresh();
  }

  public async openWorkingDiff(target: vscode.Uri): Promise<void> {
    const left = buildBaseUri(target, this.rootUri);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      target,
      `${path.basename(target.fsPath)}: BASE ↔ Working Copy`,
      { preview: true },
    );
  }

  public async compareRevisions(target: vscode.Uri, leftRevision: string, rightRevision: string): Promise<void> {
    const left = buildRevisionUri(target, this.rootUri, leftRevision);
    const right = buildRevisionUri(target, this.rootUri, rightRevision);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${path.basename(target.fsPath)}: r${leftRevision} ↔ r${rightRevision}`,
      { preview: true },
    );
  }

  public async readBaseContent(target: string): Promise<string> {
    return this.cli.cat(target, 'BASE');
  }

  public async readRevisionContent(target: string, revision: string): Promise<string> {
    return this.cli.cat(target, revision);
  }

  public async readRemoteContent(url: string, revision?: string): Promise<string> {
    return this.cli.catRemote(url, revision);
  }

  public async getLogPage(query: LogQuery): Promise<LogPage> {
    return this.loadLogPage(this.scopeId, this.rootUri.fsPath, query);
  }

  public async getFileHistory(target: vscode.Uri, query: LogQuery): Promise<LogPage> {
    const scopeId = scopeIdForFile(target);
    return this.loadLogPage(scopeId, target.fsPath, query);
  }

  public async getRevisionLog(revision: number, target?: vscode.Uri): Promise<SvnLogEntry | undefined> {
    const scopeId = target ? scopeIdForFile(target) : this.scopeId;
    const cached = await this.logCache.get(scopeId, revision);
    if (cached?.detailsLoaded) {
      return cached;
    }

    const searchTarget = target?.fsPath ?? this.rootUri.fsPath;
    const entries = await this.cli.log(searchTarget, {
      revisionRange: `${revision}:${revision}`,
      limit: 1,
      verbose: true,
      searchTarget,
    });
    await this.logCache.store(scopeId, entries);
    return entries[0];
  }

  public async getBlame(target: vscode.Uri): Promise<SvnBlameLine[]> {
    const existing = this.lastBlameDocuments.get(target.toString());
    if (existing && Date.now() - existing.fetchedAt < 60_000) {
      return existing.lines;
    }

    const lines = await this.cli.blame(target.fsPath);
    this.lastBlameDocuments.set(target.toString(), {
      uri: target.toString(),
      lines,
      fetchedAt: Date.now(),
    });
    return lines;
  }

  public async listRemote(url: string): Promise<SvnListEntry[]> {
    return this.cli.list(url);
  }

  public setRepoBrowserRoot(url: string | undefined): void {
    this.preferredRepoBrowserUrl = url?.trim() || undefined;
  }

  public async getRepoBrowserRoots(): Promise<Array<{ label: string; url: string; description: string }>> {
    const info = await this.getInfo();
    const items: Array<{ label: string; url: string; description: string }> = [
      {
        label: 'repository',
        url: info.rootUrl,
        description: 'Repository root',
      },
      {
        label: `current • ${this.displayBranch}`,
        url: info.url,
        description: 'Working copy target',
      },
      ...getDefaultBranchRoots(this.rootUri).map((segment) => ({
        label: segment,
        url: `${info.rootUrl.replace(/\/+$/, '')}/${segment.replace(/^\/+/, '')}`,
        description: 'Default SVN layout',
      })),
    ];

    if (this.preferredRepoBrowserUrl) {
      items.unshift({
        label: 'custom',
        url: this.preferredRepoBrowserUrl,
        description: 'Pinned remote root',
      });
    }

    const deduplicated = new Map<string, { label: string; url: string; description: string }>();
    for (const item of items) {
      if (!deduplicated.has(item.url)) {
        deduplicated.set(item.url, item);
      }
    }
    return [...deduplicated.values()];
  }

  public async openRemote(url: string, revision?: string): Promise<void> {
    const title = revision ? `${url}@${revision}` : url;
    const uri = buildRemoteUri(url, revision, title, this.rootUri.fsPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public async openChangedPathRevision(changePath: string, action: string, revision: number, previousRevision?: number): Promise<void> {
    const url = await this.toRepositoryUrl(changePath);
    const safePreviousRevision = String(Math.max(1, previousRevision ?? revision - 1));
    const currentRevision = String(revision);
    const name = path.posix.basename(changePath) || changePath;

    if (action === 'A') {
      await this.openRemote(url, currentRevision);
      return;
    }

    if (action === 'D') {
      await this.openRemote(url, safePreviousRevision);
      return;
    }

    const left = buildRemoteUri(url, safePreviousRevision, `${name}@r${safePreviousRevision}`, this.rootUri.fsPath);
    const right = buildRemoteUri(url, currentRevision, `${name}@r${currentRevision}`, this.rootUri.fsPath);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${name}: r${safePreviousRevision} ↔ r${currentRevision}`,
      { preview: true },
    );
  }

  public async createBranch(name: string, fromUrl?: string, message?: string): Promise<void> {
    const info = await this.getInfo();
    const sourceUrl = fromUrl ?? info.url;
    const targetUrl = `${info.rootUrl.replace(/\/+$/, '')}/branches/${name.replace(/^\/+/, '')}`;
    await this.cli.copy(sourceUrl, targetUrl, message ?? `Create branch ${name}`);
  }

  public async createTag(name: string, fromUrl?: string, message?: string): Promise<void> {
    const info = await this.getInfo();
    const sourceUrl = fromUrl ?? info.url;
    const targetUrl = `${info.rootUrl.replace(/\/+$/, '')}/tags/${name.replace(/^\/+/, '')}`;
    await this.cli.copy(sourceUrl, targetUrl, message ?? `Create tag ${name}`);
  }

  public async exportPatch(targetFile: string): Promise<void> {
    await this.cli.exportPatch(this.rootUri.fsPath, targetFile);
  }

  public async applyPatch(patchFile: string): Promise<void> {
    await this.cli.applyPatch(this.rootUri.fsPath, patchFile);
    await this.refresh();
  }

  public async manageIgnore(targetDirectory: vscode.Uri): Promise<void> {
    const relativeTarget = path.relative(this.rootUri.fsPath, targetDirectory.fsPath) || '.';
    let currentValue = '';
    try {
      currentValue = await this.cli.propGet(this.rootUri.fsPath, 'svn:ignore', relativeTarget);
    } catch {
      currentValue = '';
    }

    const currentPatterns = currentValue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const suggestedPatterns = this.lastStatuses
      .filter((entry) => entry.status === 'unversioned')
      .map((entry) => path.relative(targetDirectory.fsPath, entry.path))
      .filter((relativePath) => relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))
      .sort((left, right) => left.localeCompare(right));

    const action = await vscode.window.showQuickPick(
      [
        'Add pattern',
        'Add suggested entries',
        'Remove patterns',
        'Replace patterns',
        'Clear patterns',
      ],
      {
      title: `Manage svn:ignore for ${relativeTarget}`,
      placeHolder: currentPatterns.length > 0 ? currentPatterns.join(', ') : 'No ignore patterns set',
      },
    );
    if (!action) {
      return;
    }

    if (action === 'Clear patterns') {
      await this.cli.propSet(this.rootUri.fsPath, 'svn:ignore', '', relativeTarget);
      await this.refresh();
      return;
    }

    if (action === 'Remove patterns') {
      if (currentPatterns.length === 0) {
        void vscode.window.showInformationMessage('No svn:ignore patterns to remove.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        currentPatterns.map((pattern) => ({ label: pattern })),
        {
          title: `Remove svn:ignore patterns from ${relativeTarget}`,
          canPickMany: true,
        },
      );
      if (!picked) {
        return;
      }

      const nextPatterns = currentPatterns.filter((pattern) => !picked.some((item) => item.label === pattern));
      await this.cli.propSet(this.rootUri.fsPath, 'svn:ignore', nextPatterns.join('\n'), relativeTarget);
      await this.refresh();
      return;
    }

    if (action === 'Add suggested entries') {
      if (suggestedPatterns.length === 0) {
        void vscode.window.showInformationMessage('No unversioned entries found under this directory.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        suggestedPatterns.map((pattern) => ({ label: pattern })),
        {
          title: `Add suggested svn:ignore entries for ${relativeTarget}`,
          canPickMany: true,
        },
      );
      if (!picked || picked.length === 0) {
        return;
      }

      const nextPatterns = [...currentPatterns, ...picked.map((item) => item.label)]
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index)
        .sort((left, right) => left.localeCompare(right));
      await this.cli.propSet(this.rootUri.fsPath, 'svn:ignore', nextPatterns.join('\n'), relativeTarget);
      await this.refresh();
      return;
    }

    const prompt = action === 'Add pattern' ? 'Enter patterns separated by comma or newline' : 'Enter comma separated patterns';
    const value = await vscode.window.showInputBox({ title: 'svn:ignore', prompt });
    if (value === undefined) {
      return;
    }

    const parsedInputPatterns = value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

    const nextPatterns =
      action === 'Add pattern'
        ? [...currentPatterns, ...parsedInputPatterns]
        : parsedInputPatterns;
    const uniquePatterns = nextPatterns
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index)
      .sort((left, right) => left.localeCompare(right));
    await this.cli.propSet(this.rootUri.fsPath, 'svn:ignore', uniquePatterns.join('\n'), relativeTarget);
    await this.refresh();
  }

  public async findConflictArtifacts(target: vscode.Uri): Promise<{ mine?: vscode.Uri; theirs?: vscode.Uri }> {
    const parent = path.dirname(target.fsPath);
    const baseName = path.basename(target.fsPath);
    const entries = await fs.readdir(parent);
    const mine = entries.find((entry) => entry === `${baseName}.mine`);
    const theirs = entries
      .filter((entry) => entry.startsWith(`${baseName}.r`))
      .sort((left, right) => left.localeCompare(right))
      .at(-1);
    return {
      mine: mine ? vscode.Uri.file(path.join(parent, mine)) : undefined,
      theirs: theirs ? vscode.Uri.file(path.join(parent, theirs)) : undefined,
    };
  }

  public async getBranchRootItems(): Promise<Array<{ label: string; url: string }>> {
    const info = await this.getInfo();
    return getDefaultBranchRoots(this.rootUri).map((segment) => ({
      label: segment,
      url: `${info.rootUrl.replace(/\/+$/, '')}/${segment.replace(/^\/+/, '')}`,
    }));
  }

  public dispose(): void {
    this.sourceControl.dispose();
  }

  private async doRefresh(): Promise<void> {
    this.infoCache = await this.cli.info(this.rootUri.fsPath);
    this.lastStatuses = await this.cli.status(this.rootUri.fsPath);
    this.updateSourceControlGroups();
    this.ciStatus = await this.jenkins.getBranchStatus(this.displayBranch, this.rootUri);
    this.onDidChange();
  }

  private async runPreCommitChecks(message: string): Promise<void> {
    const messagePattern = getCommitMessagePattern(this.rootUri).trim();
    if (messagePattern) {
      const expression = new RegExp(messagePattern);
      if (!expression.test(message)) {
        throw new Error(`Commit message does not match configured pattern: ${messagePattern}`);
      }
    }

    const hookCommand = getPreCommitCommand(this.rootUri).trim();
    if (!hookCommand) {
      return;
    }

    await execShellText(hookCommand, {
      cwd: this.rootUri.fsPath,
      env: {
        ...process.env,
        SVN_REPO_ROOT: this.rootUri.fsPath,
        SVN_COMMIT_MESSAGE: message,
      },
    });
  }

  private updateSourceControlGroups(): void {
    const modified: vscode.SourceControlResourceState[] = [];
    const added: vscode.SourceControlResourceState[] = [];
    const deleted: vscode.SourceControlResourceState[] = [];
    const conflicted: vscode.SourceControlResourceState[] = [];
    const unversioned: vscode.SourceControlResourceState[] = [];

    for (const entry of this.lastStatuses) {
      const resource = this.toResourceState(entry);
      switch (entry.status) {
        case 'modified':
        case 'replaced':
          modified.push(resource);
          break;
        case 'added':
          added.push(resource);
          break;
        case 'deleted':
        case 'missing':
          deleted.push(resource);
          break;
        case 'conflicted':
          conflicted.push(resource);
          break;
        case 'unversioned':
          unversioned.push(resource);
          break;
        default:
          break;
      }
    }

    this.modifiedGroup.resourceStates = modified;
    this.addedGroup.resourceStates = added;
    this.deletedGroup.resourceStates = deleted;
    this.conflictedGroup.resourceStates = conflicted;
    this.unversionedGroup.resourceStates = unversioned;
    this.sourceControl.count = modified.length + added.length + deleted.length + conflicted.length + unversioned.length;
    this.sourceControl.inputBox.placeholder = `Commit to ${this.displayBranch}`;
  }

  private toResourceState(entry: SvnStatusEntry): vscode.SourceControlResourceState {
    const tooltip = `${entry.status}${entry.treeConflicted ? ' • tree conflict' : ''}`;
    return {
      resourceUri: entry.uri,
      command: {
        command: entry.status === 'conflicted' ? 'svnLens.openConflictDiff' : 'svnLens.openDiff',
        title: 'Open Diff',
        arguments: [entry.uri],
      },
      decorations: {
        tooltip,
        strikeThrough: entry.status === 'deleted' || entry.status === 'missing',
        iconPath:
          entry.status === 'added'
            ? new vscode.ThemeIcon('diff-added')
            : entry.status === 'deleted' || entry.status === 'missing'
              ? new vscode.ThemeIcon('diff-removed')
              : entry.status === 'conflicted'
                ? new vscode.ThemeIcon('warning')
                : new vscode.ThemeIcon('diff-modified'),
      },
      contextValue: entry.status,
    };
  }

  private async ensureLogCoverage(scopeId: string, targetPath: string, query: LogQuery): Promise<void> {
    const desiredEntries = (query.page + 1) * query.pageSize;
    let currentPage = await this.logCache.query(scopeId, {
      ...query,
      page: 0,
      pageSize: desiredEntries,
    });
    let fetchWindow = 0;
    let nextRevision = await this.getHeadRevision(targetPath);

    while (currentPage.entries.length < desiredEntries && fetchWindow < 20 && nextRevision >= 1) {
      const entries = await this.cli.log(targetPath, {
        revisionRange: `${nextRevision}:1`,
        limit: query.pageSize,
        verbose: false,
        searchTarget: targetPath,
      });
      if (entries.length === 0) {
        break;
      }

      await this.logCache.store(scopeId, entries);
      currentPage = await this.logCache.query(scopeId, {
        ...query,
        page: 0,
        pageSize: desiredEntries,
      });
      fetchWindow += 1;

      const lastRevision = entries.at(-1)?.revision ?? 0;
      if (lastRevision <= 1 || entries.length < query.pageSize) {
        break;
      }
      nextRevision = lastRevision - 1;
    }
  }

  private async loadLogPage(scopeId: string, targetPath: string, query: LogQuery): Promise<LogPage> {
    await this.ensureLogCoverage(scopeId, targetPath, query);
    const cachedPage = await this.logCache.query(scopeId, query);
    if (cachedPage.entries.length > 0) {
      return cachedPage;
    }

    return this.fetchLiveLogPage(scopeId, targetPath, query);
  }

  private async fetchLiveLogPage(scopeId: string, targetPath: string, query: LogQuery): Promise<LogPage> {
    const desiredEntries = (query.page + 1) * query.pageSize;
    const collected = new Map<number, SvnLogEntry>();
    let nextRevision = await this.getHeadRevision(targetPath);
    let fetchWindow = 0;

    while (this.filterLogEntries([...collected.values()], query).length < desiredEntries && fetchWindow < 20 && nextRevision >= 1) {
      const entries = await this.cli.log(targetPath, {
        revisionRange: `${nextRevision}:1`,
        limit: query.pageSize,
        verbose: false,
        searchTarget: targetPath,
      });
      if (entries.length === 0) {
        break;
      }

      await this.logCache.store(scopeId, entries);
      for (const entry of entries) {
        collected.set(entry.revision, entry);
      }

      fetchWindow += 1;
      const lastRevision = entries.at(-1)?.revision ?? 0;
      if (lastRevision <= 1 || entries.length < query.pageSize) {
        break;
      }
      nextRevision = lastRevision - 1;
    }

    const filtered = this.filterLogEntries([...collected.values()], query);
    const offset = query.page * query.pageSize;
    const pageEntries = filtered.slice(offset, offset + query.pageSize + 1);
    return {
      entries: pageEntries.slice(0, query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      hasMore: pageEntries.length > query.pageSize,
    };
  }

  private async getHeadRevision(targetPath: string): Promise<number> {
    const targetInfo = await this.cli.info(targetPath);
    return Math.max(
      targetInfo.lastChangedRevision ?? 0,
      targetInfo.revision,
      (await this.getInfo()).revision,
      1,
    );
  }

  private filterLogEntries(entries: readonly SvnLogEntry[], query: LogQuery): SvnLogEntry[] {
    return [...entries]
      .filter((entry) => this.matchesLogQuery(entry, query))
      .sort((left, right) => right.revision - left.revision);
  }

  private matchesLogQuery(entry: SvnLogEntry, query: LogQuery): boolean {
    if (query.author && !entry.author.toLowerCase().includes(query.author.toLowerCase())) {
      return false;
    }
    if (query.from && entry.date < query.from) {
      return false;
    }
    if (query.to && entry.date > query.to) {
      return false;
    }
    return true;
  }

  private async toRepositoryUrl(changePath: string): Promise<string> {
    const info = await this.getInfo();
    return `${info.rootUrl.replace(/\/+$/, '')}/${changePath.replace(/^\/+/, '')}`;
  }
}