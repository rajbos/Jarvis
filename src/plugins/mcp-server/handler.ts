// ── MCP server IPC handlers ───────────────────────────────────────────────────
// Tells the Settings window how other MCP clients can launch the Jarvis MCP
// server (dist/mcp-server/index.js) against this app's database and index.
// The app never runs the server itself; MCP clients spawn it on demand.
import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDatabasePath } from '../../storage/database';
import { getIndexDbPath } from '../../services/local-file-index';
import { buildMcpClientSnippets, buildServerEnv, type McpClientSnippets, type McpServerLaunch } from '../../services/mcp-config';

export interface McpClientConfig extends McpClientSnippets {
  packaged: boolean;
  /** Whether the server script exists on disk (false until `npm run build` in dev). */
  serverScriptExists: boolean;
  dbPath: string | null;
  indexPath: string | null;
  /** True when jarvis-index.db exists, i.e. file search will work. */
  indexExists: boolean;
}

/** Locate dist/mcp-server/index.js for this run (repo checkout or installed app). */
export function resolveServerScriptPath(): string {
  const scriptPath = path.join(app.getAppPath(), 'dist', 'mcp-server', 'index.js');
  // Inside an installed build the app lives in app.asar; the server is unpacked next to it
  // (see asarUnpack in electron-builder.yml) so a plain Node runtime can execute it.
  return scriptPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

export function describeLaunch(): McpServerLaunch & { dbPath: string | null; indexPath: string | null } {
  const dbPath = getDatabasePath();
  const indexPath = dbPath ? getIndexDbPath(dbPath) : null;
  const packaged = app.isPackaged;
  const env = dbPath && indexPath ? buildServerEnv({ dbPath, indexPath, packaged }) : (packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {});
  return {
    command: packaged ? process.execPath : 'node',
    serverScriptPath: resolveServerScriptPath(),
    env,
    dbPath,
    indexPath,
  };
}

export function getMcpClientConfig(): McpClientConfig {
  const launch = describeLaunch();
  const snippets = buildMcpClientSnippets(launch);
  return {
    ...snippets,
    packaged: app.isPackaged,
    serverScriptExists: fs.existsSync(launch.serverScriptPath),
    dbPath: launch.dbPath,
    indexPath: launch.indexPath,
    indexExists: launch.indexPath ? fs.existsSync(launch.indexPath) : false,
  };
}

export function registerHandlers(_db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('mcp:get-client-config', () => {
    try {
      return getMcpClientConfig();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
