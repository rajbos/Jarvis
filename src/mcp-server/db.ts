// ── Read-only database loader for the MCP server ──────────────────────────────
// Opens the Jarvis SQLite database as a snapshot (no migrations, no saves,
// no backup rotation). Every call checks the file's mtime/size, so tool results
// always reflect the latest state written by the Electron app, but the parsed
// database is reused while the file is unchanged (it can hold large cached
// OneNote pages and workflow log excerpts).

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

function getDefaultDbPath(): string {
  const appData =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
  return path.join(appData, 'Jarvis', 'jarvis.db');
}

/** DB path resolved once at startup; can be overridden via JARVIS_DB env var. */
export const DB_PATH = process.env['JARVIS_DB'] ?? getDefaultDbPath();

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let cached: { db: SqlJsDatabase; mtimeMs: number; size: number } | null = null;

async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

/**
 * Return a read-only snapshot of the Jarvis database, re-reading and re-parsing
 * the file only when its mtime or size changed since the last load.
 * Call this at the start of every tool handler to get up-to-date data.
 * The returned handle is shared; callers must NOT close it.
 */
export async function openSnapshot(): Promise<SqlJsDatabase> {
  const sql = await getSql();
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Jarvis database not found at: ${DB_PATH}
Is Jarvis installed and has it been started at least once?`);
  }
  const stat = fs.statSync(DB_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.db;
  const db = new sql.Database(fs.readFileSync(DB_PATH));
  cached?.db.close();
  cached = { db, mtimeMs: stat.mtimeMs, size: stat.size };
  return db;
}
