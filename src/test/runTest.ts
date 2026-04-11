import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runTests } from '@vscode/test-electron';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function svn(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svnlens-ext-test-'));
  const repoPath = path.join(tempRoot, 'repo');
  const workingCopyPath = path.join(tempRoot, 'wc');
  const secondWorkingCopyPath = path.join(tempRoot, 'wc-second');
  const userDataDir = path.join(tempRoot, 'vscode-user-data');
  const repoUrl = pathToFileURL(repoPath).toString();

  try {
    svn('svnadmin', ['create', repoPath]);
    svn('svn', ['mkdir', `${repoUrl}/trunk`, `${repoUrl}/branches`, `${repoUrl}/tags`, '-m', 'Initialize layout']);
    svn('svn', ['checkout', `${repoUrl}/trunk`, workingCopyPath]);

    writeFile(path.join(workingCopyPath, 'app.txt'), 'base\n');
    svn('svn', ['add', path.join(workingCopyPath, 'app.txt')], workingCopyPath);
    svn('svn', ['commit', workingCopyPath, '-m', 'Initial file'], workingCopyPath);
    svn('svn', ['checkout', `${repoUrl}/trunk`, secondWorkingCopyPath]);

    process.env.SVNLENS_TEST_REPO_URL = repoUrl;
    process.env.SVNLENS_TEST_WORKING_COPY = workingCopyPath;
    process.env.SVNLENS_TEST_SECOND_WORKING_COPY = secondWorkingCopyPath;

    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--new-window', '--disable-workspace-trust', '--user-data-dir', userDataDir, workingCopyPath],
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main();
