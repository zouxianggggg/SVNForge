import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { LogPage, LogQuery, SvnLogEntry } from '../types';

function serializePaths(entry: SvnLogEntry): string {
  return JSON.stringify(entry.changedPaths ?? []);
}

function deserializePaths(value: string): SvnLogEntry['changedPaths'] {
  try {
    return JSON.parse(value) as SvnLogEntry['changedPaths'];
  } catch {
    return [];
  }
}

export class LogCache implements vscode.Disposable {
  private database: Database | undefined;
  private sql: SqlJsStatic | undefined;
  private readonly memoryFallback = new Map<string, Map<number, SvnLogEntry>>();
  private initialized: Promise<void> | undefined;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.doInitialize();
    }
    await this.initialized;
  }

  public async store(scopeId: string, entries: readonly SvnLogEntry[]): Promise<void> {
    await this.initialize();
    if (entries.length === 0) {
      return;
    }

    if (this.database) {
      this.database.run('BEGIN');
      try {
        const statement = this.database.prepare(
          'INSERT OR REPLACE INTO logs (scope_id, revision, author, date, message, changed_paths) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const entry of entries) {
          statement.run([
            scopeId,
            entry.revision,
            entry.author,
            entry.date,
            entry.message,
            serializePaths(entry),
          ]);
        }
        statement.free();
        this.database.run('COMMIT');
      } catch (error) {
        this.database.run('ROLLBACK');
        throw error;
      }

      this.schedulePersist();
      return;
    }

    const bucket = this.getFallbackBucket(scopeId);
    for (const entry of entries) {
      bucket.set(entry.revision, entry);
    }
  }

  public async query(scopeId: string, query: LogQuery): Promise<LogPage> {
    await this.initialize();
    if (this.database) {
      return this.queryDatabase(scopeId, query);
    }

    const rows = Array.from(this.getFallbackBucket(scopeId).values())
      .filter((entry) => this.matchesQuery(entry, query))
      .sort((left, right) => right.revision - left.revision);
    const offset = query.page * query.pageSize;
    const pageEntries = rows.slice(offset, offset + query.pageSize + 1);
    return {
      entries: pageEntries.slice(0, query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      hasMore: pageEntries.length > query.pageSize,
    };
  }

  public async get(scopeId: string, revision: number): Promise<SvnLogEntry | undefined> {
    await this.initialize();
    if (this.database) {
      const statement = this.database.prepare(
        'SELECT revision, author, date, message, changed_paths FROM logs WHERE scope_id = ? AND revision = ? LIMIT 1',
      );
      statement.bind([scopeId, revision]);
      const hasRow = statement.step();
      if (!hasRow) {
        statement.free();
        return undefined;
      }
      const row = statement.getAsObject() as Record<string, unknown>;
      statement.free();
      return {
        revision: Number(row.revision ?? revision),
        author: String(row.author ?? 'unknown'),
        date: String(row.date ?? ''),
        message: String(row.message ?? ''),
        changedPaths: deserializePaths(String(row.changed_paths ?? '[]')),
        cached: true,
      };
    }

    return this.getFallbackBucket(scopeId).get(revision);
  }

  public dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    if (this.database) {
      this.persistDatabase().catch(() => undefined);
      this.database.close();
    }
  }

  private async doInitialize(): Promise<void> {
    const storagePath = this.context.globalStorageUri.fsPath;
    await fs.mkdir(storagePath, { recursive: true });
    const databasePath = this.getDatabasePath();

    try {
      this.sql = await initSqlJs({
        locateFile: (fileName: string) => path.join(this.context.extensionPath, 'node_modules', 'sql.js', 'dist', fileName),
      });

      let databaseBytes: Uint8Array | undefined;
      try {
        databaseBytes = new Uint8Array(await fs.readFile(databasePath));
      } catch {
        databaseBytes = undefined;
      }

      this.database = databaseBytes ? new this.sql.Database(databaseBytes) : new this.sql.Database();
      this.database.run(
        'CREATE TABLE IF NOT EXISTS logs (' +
          'scope_id TEXT NOT NULL,' +
          'revision INTEGER NOT NULL,' +
          'author TEXT,' +
          'date TEXT,' +
          'message TEXT,' +
          'changed_paths TEXT,' +
          'PRIMARY KEY (scope_id, revision)' +
          ')',
      );
    } catch (error) {
      void vscode.window.showWarningMessage(`SVNLens: SQLite log cache unavailable, using in-memory cache. ${String(error)}`);
      this.database = undefined;
    }
  }

  private queryDatabase(scopeId: string, query: LogQuery): LogPage {
    const where: string[] = ['scope_id = ?'];
    const params: Array<string | number> = [scopeId];

    if (query.author) {
      where.push('LOWER(author) LIKE ?');
      params.push(`%${query.author.toLowerCase()}%`);
    }
    if (query.from) {
      where.push('date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('date <= ?');
      params.push(query.to);
    }

    const offset = query.page * query.pageSize;
    const sql =
      'SELECT revision, author, date, message, changed_paths FROM logs WHERE ' +
      where.join(' AND ') +
      ' ORDER BY revision DESC LIMIT ? OFFSET ?';
    const statement = this.database!.prepare(sql);
    statement.bind([...params, query.pageSize + 1, offset]);
    const entries: SvnLogEntry[] = [];
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      entries.push({
        revision: Number(row.revision ?? 0),
        author: String(row.author ?? 'unknown'),
        date: String(row.date ?? ''),
        message: String(row.message ?? ''),
        changedPaths: deserializePaths(String(row.changed_paths ?? '[]')),
        cached: true,
      });
    }
    statement.free();

    return {
      entries: entries.slice(0, query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      hasMore: entries.length > query.pageSize,
    };
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.persistDatabase().catch(() => undefined);
    }, 2000);
  }

  private async persistDatabase(): Promise<void> {
    if (!this.database || !this.dirty) {
      return;
    }
    const bytes = this.database.export();
    await fs.writeFile(this.getDatabasePath(), Buffer.from(bytes));
    this.dirty = false;
  }

  private getDatabasePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'svnlens-log-cache.db');
  }

  private getFallbackBucket(scopeId: string): Map<number, SvnLogEntry> {
    let bucket = this.memoryFallback.get(scopeId);
    if (!bucket) {
      bucket = new Map<number, SvnLogEntry>();
      this.memoryFallback.set(scopeId, bucket);
    }
    return bucket;
  }

  private matchesQuery(entry: SvnLogEntry, query: LogQuery): boolean {
    if (query.author && !entry.author.toLowerCase().includes(query.author.toLowerCase())) {
      return false;
    }
    if (query.from && entry.date < query.from) {
      return false;
    }
    if (query.to && entry.date > query.to) {
      return false;
    }
    return true;
  }
}
