import * as vscode from 'vscode';
import { SvnRepository } from '../services/svnRepository';

export class RepoBrowserItem extends vscode.TreeItem {
  public constructor(
    public readonly repository: SvnRepository,
    public readonly url: string,
    public readonly nodeKind: 'repo' | 'bookmark' | 'dir' | 'file',
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    description?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue =
      nodeKind === 'file'
        ? 'remoteFile'
        : nodeKind === 'repo'
          ? 'repositoryRoot'
          : nodeKind === 'bookmark'
            ? 'remoteBookmark'
            : 'remoteDirectory';
    this.iconPath =
      nodeKind === 'repo'
        ? new vscode.ThemeIcon('repo')
        : nodeKind === 'bookmark'
          ? new vscode.ThemeIcon('bookmark')
        : nodeKind === 'dir'
          ? new vscode.ThemeIcon('folder')
          : new vscode.ThemeIcon('file');
    if (nodeKind === 'file') {
      this.command = {
        command: 'svnLens.openRemoteItem',
        title: 'Open Remote File',
        arguments: [this],
      };
    }
    this.description = description ?? url;
    this.tooltip = `${label}\n${url}`;
  }
}

export class RepoBrowserProvider implements vscode.TreeDataProvider<RepoBrowserItem> {
  private readonly emitter = new vscode.EventEmitter<RepoBrowserItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getRepositories: () => readonly SvnRepository[]) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: RepoBrowserItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: RepoBrowserItem): Promise<RepoBrowserItem[]> {
    if (!element) {
      return this.getRepositories().map(
        (repository) =>
          new RepoBrowserItem(
            repository,
            repository.rootUri.toString(),
            'repo',
            repository.rootUri.path.split('/').at(-1) ?? repository.rootUri.fsPath,
            vscode.TreeItemCollapsibleState.Collapsed,
            repository.displayBranch,
          ),
      );
    }

    if (element.nodeKind === 'repo') {
      const roots = await element.repository.getRepoBrowserRoots();
      return roots.map(
        (root) =>
          new RepoBrowserItem(
            element.repository,
            root.url,
            'bookmark',
            root.label,
            vscode.TreeItemCollapsibleState.Collapsed,
            root.description,
          ),
      );
    }

    if (element.nodeKind === 'bookmark' || element.nodeKind === 'dir') {
      try {
        const children = await element.repository.listRemote(element.url);
        return children.map(
          (entry) =>
            new RepoBrowserItem(
              element.repository,
              entry.url,
              entry.kind === 'dir' ? 'dir' : 'file',
              entry.name,
              entry.kind === 'dir' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
              entry.kind === 'dir' ? 'directory' : `r${entry.revision ?? '?'}`,
            ),
        );
      } catch {
        return [];
      }
    }

    return [];
  }
}
