import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSvnExecutable } from '../config';
import { SvnBlameLine, SvnInfo, SvnListEntry, SvnLogEntry, SvnStatusEntry } from '../types';
import { execFileText } from '../utils/process';
import { parseBlameXml, parseInfoXml, parseListXml, parseLogXml, parseStatusXml } from './xml';

export interface SvnLogOptions {
  revisionRange?: string;
  limit?: number;
  verbose?: boolean;
  searchTarget?: string;
}

export class SvnCli {
  public async info(target: string): Promise<SvnInfo> {
    const { stdout } = await this.run(['info', '--xml', target], this.getWorkingDirectory(target));
    return parseInfoXml(stdout);
  }

  public async isWorkingCopy(target: string): Promise<boolean> {
    try {
      await this.info(target);
      return true;
    } catch {
      return false;
    }
  }

  public async status(cwd: string): Promise<SvnStatusEntry[]> {
    const { stdout } = await this.run(['status', '--xml', '--ignore-externals'], cwd);
    return parseStatusXml(stdout, (relativePath) => path.resolve(cwd, relativePath)).map((entry) => ({
      ...entry,
      uri: vscode.Uri.file(entry.path),
    }));
  }

  public async checkout(url: string, directory: string, revision?: string): Promise<void> {
    const args = ['checkout', url, directory];
    if (revision) {
      args.push('-r', revision);
    }
    await this.run(args, path.dirname(directory));
  }

  public async import(localPath: string, url: string, message: string): Promise<void> {
    await this.run(['import', localPath, url, '-m', message], localPath);
  }

  public async update(cwd: string): Promise<string> {
    const { stdout } = await this.run(['update'], cwd);
    return stdout;
  }

  public async commit(cwd: string, message: string, paths?: readonly string[]): Promise<string> {
    const args = ['commit', '-m', message];
    if (paths && paths.length > 0) {
      args.push(...paths);
    }
    const { stdout } = await this.run(args, cwd);
    return stdout;
  }

  public async switch(cwd: string, url: string): Promise<string> {
    const { stdout } = await this.run(['switch', url], cwd);
    return stdout;
  }

  public async merge(cwd: string, sourceUrl: string, revisionRange?: string): Promise<string> {
    const args = ['merge'];
    if (revisionRange) {
      args.push('-r', revisionRange);
    }
    args.push(sourceUrl);
    const { stdout } = await this.run(args, cwd);
    return stdout;
  }

  public async resolve(cwd: string, target: string, accept: 'mine-full' | 'theirs-full' | 'working'): Promise<void> {
    await this.run(['resolve', '--accept', accept, target], cwd);
  }

  public async markResolved(cwd: string, target: string): Promise<void> {
    await this.run(['resolve', '--accept', 'working', target], cwd);
  }

  public async log(target: string, options: SvnLogOptions = {}): Promise<SvnLogEntry[]> {
    const args = ['log', '--xml'];
    if (options.verbose ?? true) {
      args.push('-v');
    }
    if (options.revisionRange) {
      args.push('-r', options.revisionRange);
    }
    if (options.limit) {
      args.push('--limit', String(options.limit));
    }
    args.push(options.searchTarget ?? target);
    const { stdout } = await this.run(args, this.getWorkingDirectory(options.searchTarget ?? target));
    return parseLogXml(stdout);
  }

  public async blame(target: string): Promise<SvnBlameLine[]> {
    const { stdout } = await this.run(['blame', '--xml', target], this.getWorkingDirectory(target));
    return parseBlameXml(stdout);
  }

  public async cat(target: string, revision?: string): Promise<string> {
    const args = ['cat'];
    if (revision) {
      args.push('-r', revision);
    }
    args.push(target);
    const { stdout } = await this.run(args, this.getWorkingDirectory(target));
    return stdout;
  }

  public async catRemote(url: string, revision?: string): Promise<string> {
    const args = ['cat'];
    if (revision) {
      args.push('-r', revision);
    }
    args.push(url);
    const { stdout } = await this.run(args);
    return stdout;
  }

  public async diff(target: string, revisionRange?: string): Promise<string> {
    const args = ['diff'];
    if (revisionRange) {
      args.push('-r', revisionRange);
    }
    args.push(target);
    const { stdout } = await this.run(args, this.getWorkingDirectory(target));
    return stdout;
  }

  public async list(url: string): Promise<SvnListEntry[]> {
    const normalizedUrl = url.replace(/\/+$/, '');
    const { stdout } = await this.run(['list', '--xml', normalizedUrl]);
    return parseListXml(stdout, normalizedUrl);
  }

  public async copy(fromUrl: string, toUrl: string, message: string): Promise<void> {
    await this.run(['copy', fromUrl, toUrl, '-m', message]);
  }

  public async exportPatch(cwd: string, outputFile: string): Promise<void> {
    const patch = await this.diff(cwd);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(outputFile), Buffer.from(patch, 'utf8'));
  }

  public async applyPatch(cwd: string, patchFile: string): Promise<void> {
    await this.run(['patch', patchFile], cwd);
  }

  public async propGet(cwd: string, propName: string, target: string): Promise<string> {
    const { stdout } = await this.run(['propget', propName, target], cwd);
    return stdout.trim();
  }

  public async propSet(cwd: string, propName: string, value: string, target: string): Promise<void> {
    await this.run(['propset', propName, value, target], cwd);
  }

  public async compareRevisions(target: string, leftRevision: string, rightRevision: string): Promise<string> {
    return this.diff(target, `${leftRevision}:${rightRevision}`);
  }

  private async run(args: readonly string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    const executable = getSvnExecutable(cwd ? vscode.Uri.file(cwd) : undefined);
    return execFileText(executable, args, { cwd });
  }

  private getWorkingDirectory(target: string): string | undefined {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      return undefined;
    }

    try {
      const stats = fs.statSync(target);
      return stats.isDirectory() ? target : path.dirname(target);
    } catch {
      return path.dirname(target);
    }
  }
}