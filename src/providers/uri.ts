import * as vscode from 'vscode';

export const SVN_BASE_SCHEME = 'svn-base';
export const SVN_REVISION_SCHEME = 'svn-revision';
export const SVN_REMOTE_SCHEME = 'svn-remote';

export interface SvnVirtualUriPayload {
  repoRoot?: string;
  filePath?: string;
  url?: string;
  revision?: string;
  title?: string;
}

function encodePayload(payload: SvnVirtualUriPayload): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
}

export function parsePayload(uri: vscode.Uri): SvnVirtualUriPayload {
  const params = new URLSearchParams(uri.query);
  return {
    repoRoot: params.get('repoRoot') ?? undefined,
    filePath: params.get('filePath') ?? undefined,
    url: params.get('url') ?? undefined,
    revision: params.get('revision') ?? undefined,
    title: params.get('title') ?? undefined,
  };
}

export function buildBaseUri(fileUri: vscode.Uri, repoRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.parse(
    `${SVN_BASE_SCHEME}:${fileUri.path}?${encodePayload({
      repoRoot: repoRoot.fsPath,
      filePath: fileUri.fsPath,
      revision: 'BASE',
      title: `${fileUri.path} (BASE)`,
    })}`,
  );
}

export function buildRevisionUri(fileUri: vscode.Uri, repoRoot: vscode.Uri, revision: string): vscode.Uri {
  return vscode.Uri.parse(
    `${SVN_REVISION_SCHEME}:${fileUri.path}?${encodePayload({
      repoRoot: repoRoot.fsPath,
      filePath: fileUri.fsPath,
      revision,
      title: `${fileUri.path}@${revision}`,
    })}`,
  );
}

export function buildRemoteUri(url: string, revision?: string, title?: string, repoRoot?: string): vscode.Uri {
  return vscode.Uri.parse(
    `${SVN_REMOTE_SCHEME}:${new URL(url).pathname}?${encodePayload({
      repoRoot,
      url,
      revision,
      title: title ?? url,
    })}`,
  );
}
