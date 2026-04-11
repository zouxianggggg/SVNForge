import * as vscode from 'vscode';
import { SvnRepository } from '../services/svnRepository';

type RepositoryResolver = () => SvnRepository | undefined;
type UriResolver = () => vscode.Uri | undefined;

type ActionsPreset = 'basic' | 'complete';

type ActionKind =
  | 'checkout'
  | 'import'
  | 'refresh'
  | 'update'
  | 'log'
  | 'graph'
  | 'dashboard'
  | 'commit'
  | 'switch'
  | 'showInfo'
  | 'repoBrowser'
  | 'resetRepoBrowserRoot'
  | 'createBranch'
  | 'createTag'
  | 'mergeBranch'
  | 'compareRevisions'
  | 'exportPatch'
  | 'applyPatch'
  | 'fileHistory'
  | 'openDiff'
  | 'openConflictDiff'
  | 'acceptMine'
  | 'acceptTheirs'
  | 'markResolved'
  | 'manageIgnore'
  | 'toggleBlame';

type ActionNodeKind = 'group' | 'action';

class ActionTreeItem extends vscode.TreeItem {
  public constructor(
    label: string,
    public readonly nodeKind: ActionNodeKind,
    public readonly actionKind: ActionKind | undefined,
    command?: vscode.Command,
    description?: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState);
    this.contextValue = nodeKind === 'group' ? 'actionGroup' : 'actionItem';
    this.command = command;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(nodeKind === 'group' ? 'folder-library' : getActionIcon(actionKind));
  }
}

function getActionIcon(actionKind: ActionKind | undefined): string {
  switch (actionKind) {
    case 'checkout':
      return 'cloud-download';
    case 'import':
      return 'cloud-upload';
    case 'refresh':
      return 'refresh';
    case 'update':
      return 'arrow-circle-down';
    case 'log':
      return 'history';
    case 'graph':
      return 'graph';
    case 'dashboard':
      return 'dashboard';
    case 'commit':
      return 'check';
    case 'switch':
      return 'git-branch';
    case 'showInfo':
      return 'info';
    case 'repoBrowser':
      return 'repo';
    case 'resetRepoBrowserRoot':
      return 'discard';
    case 'createBranch':
      return 'git-branch-create';
    case 'createTag':
      return 'tag';
    case 'mergeBranch':
      return 'merge';
    case 'compareRevisions':
      return 'split-horizontal';
    case 'exportPatch':
      return 'save';
    case 'applyPatch':
      return 'replace-all';
    case 'fileHistory':
      return 'file-code';
    case 'openDiff':
      return 'diff';
    case 'openConflictDiff':
      return 'warning';
    case 'acceptMine':
      return 'arrow-left';
    case 'acceptTheirs':
      return 'arrow-right';
    case 'markResolved':
      return 'pass';
    case 'manageIgnore':
      return 'exclude';
    case 'toggleBlame':
      return 'comment-discussion';
    default:
      return 'play';
  }
}

