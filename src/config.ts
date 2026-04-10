import * as vscode from 'vscode';

const SECTION = 'svnLens';

export function getConfig(scope?: vscode.ConfigurationScope): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION, scope);
}

export function getSvnExecutable(scope?: vscode.ConfigurationScope): string {
  return getConfig(scope).get<string>('svnPath', 'svn');
}

export function getAutoRefresh(scope?: vscode.ConfigurationScope): boolean {
  return getConfig(scope).get<boolean>('autoRefresh', true);
}

export function getRefreshDebounceMs(scope?: vscode.ConfigurationScope): number {
  return getConfig(scope).get<number>('refreshDebounceMs', 1500);
}

export function getLogPageSize(scope?: vscode.ConfigurationScope): number {
  return getConfig(scope).get<number>('logPageSize', 50);
}

export function getBlameDecorationsEnabled(scope?: vscode.ConfigurationScope): boolean {
  return getConfig(scope).get<boolean>('enableBlameDecorations', true);
}

export function getCommitMessagePattern(scope?: vscode.ConfigurationScope): string {
  return getConfig(scope).get<string>('commitMessagePattern', '');
}

export function getPreCommitCommand(scope?: vscode.ConfigurationScope): string {
  return getConfig(scope).get<string>('preCommitCommand', '');
}

export function getDefaultBranchRoots(scope?: vscode.ConfigurationScope): string[] {
  return getConfig(scope).get<string[]>('defaultBranchRoots', ['trunk', 'branches', 'tags']);
}

export function getJenkinsBaseUrl(scope?: vscode.ConfigurationScope): string {
  return getConfig(scope).get<string>('jenkins.baseUrl', '');
}

export function getJenkinsJobPathTemplate(scope?: vscode.ConfigurationScope): string {
  return getConfig(scope).get<string>('jenkins.jobPathTemplate', 'job/{branch}/api/json');
}
