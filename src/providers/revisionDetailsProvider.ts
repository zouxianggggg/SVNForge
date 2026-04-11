import * as path from 'path';
import * as vscode from 'vscode';
import { SvnRepository } from '../services/svnRepository';
import { SvnChangedPath, SvnLogEntry } from '../types';

export interface RevisionSelection {
  repository: SvnRepository;
  entry: SvnLogEntry;
  previousRevision?: number;
  targetUri?: vscode.Uri;
}

export type RevisionFileActionFilter = 'all' | 'A' | 'M' | 'D' | 'R' | 'other';

type NodeKind = 'placeholder' | 'meta' | 'messageGroup' | 'messageLine' | 'filesGroup' | 'folder' | 'file';

export class RevisionDetailsItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: NodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly selection?: RevisionSelection,
    public readonly changedPath?: SvnChangedPath,
    public readonly folderPath?: string,
    description?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(getIcon(kind, changedPath?.action));
  }
}

function getIcon(kind: NodeKind, action?: string): string {
  switch (kind) {
    case 'meta':
      return 'info';
    case 'messageGroup':
      return 'comment';
    case 'messageLine':
      return 'dash';
    case 'filesGroup':
      return 'files';
    case 'folder':
      return 'folder';
    case 'file':
      if (action === 'A') {
        return 'diff-added';
      }
      if (action === 'D') {
        return 'diff-removed';
      }
      return 'diff-modified';
    default:
      return 'history';
  }
}

export class RevisionDetailsProvider implements vscode.TreeDataProvider<RevisionDetailsItem> {
  private readonly emitter = new vscode.EventEmitter<RevisionDetailsItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private selection: RevisionSelection | undefined;
  private actionFilter: RevisionFileActionFilter = 'all';

  public setSelection(selection: RevisionSelection | undefined): void {
    this.selection = selection;
    this.refresh();
  }

  public setActionFilter(filter: RevisionFileActionFilter): void {
    this.actionFilter = filter;
    this.refresh();
  }