export class ActionTreeProvider implements vscode.TreeDataProvider<ActionTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ActionTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly getPreferredRepository: RepositoryResolver,
    private readonly getActiveUri: UriResolver,
  ) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: ActionTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ActionTreeItem): ActionTreeItem[] {
    const repository = this.getPreferredRepository();
    const activeUri = this.getActiveUri();
    const preset = this.getActionsPreset(repository?.rootUri);

    if (element?.nodeKind === 'group') {
      const groupLabel = typeof element.label === 'string' ? element.label : element.label?.label ?? '';
      return this.getGroupChildren(groupLabel, repository, activeUri, preset);
    }

    if (!repository) {
      return [
        new ActionTreeItem('Getting Started', 'group', undefined, undefined, 'Open or create a working copy', vscode.TreeItemCollapsibleState.Expanded),
      ];
    }

    const groups = ['Workspace', 'History & Review', 'Branches & Tags'];
    if (preset === 'complete') {
      groups.push('File & Patch', 'Advanced');
    }
    return groups.map(
      (group) => new ActionTreeItem(group, 'group', undefined, undefined, this.getGroupDescription(group, repository, activeUri), vscode.TreeItemCollapsibleState.Expanded),
    );
  }

  private getGroupChildren(
    groupLabel: string,
    repository: SvnRepository | undefined,
    activeUri: vscode.Uri | undefined,
    preset: ActionsPreset,
  ): ActionTreeItem[] {
    if (!repository) {
      return [
        this.createActionItem('Checkout', 'checkout', { command: 'svnLens.checkout', title: 'SVN Checkout' }, 'Clone a repository'),
        this.createActionItem('Import', 'import', { command: 'svnLens.import', title: 'SVN Import' }, 'Import a local folder'),
      ];
    }

    const activeFile = activeUri && activeUri.fsPath.startsWith(repository.rootUri.fsPath) ? activeUri : undefined;
    switch (groupLabel) {
      case 'Workspace':
        return [
          this.createActionItem('Refresh', 'refresh', { command: 'svnLens.refresh', title: 'SVN Refresh', arguments: [repository.rootUri] }, 'Rescan status'),
          this.createActionItem('Update', 'update', { command: 'svnLens.update', title: 'SVN Update', arguments: [repository.rootUri] }, 'Pull latest changes'),
          this.createActionItem('Commit', 'commit', { command: 'svnLens.commit', title: 'SVN Commit', arguments: [repository.rootUri] }, 'Commit current changes'),
          this.createActionItem('Switch', 'switch', { command: 'svnLens.switch', title: 'SVN Switch', arguments: [repository.rootUri] }, 'Switch branch or tag'),
          this.createActionItem('Repository Info', 'showInfo', { command: 'svnLens.showInfo', title: 'SVN Show Repository Info', arguments: [repository.rootUri] }, repository.displayBranch),
          this.createActionItem('Workspace Dashboard', 'dashboard', { command: 'svnLens.openRepoBrowser', title: 'SVN Workspace Dashboard' }, repository.displayBranch),
          this.createActionItem('Checkout Another Repo', 'checkout', { command: 'svnLens.checkout', title: 'SVN Checkout' }, 'Open another working copy'),
          this.createActionItem('Import Folder', 'import', { command: 'svnLens.import', title: 'SVN Import' }, 'Import local contents'),
        ];
      case 'History & Review':
        return [
          this.createActionItem('Log', 'log', { command: 'svnLens.showLog', title: 'SVN Show Log', arguments: [repository.rootUri] }, 'Open history view'),
          this.createActionItem('Graph', 'graph', { command: 'svnLens.showGraph', title: 'SVN Show Graph', arguments: [repository.rootUri] }, 'Open graph view'),
          this.createActionItem('Toggle Blame', 'toggleBlame', { command: 'svnLens.toggleBlame', title: 'SVN Toggle Blame' }, 'Current line blame'),
          ...(activeFile
            ? [
                this.createActionItem('File History', 'fileHistory', { command: 'svnLens.showFileHistory', title: 'SVN File History', arguments: [activeFile] }, pathLabel(activeFile)),
                this.createActionItem('Working Diff', 'openDiff', { command: 'svnLens.openDiff', title: 'SVN Working Diff', arguments: [activeFile] }, 'Compare BASE and working copy'),
                this.createActionItem('Compare Revisions', 'compareRevisions', { command: 'svnLens.compareRevisions', title: 'SVN Compare Revisions', arguments: [activeFile] }, pathLabel(activeFile)),
              ]
            : []),
        ];
      case 'Branches & Tags':
        return [
          this.createActionItem('Create Branch', 'createBranch', { command: 'svnLens.createBranch', title: 'SVN Create Branch' }, 'Prompt for branch name'),
          this.createActionItem('Create Tag', 'createTag', { command: 'svnLens.createTag', title: 'SVN Create Tag' }, 'Prompt for tag name'),
          this.createActionItem('Merge Branch', 'mergeBranch', { command: 'svnLens.mergeBranch', title: 'SVN Merge Branch' }, 'Prompt for source branch URL'),
          this.createActionItem('Repository Browser', 'repoBrowser', { command: 'svnLens.openRepoBrowser', title: 'SVN Open Repository Browser' }, 'Browse remote tree'),
          this.createActionItem('Reset Browser Root', 'resetRepoBrowserRoot', { command: 'svnLens.resetRepoBrowserRoot', title: 'SVN Reset Repository Browser Root' }, 'Back to default SVN layout'),
        ];
      case 'File & Patch':
        return [
          ...(activeFile
            ? [
                this.createActionItem('Manage Ignore', 'manageIgnore', { command: 'svnLens.manageIgnore', title: 'SVN Manage Ignore', arguments: [activeFile] }, 'Edit svn:ignore'),
              ]
            : []),
          this.createActionItem('Export Patch', 'exportPatch', { command: 'svnLens.exportPatch', title: 'SVN Export Patch', arguments: [repository.rootUri] }, 'Save local changes as patch'),
          this.createActionItem('Apply Patch', 'applyPatch', { command: 'svnLens.applyPatch', title: 'SVN Apply Patch', arguments: [repository.rootUri] }, 'Apply a patch file'),
        ];
      case 'Advanced':
        return [
          this.createActionItem('Open Repository Browser', 'repoBrowser', { command: 'svnLens.openRepoBrowser', title: 'SVN Open Repository Browser' }, 'Open remote browser and dashboard'),
          ...(preset === 'complete' ? this.createAdvancedFileActions(activeFile) : []),
        ];
      default:
        return [];
    }
  }

  private createAdvancedFileActions(activeFile: vscode.Uri | undefined): ActionTreeItem[] {
    if (!activeFile) {
      return [];
    }

    return [
      this.createActionItem('File History (Current File)', 'fileHistory', { command: 'svnLens.showFileHistory', title: 'SVN File History', arguments: [activeFile] }, pathLabel(activeFile)),
      this.createActionItem('Working Diff (Current File)', 'openDiff', { command: 'svnLens.openDiff', title: 'SVN Working Diff', arguments: [activeFile] }, pathLabel(activeFile)),
      this.createActionItem('Compare Revisions (Current File)', 'compareRevisions', { command: 'svnLens.compareRevisions', title: 'SVN Compare Revisions', arguments: [activeFile] }, pathLabel(activeFile)),
      this.createActionItem('Conflict Diff', 'openConflictDiff', { command: 'svnLens.openConflictDiff', title: 'SVN Open Conflict Diff', arguments: [activeFile] }, pathLabel(activeFile)),
      this.createActionItem('Accept Mine', 'acceptMine', { command: 'svnLens.acceptMine', title: 'SVN Accept Mine', arguments: [activeFile] }, 'Resolve conflict with local version'),
      this.createActionItem('Accept Theirs', 'acceptTheirs', { command: 'svnLens.acceptTheirs', title: 'SVN Accept Theirs', arguments: [activeFile] }, 'Resolve conflict with incoming version'),
      this.createActionItem('Mark Resolved', 'markResolved', { command: 'svnLens.markResolved', title: 'SVN Mark Resolved', arguments: [activeFile] }, 'Mark current file resolved'),
    ];
  }

  private createActionItem(label: string, actionKind: ActionKind, command?: vscode.Command, description?: string): ActionTreeItem {
    return new ActionTreeItem(label, 'action', actionKind, command, description);
  }

  private getGroupDescription(group: string, repository: SvnRepository, activeUri: vscode.Uri | undefined): string | undefined {
    switch (group) {
      case 'Workspace':
        return repository.displayBranch;
      case 'History & Review':
        return activeUri ? pathLabel(activeUri) : 'Review changes';
      case 'Branches & Tags':
        return 'Branching workflows';
      case 'File & Patch':
        return 'Patch and ignore tools';
      case 'Advanced':
        return 'Low-level operations';
      default:
        return undefined;
    }
  }

  private getActionsPreset(scope?: vscode.ConfigurationScope): ActionsPreset {
    const value = vscode.workspace.getConfiguration('svnLens', scope).get<string>('actionsPreset', 'complete');
    return value === 'basic' ? 'basic' : 'complete';
  }
}

function pathLabel(uri: vscode.Uri): string {
  return uri.fsPath.split('/').at(-1) ?? uri.fsPath;
}