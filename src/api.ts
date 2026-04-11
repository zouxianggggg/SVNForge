export interface RepositorySnapshot {
  rootPath: string;
  branch: string;
  revision: number;
  statuses: string[];
  repoBrowserRoots: string[];
}

export interface RepositoryLogPreviewEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
}

export interface FileHistoryPreviewEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
}

export interface BlamePreviewEntry {
  lineNumber: number;
  revision: number;
  author: string;
  date?: string;
}

export interface SVNLensApi {
  refreshAll(): Promise<void>;
  getRepositorySnapshots(): Promise<RepositorySnapshot[]>;
  getOpenPanelKeys(): string[];
  getRepositoryLogPreview(rootPath: string, pageSize?: number): Promise<RepositoryLogPreviewEntry[]>;
  getFileHistoryPreview(filePath: string, pageSize?: number): Promise<FileHistoryPreviewEntry[]>;
  getBlamePreview(filePath: string, maxLines?: number): Promise<BlamePreviewEntry[]>;
}
