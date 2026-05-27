// ── Read-only database loader for the MCP server ──────────────────────────────
// Opens the Jarvis SQLite database as a snapshot (no migrations, no saves,
// no backup rotation). The snapshot is loaded fresh on every call so tool
// results always reflect the latest state written by the Electron app.

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

async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

/**
 * Load a fresh read-only snapshot of the Jarvis database.
 * Call this at the start of every tool handler to get up-to-date data.
 * The caller is responsible for calling `db.close()` after use.
 */
export async function openSnapshot(): Promise<SqlJsDatabase> {
  const sql = await getSql();
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Jarvis database not found at: ${DB_PATH}\nIs Jarvis installed and has it been started at least once?`);
  }
  const buf = fs.readFileSync(DB_PATH);
  return new sql.Database(buf);
}
