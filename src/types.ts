import * as vscode from 'vscode';

export type SvnStatusKind =
  | 'normal'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'conflicted'
  | 'unversioned'
  | 'missing'
  | 'replaced'
  | 'external'
  | 'ignored';

export interface SvnInfo {
  url: string;
  rootUrl: string;
  relativeUrl: string;
  revision: number;
  repositoryUuid?: string;
  lastChangedRevision?: number;
}

export interface SvnStatusEntry {
  path: string;
  uri: vscode.Uri;
  status: SvnStatusKind;
  propsStatus?: string;
  revision?: number;
  copied?: boolean;
  treeConflicted?: boolean;
}

export interface SvnChangedPath {
  action: string;
  path: string;
  copyFromPath?: string;
  copyFromRevision?: number;
}

export interface SvnLogEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
  changedPaths: SvnChangedPath[];
  cached?: boolean;
}

export interface SvnBlameLine {
  lineNumber: number;
  author: string;
  revision: number;
  date?: string;
  message?: string;
}

export interface SvnListEntry {
  name: string;
  path: string;
  url: string;
  kind: 'file' | 'dir';
  size?: number;
  revision?: number;
  author?: string;
  date?: string;
}

export interface LogQuery {
  page: number;
  pageSize: number;
  author?: string;
  from?: string;
  to?: string;
}

export interface LogPage {
  entries: SvnLogEntry[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface CompareRequest {
  target: vscode.Uri;
  leftRevision: string;
  rightRevision: string;
}

export interface CachedBlameDocument {
  uri: string;
  lines: SvnBlameLine[];
  fetchedAt: number;
}

export interface JenkinsBuildStatus {
  label: string;
  color: string;
  url?: string;
}

export interface RepoSelection {
  repositoryRoot: vscode.Uri;
  workingCopyPath: string;
}