  public getActionFilter(): RevisionFileActionFilter {
    return this.actionFilter;
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: RevisionDetailsItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: RevisionDetailsItem): RevisionDetailsItem[] {
    if (!this.selection) {
      return element ? [] : [new RevisionDetailsItem('placeholder', 'Select a log entry to inspect it here', vscode.TreeItemCollapsibleState.None)];
    }

    if (!element) {
      const subject = this.selection.entry.message.split(/\r?\n/, 1)[0]?.trim() || 'No commit message';
      const messageLines = this.selection.entry.message.split(/\r?\n/).filter(Boolean);
      const filteredPaths = this.getFilteredChangedPaths();
      return [
        new RevisionDetailsItem('meta', `Revision r${this.selection.entry.revision}`, vscode.TreeItemCollapsibleState.None, this.selection, undefined, undefined, this.selection.repository.displayBranch),
        new RevisionDetailsItem('meta', `Author ${this.selection.entry.author}`, vscode.TreeItemCollapsibleState.None, this.selection),
        new RevisionDetailsItem('meta', `Date ${this.selection.entry.date || 'unknown'}`, vscode.TreeItemCollapsibleState.None, this.selection),
        new RevisionDetailsItem(
          'messageGroup',
          'Commit Message',
          messageLines.length > 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
          this.selection,
          undefined,
          undefined,
          subject,
        ),
        new RevisionDetailsItem(
          'filesGroup',
          `Changed Files (${filteredPaths.length}/${this.selection.entry.changedPaths.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          this.selection,
          undefined,
          undefined,
          this.getFilterDescription(),
        ),
      ];
    }

    if (element.kind === 'messageGroup') {
      const messageLines = this.selection.entry.message.split(/\r?\n/).filter(Boolean);
      return messageLines.length > 1
        ? messageLines.map((line, index) => new RevisionDetailsItem('messageLine', index === 0 ? line : `  ${line}`, vscode.TreeItemCollapsibleState.None, this.selection))
        : [];
    }

    if (element.kind === 'filesGroup') {
      return this.buildPathNodes(this.getFilteredChangedPaths(), '');
    }

    if (element.kind === 'folder') {
      return this.buildPathNodes(this.getFilteredChangedPaths(), element.folderPath ?? '');
    }

    return [];
  }

  private buildPathNodes(changedPaths: readonly SvnChangedPath[], parentPath: string): RevisionDetailsItem[] {
    const folders = new Map<string, number>();
    const files: RevisionDetailsItem[] = [];

    for (const changedPath of changedPaths) {
      const normalized = this.normalizeChangedPath(changedPath.path);
      const remainder = parentPath ? this.trimParent(normalized, parentPath) : normalized;
      if (!remainder) {
        continue;
      }

      const segments = remainder.split('/').filter(Boolean);
      if (segments.length === 0) {
        continue;
      }

      if (segments.length > 1) {
        const folderKey = parentPath ? `${parentPath}/${segments[0]}` : segments[0];
        folders.set(folderKey, (folders.get(folderKey) ?? 0) + 1);
        continue;
      }

      const item = new RevisionDetailsItem(
        'file',
        `${changedPath.action} ${segments[0]}`,
        vscode.TreeItemCollapsibleState.None,
        this.selection,
        changedPath,
        undefined,
        this.getFileDescription(changedPath, normalized),
      );
      item.tooltip = `${changedPath.action} ${changedPath.path}`;
      item.command = {
        command: 'svnLens.openSelectedRevisionPath',
        title: 'Open Changed File Revision',
        arguments: [item],
      };
      files.push(item);
    }

    const folderItems = [...folders.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([folderPath, count]) => {
        const label = folderPath.split('/').at(-1) ?? folderPath;
        const item = new RevisionDetailsItem(
          'folder',
          label,
          vscode.TreeItemCollapsibleState.Collapsed,
          this.selection,
          undefined,
          folderPath,
          `${count} item${count === 1 ? '' : 's'}`,
        );
        item.tooltip = folderPath;
        return item;
      });

    files.sort((left, right) => this.itemLabel(left).localeCompare(this.itemLabel(right)));
    return [...folderItems, ...files];
  }

  private getFilteredChangedPaths(): SvnChangedPath[] {
    if (!this.selection) {
      return [];
    }

    return this.selection.entry.changedPaths.filter((changedPath) => this.matchesActionFilter(changedPath.action));
  }

  private matchesActionFilter(action: string): boolean {
    if (this.actionFilter === 'all') {
      return true;
    }
    if (this.actionFilter === 'other') {
      return !['A', 'M', 'D', 'R'].includes(action);
    }
    return action === this.actionFilter;
  }

  private getFilterDescription(): string {
    switch (this.actionFilter) {
      case 'A':
        return 'Filter: Added';
      case 'M':
        return 'Filter: Modified';
      case 'D':
        return 'Filter: Deleted';
      case 'R':
        return 'Filter: Replaced';
      case 'other':
        return 'Filter: Other actions';
      default:
        return 'Filter: All actions';
    }
  }

  private getFileDescription(changedPath: SvnChangedPath, normalizedPath: string): string {
    const parentDirectory = normalizedPath.split('/').slice(0, -1).join('/');
    if (changedPath.copyFromPath) {
      return `${parentDirectory || '.'} ← ${changedPath.copyFromPath}`;
    }
    return parentDirectory || '.';
  }

  private normalizeChangedPath(value: string): string {
    return value.replace(/^\/+/, '');
  }

  private trimParent(normalizedPath: string, parentPath: string): string {
    if (normalizedPath === parentPath) {
      return '';
    }
    const prefix = `${parentPath}/`;
    return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : '';
  }

  private itemLabel(item: RevisionDetailsItem): string {
    return typeof item.label === 'string' ? item.label : item.label?.label ?? '';
  }
}