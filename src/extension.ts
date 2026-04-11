import * as vscode from 'vscode';
import { SVNLensApi } from './api';
import { RepositoryManager } from './services/repositoryManager';

let manager: RepositoryManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<SVNLensApi> {
  manager = new RepositoryManager(context);
  context.subscriptions.push(manager);
  await manager.activate();
  return {
    refreshAll: () => manager!.refreshAllFromApi(),
    getRepositorySnapshots: () => manager!.getRepositorySnapshots(),
    getOpenPanelKeys: () => manager!.getOpenPanelKeys(),
    getRepositoryLogPreview: (rootPath: string, pageSize?: number) => manager!.getRepositoryLogPreview(rootPath, pageSize),
    getFileHistoryPreview: (filePath: string, pageSize?: number) => manager!.getFileHistoryPreview(filePath, pageSize),
    getBlamePreview: (filePath: string, maxLines?: number) => manager!.getBlamePreview(filePath, maxLines),
  };
}

export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}