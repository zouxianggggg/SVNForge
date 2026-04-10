import * as vscode from 'vscode';
import { SvnRepository } from '../services/svnRepository';

export class BranchTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly repository: SvnRepository,
    public readonly url: string,
    public readonly category: 'repo' | 'trunk' | 'branches' | 'tags' | 'branch' | 'tag',
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);
    this.contextValue =
      category === 'repo'
        ? 'repositoryRoot'
        : category === 'branch'
          ? 'branchItem'
          : category === 'tag'
            ? 'tagItem'
            : 'branchRoot';
    this.iconPath = new vscode.ThemeIcon(category === 'repo' ? 'repo' : category === 'tag' ? 'tag' : 'git-branch');
    this.description = url;
  }
}

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchTreeItem> {
  private readonly emitter = new vscode.EventEmitter<BranchTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getRepositories: () => readonly SvnRepository[]) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: BranchTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BranchTreeItem): Promise<BranchTreeItem[]> {
    if (!element) {
      return this.getRepositories().map(
        (repository) =>
          new BranchTreeItem(
            repository,
            repository.rootUri.toString(),
            'repo',
            repository.rootUri.path.split('/').at(-1) ?? repository.rootUri.fsPath,
            vscode.TreeItemCollapsibleState.Collapsed,
          ),
      );
    }

    if (element.category === 'repo') {
      const roots = await element.repository.getBranchRootItems();
      return roots.map((root) => {
        const category = root.label === 'tags' ? 'tags' : root.label === 'branches' ? 'branches' : 'trunk';
        return new BranchTreeItem(
          element.repository,
          root.url,
          category,
          root.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
      });
    }

    try {
      const children = await element.repository.listRemote(element.url);
      return children
        .filter((entry) => entry.kind === 'dir')
        .map(
          (entry) =>
            new BranchTreeItem(
              element.repository,
              entry.url,
              element.category === 'tags' ? 'tag' : 'branch',
              entry.name,
              vscode.TreeItemCollapsibleState.Collapsed,
            ),
        );
    } catch {
      return [];
    }
  }
}