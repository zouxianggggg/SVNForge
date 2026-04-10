export interface RepositorySnapshot {
  rootPath: string;
  branch: string;
  revision: number;
  statuses: string[];
  repoBrowserRoots: string[];
}

export interface SVNLensApi {
  refreshAll(): Promise<void>;
  getRepositorySnapshots(): Promise<RepositorySnapshot[]>;
  getOpenPanelKeys(): string[];
}
