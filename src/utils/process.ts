import { exec, execFile, ExecException, ExecFileException } from 'child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class CommandExecutionError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly command: string;
  public readonly args: readonly string[];

  public constructor(
    message: string,
    command: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.command = command;
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function execFileText(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new CommandExecutionError(error.message, command, args, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function execShellText(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error: ExecException | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new CommandExecutionError(error.message, command, [], stdout, stderr));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
