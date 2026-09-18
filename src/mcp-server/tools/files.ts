// ── Local file index tools for the Jarvis MCP server ──────────────────────────
// Thin wrappers over the shared index service so the server can search inside
// local repo files. Read-only; the Electron app owns index building.
import type { Database as SqlJsDatabase } from 'sql.js';
import {
  getIndexStatus,
  searchIndexedFiles,
  type FileKind,
  type FileSearchHit,
  type IndexStatus,
} from '../../services/local-file-index.js';

export type { FileKind, FileSearchHit, IndexStatus };

export interface FileSearchResult {
  query: string;
  indexAvailable: boolean;
  lastIndexedAt: string | null;
  hits: FileSearchHit[];
}

/** Search file paths and contents across all indexed local repos. */
export function searchLocalFiles(
  indexDb: SqlJsDatabase | null,
  query: string,
  opts: { repoPath?: string; kind?: FileKind; limit?: number } = {},
): FileSearchResult {
  if (!indexDb) return { query, indexAvailable: false, lastIndexedAt: null, hits: [] };
  const status = getIndexStatus(indexDb);
  return {
    query,
    indexAvailable: true,
    lastIndexedAt: status.lastRunAt,
    hits: searchIndexedFiles(indexDb, query, opts),
  };
}

/** Summary of what the index currently covers. */
export function describeIndex(indexDb: SqlJsDatabase | null): IndexStatus | null {
  return indexDb ? getIndexStatus(indexDb) : null;
}
