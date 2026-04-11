import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { SVNLensApi } from '../../api';

const extensionId = 'zouxiangggggDev.svnforge';

function getRemoteWorkingCopyPath(): string {
  const value = process.env.SVNLENS_TEST_REMOTE_WORKING_COPY;
  if (!value) {
    throw new Error('SVNLENS_TEST_REMOTE_WORKING_COPY is not set.');
  }
  return value;
}

async function getApi(): Promise<SVNLensApi> {
  const extension = vscode.extensions.getExtension<SVNLensApi>(extensionId);
  assert.ok(extension, `Extension ${extensionId} not found`);
  return extension!.isActive ? extension!.exports : await extension!.activate();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Condition not satisfied within timeout.');
}

suite('SVNForge Remote Repository Smoke', () => {
  const remoteWorkingCopyPath = getRemoteWorkingCopyPath();
  const remoteFilePath = path.join(remoteWorkingCopyPath, '.clang-format');
  const remoteFileUri = vscode.Uri.file(remoteFilePath);

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('loads log, file history and blame from TortoiseSVN checkout', async () => {
    const api = await getApi();
    await api.refreshAll();

    await waitFor(async () => {
      const snapshots = await api.getRepositorySnapshots();
      return snapshots.some((item) => item.rootPath === remoteWorkingCopyPath);
    }, 30_000);

    const snapshots = await api.getRepositorySnapshots();
    const remoteSnapshot = snapshots.find((item) => item.rootPath === remoteWorkingCopyPath);
    assert.ok(remoteSnapshot, 'Remote repository snapshot should exist');
    assert.ok(remoteSnapshot!.repoBrowserRoots.some((url) => url.endsWith('/trunk')));

    const remoteLog = await api.getRepositoryLogPreview(remoteWorkingCopyPath, 5);
    assert.ok(remoteLog.length > 0, 'Remote repository log preview should not be empty');

    const remoteFileHistory = await api.getFileHistoryPreview(remoteFilePath, 5);
    assert.ok(remoteFileHistory.length > 0, 'Remote file history should not be empty');

    const remoteBlame = await api.getBlamePreview(remoteFilePath, 5);
    assert.ok(remoteBlame.length > 0, 'Remote blame preview should not be empty');

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(remoteFileUri));
    await vscode.commands.executeCommand('svnLens.showLog', vscode.Uri.file(remoteWorkingCopyPath));
    await vscode.commands.executeCommand('svnLens.showFileHistory', remoteFileUri);

    await waitFor(() => {
      const keys = api.getOpenPanelKeys();
      return keys.some((key) => key === `log:${vscode.Uri.file(remoteWorkingCopyPath).toString()}`) && keys.some((key) => key === `file:${remoteFileUri.toString()}`);
    }, 15_000);
  });
});
