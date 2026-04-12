import * as path from 'path';
import * as vscode from 'vscode';
import { SvnExternalDefinition } from '../types';
import { SvnRepository } from '../services/svnRepository';

type RepositoryResolver = () => readonly SvnRepository[];

type ExternalNodeKind = 'repo' | 'owner' | 'external' | 'placeholder';

export class ExternalTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly nodeKind: ExternalNodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly repository?: SvnRepository,
    public readonly ownerRelativePath?: string,
    public readonly external?: SvnExternalDefinition,
    description?: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.contextValue = nodeKind;
    this.iconPath = new vscode.ThemeIcon(
      nodeKind === 'repo' ? 'repo' : nodeKind === 'owner' ? 'folder' : nodeKind === 'external' ? 'link-external' : 'info',
    );
    if (nodeKind === 'external' && external) {
      this.tooltip = `${external.target}\n${external.url}${external.operativeRevision ? `\n-r${external.operativeRevision}` : ''}`;
      this.command = {
        command: 'svnLens.updateExternalRevision',
        title: 'SVN: Update External Revision',
        arguments: [this],
      };
    }
  }
}

export class ExternalTreeProvider implements vscode.TreeDataProvider<ExternalTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ExternalTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getRepositories: RepositoryResolver) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: ExternalTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ExternalTreeItem): Promise<ExternalTreeItem[]> {
    if (!element) {
      const repositories = this.getRepositories();
      if (repositories.length === 0) {
        return [new ExternalTreeItem('placeholder', 'No SVN repositories', vscode.TreeItemCollapsibleState.None)];
      }

      return repositories.map(
        (repository) =>
          new ExternalTreeItem(
            'repo',
            path.basename(repository.rootUri.fsPath),
            vscode.TreeItemCollapsibleState.Collapsed,
            repository,
            undefined,
            undefined,
            repository.displayBranch,
          ),
      );
    }

    if (element.nodeKind === 'repo' && element.repository) {
      const externals = await element.repository.getExternals();
      if (externals.length === 0) {
        return [new ExternalTreeItem('placeholder', 'No svn:externals found', vscode.TreeItemCollapsibleState.None, element.repository)];
      }

      const owners = new Map<string, SvnExternalDefinition[]>();
      for (const external of externals) {
        const key = external.ownerRelativePath || '.';
        owners.set(key, [...(owners.get(key) ?? []), external]);
      }

      return [...owners.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([owner, values]) =>
          new ExternalTreeItem(
            'owner',
            owner === '.' ? 'root' : owner.split('/').at(-1) ?? owner,
            vscode.TreeItemCollapsibleState.Expanded,
            element.repository,
            owner,
            undefined,
            `${values.length} external${values.length === 1 ? '' : 's'}`,
          ),
        );
    }

    if (element.nodeKind === 'owner' && element.repository) {
      const externals = await element.repository.getExternals();
      return externals
        .filter((external) => (external.ownerRelativePath || '.') === (element.ownerRelativePath || '.'))
        .sort((left, right) => left.target.localeCompare(right.target))
        .map(
          (external) =>
            new ExternalTreeItem(
              'external',
              external.target,
              vscode.TreeItemCollapsibleState.None,
              element.repository,
              element.ownerRelativePath,
              external,
              `${external.operativeRevision ? `r${external.operativeRevision}` : 'floating'} → ${external.url}`,
            ),
        );
    }

    return [];
  }
}