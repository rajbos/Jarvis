// ── Read-only loader for the local file index (jarvis-index.db) ───────────────
// The Electron app builds this index; the MCP server only reads it. Like the
// main database, it is loaded fresh per call so results reflect the latest
// indexing run, but the parsed database is reused while the file is unchanged
// because the index can be tens of megabytes.

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import { DB_PATH } from './db.js';
import { getIndexDbPath } from '../services/local-file-index.js';

/** Index path resolved once at startup; can be overridden via JARVIS_INDEX_DB. */
export const INDEX_DB_PATH = process.env['JARVIS_INDEX_DB'] ?? getIndexDbPath(DB_PATH);

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let cached: { db: SqlJsDatabase; mtimeMs: number; size: number } | null = null;

async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

/**
 * Return the index database, or null when the app has not built one yet.
 * The returned handle is shared; callers must NOT close it.
 */
export async function openIndexSnapshot(): Promise<SqlJsDatabase | null> {
  if (!fs.existsSync(INDEX_DB_PATH)) return null;
  const stat = fs.statSync(INDEX_DB_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.db;
  const sql = await getSql();
  const db = new sql.Database(fs.readFileSync(INDEX_DB_PATH));
  cached?.db.close();
  cached = { db, mtimeMs: stat.mtimeMs, size: stat.size };
  return db;
}
