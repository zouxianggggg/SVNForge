import { XMLParser } from 'fast-xml-parser';
import { SvnBlameLine, SvnInfo, SvnListEntry, SvnLogEntry, SvnStatusEntry, SvnStatusKind } from '../types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeStatusKind(value: string | undefined): SvnStatusKind {
  switch (value) {
    case 'modified':
    case 'added':
    case 'deleted':
    case 'conflicted':
    case 'unversioned':
    case 'missing':
    case 'replaced':
    case 'external':
    case 'ignored':
      return value;
    default:
      return 'normal';
  }
}

export function parseInfoXml(xml: string): SvnInfo {
  const root = parser.parse(xml);
  const entry = root?.info?.entry;
  if (!entry) {
    throw new Error('Failed to parse svn info output.');
  }

  return {
    url: String(entry.url ?? ''),
    rootUrl: String(entry.repository?.root ?? ''),
    relativeUrl: String(entry['relative-url'] ?? ''),
    revision: Number(entry.revision ?? entry.commit?.revision ?? 0),
    repositoryUuid: entry.repository?.uuid ? String(entry.repository.uuid) : undefined,
    lastChangedRevision: entry.commit?.revision ? Number(entry.commit.revision) : undefined,
  };
}

export function parseStatusXml(xml: string, toAbsolutePath: (path: string) => string): SvnStatusEntry[] {
  const root = parser.parse(xml);
  const targets = asArray(root?.status?.target);
  const entries: SvnStatusEntry[] = [];

  for (const target of targets) {
    for (const entry of asArray(target?.entry)) {
      const wcStatus = entry?.['wc-status'];
      if (!wcStatus) {
        continue;
      }

      const absolutePath = toAbsolutePath(String(entry.path ?? ''));
      entries.push({
        path: absolutePath,
        uri: undefined as never,
        status: normalizeStatusKind(wcStatus.item),
        propsStatus: wcStatus.props ? String(wcStatus.props) : undefined,
        revision: wcStatus.revision ? Number(wcStatus.revision) : undefined,
        copied: String(wcStatus.copied ?? 'false') === 'true',
        treeConflicted: String(wcStatus['tree-conflicted'] ?? 'false') === 'true',
      });
    }
  }

  return entries;
}

export function parseLogXml(xml: string): SvnLogEntry[] {
  const root = parser.parse(xml);
  const logEntries = asArray(root?.log?.logentry);
  return logEntries.map((entry: Record<string, unknown>) => ({
    revision: Number(entry.revision ?? 0),
    author: String(entry.author ?? 'unknown'),
    date: String(entry.date ?? ''),
    message: String(entry.msg ?? ''),
    changedPaths: asArray(((entry.paths as { path?: Record<string, unknown> | Record<string, unknown>[] } | undefined)?.path)).map((pathEntry: Record<string, unknown>) => ({
      action: String(pathEntry.action ?? ''),
      path: String(pathEntry['#text'] ?? ''),
      copyFromPath: pathEntry['copyfrom-path'] ? String(pathEntry['copyfrom-path']) : undefined,
      copyFromRevision: pathEntry['copyfrom-rev'] ? Number(pathEntry['copyfrom-rev']) : undefined,
    })),
  }));
}

export function parseListXml(xml: string, baseUrl: string): SvnListEntry[] {
  const root = parser.parse(xml);
  const lists = asArray(root?.lists?.list);
  const entries: SvnListEntry[] = [];
  for (const list of lists) {
    for (const entry of asArray(list?.entry)) {
      const name = String(entry.name ?? '');
      const url = `${baseUrl.replace(/\/+$/, '')}/${name}`;
      entries.push({
        name,
        path: `${String(list.path ?? '').replace(/\/+$/, '')}/${name}`,
        url,
        kind: String(entry.kind ?? 'file') === 'dir' ? 'dir' : 'file',
        size: entry.size ? Number(entry.size) : undefined,
        revision: entry.commit?.revision ? Number(entry.commit.revision) : undefined,
        author: entry.commit?.author ? String(entry.commit.author) : undefined,
        date: entry.commit?.date ? String(entry.commit.date) : undefined,
      });
    }
  }
  return entries;
}

export function parseBlameXml(xml: string): SvnBlameLine[] {
  const root = parser.parse(xml);
  const targets = asArray(root?.blame?.target);
  const lines: SvnBlameLine[] = [];
  for (const target of targets) {
    for (const entry of asArray(target?.entry)) {
      const commit = entry.commit;
      lines.push({
        lineNumber: Number(entry['line-number'] ?? 0),
        author: String(commit?.author ?? 'unknown'),
        revision: Number(commit?.revision ?? 0),
        date: commit?.date ? String(commit.date) : undefined,
      });
    }
  }
  return lines;
}
