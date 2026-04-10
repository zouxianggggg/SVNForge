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
  };
}

export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}