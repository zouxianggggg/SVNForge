import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SVNLensApi } from '../../api';

const extensionId = 'zouxiangggggDev.svnforge';

function getWorkingCopyPath(): string {
  const value = process.env.SVNLENS_TEST_WORKING_COPY;
  if (!value) {
    throw new Error('SVNLENS_TEST_WORKING_COPY is not set.');
  }
  return value;
}

function getSecondWorkingCopyPath(): string {
  const value = process.env.SVNLENS_TEST_SECOND_WORKING_COPY;
  if (!value) {
    throw new Error('SVNLENS_TEST_SECOND_WORKING_COPY is not set.');
  }
  return value;
}

function svn(args: string[], cwd?: string, allowFailure = false): string {
  if (allowFailure) {
    const result = spawnSync('svn', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return `${result.stdout}${result.stderr}`;
  }

  return execFileSync('svn', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function getApi(): Promise<SVNLensApi> {
  const extension = vscode.extensions.getExtension<SVNLensApi>(extensionId);
  assert.ok(extension, `Extension ${extensionId} not found`);
  return extension!.isActive ? extension!.exports : await extension!.activate();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Condition not satisfied within timeout.');
}

suite('SVNForge Extension Host', () => {
  const workingCopyPath = getWorkingCopyPath();
  const secondWorkingCopyPath = getSecondWorkingCopyPath();
  const filePath = path.join(workingCopyPath, 'app.txt');
  const fileUri = vscode.Uri.file(filePath);

  teardown(async () => {
    try {
      svn(['revert', '-R', workingCopyPath], workingCopyPath, true);
      svn(['resolve', '--accept', 'working', filePath], workingCopyPath, true);
      svn(['cleanup', workingCopyPath], workingCopyPath, true);
      fs.rmSync(path.join(workingCopyPath, 'scratch.tmp'), { force: true });
      fs.rmSync(path.join(workingCopyPath, 'ignored.cache'), { force: true });
    } catch {
      // Best-effort cleanup for test isolation.
    }
    await (await getApi()).refreshAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('discovers repository state and local changes', async () => {
    const api = await getApi();
    fs.appendFileSync(filePath, 'local-change\n', 'utf8');
    fs.writeFileSync(path.join(workingCopyPath, 'scratch.tmp'), 'temp\n', 'utf8');

    await api.refreshAll();
    const snapshots = await api.getRepositorySnapshots();
    const snapshot = snapshots.find((item) => item.rootPath === workingCopyPath);
    assert.ok(snapshot, 'Repository snapshot should exist');
    assert.ok(snapshot!.statuses.includes('modified'));
    assert.ok(snapshot!.statuses.includes('unversioned'));
    assert.ok(snapshot!.repoBrowserRoots.some((url) => url.endsWith('/trunk')));
  });

  test('opens dashboard, log, graph and file history panels', async () => {
    const api = await getApi();
    await api.refreshAll();

    const logPreview = await api.getRepositoryLogPreview(workingCopyPath, 5);
    assert.ok(logPreview.length > 0, 'Repository log preview should not be empty');
    assert.ok(
      logPreview.some((entry) => /Initial file|Initialize layout/.test(entry.message)),
      'Repository log preview should include recent commits',
    );

    await vscode.commands.executeCommand('svnLens.openRepoBrowser');
    await vscode.commands.executeCommand('svnLens.showLog');
    await vscode.commands.executeCommand('svnLens.showGraph');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri));
    await vscode.commands.executeCommand('svnLens.showFileHistory', fileUri);

    await waitFor(() => {
      const keys = api.getOpenPanelKeys();
      return (
        keys.some((key) => key.startsWith('dashboard:')) &&
        keys.some((key) => key.startsWith('log:')) &&
        keys.some((key) => key.startsWith('graph:')) &&
        keys.some((key) => key.startsWith('file:'))
      );
    });
  });

  test('acceptMine resolves a text conflict', async () => {
    const api = await getApi();
    fs.writeFileSync(filePath, 'mine\n', 'utf8');
    fs.writeFileSync(path.join(secondWorkingCopyPath, 'app.txt'), 'theirs\n', 'utf8');
    svn(['commit', secondWorkingCopyPath, '-m', 'Incoming conflicting change'], secondWorkingCopyPath);
    const updateOutput = svn(['update', workingCopyPath], workingCopyPath, true);

    assert.match(updateOutput, /(C|conflict)/i);
    await api.refreshAll();

    const beforeResolve = await api.getRepositorySnapshots();
    const snapshot = beforeResolve.find((item) => item.rootPath === workingCopyPath);
    assert.ok(snapshot?.statuses.includes('conflicted'));

    await vscode.commands.executeCommand('svnLens.acceptMine', fileUri);
    await waitFor(async () => {
      const afterResolve = await api.getRepositorySnapshots();
      const afterSnapshot = afterResolve.find((item) => item.rootPath === workingCopyPath);
      return !!afterSnapshot && !afterSnapshot.statuses.includes('conflicted');
    });

    const content = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(content, 'mine\n');
  });
});
