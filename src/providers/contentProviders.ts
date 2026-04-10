import * as vscode from 'vscode';
import { SvnRepository } from '../services/svnRepository';
import { parsePayload, SVN_BASE_SCHEME, SVN_REMOTE_SCHEME, SVN_REVISION_SCHEME } from './uri';

type RepositoryResolver = (repoRoot?: string, filePath?: string) => SvnRepository | undefined;

export class SvnContentProvider implements vscode.TextDocumentContentProvider {
  public constructor(private readonly resolveRepository: RepositoryResolver) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const payload = parsePayload(uri);
    const repository = this.resolveRepository(payload.repoRoot, payload.filePath);

    if (uri.scheme === SVN_BASE_SCHEME) {
      if (!repository || !payload.filePath) {
        return '';
      }
      return repository.readBaseContent(payload.filePath);
    }

    if (uri.scheme === SVN_REVISION_SCHEME) {
      if (!repository || !payload.filePath || !payload.revision) {
        return '';
      }
      return repository.readRevisionContent(payload.filePath, payload.revision);
    }

    if (uri.scheme === SVN_REMOTE_SCHEME) {
      if (!repository || !payload.url) {
        return '';
      }
      return repository.readRemoteContent(payload.url, payload.revision);
    }

    return '';
  }
}
