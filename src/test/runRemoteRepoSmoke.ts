import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const remoteWorkingCopyPath = process.env.SVNLENS_TEST_REMOTE_WORKING_COPY;
  if (!remoteWorkingCopyPath) {
    throw new Error('SVNLENS_TEST_REMOTE_WORKING_COPY is not set.');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svnlens-remote-test-'));
  const userDataDir = path.join(tempRoot, 'vscode-user-data');

  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/remoteIndex');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--new-window', '--disable-workspace-trust', '--user-data-dir', userDataDir, remoteWorkingCopyPath],
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main();