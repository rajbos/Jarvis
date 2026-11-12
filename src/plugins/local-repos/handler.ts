// ── Local repos IPC handlers ──────────────────────────────────────────────────
import { shell, dialog, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../../storage/database';
import {
  getScanFolders,
  addScanFolder,
  removeScanFolder,
  listLocalRepos,
  listLocalReposForFolder,
  runLocalDiscovery,
  type ScanProgress,
} from '../../services/local-discovery';
import { getFileIndexState, startFileIndexIfNeeded } from './file-index-runner';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import { openTerminal, resolveDirectory } from '../../services/process-launch';

let localScanRunning = false;
let lastLocalScanProgress: ScanProgress | null = null;

function openTerminalInFolder(folderPath: string): void {
  // Normalize the path and confirm it resolves to an existing directory
  // before handing it to a spawned shell process.
  const resolvedPath = resolveDirectory(folderPath);
  if (!resolvedPath) {
    logger.error('[IPC] local:open-terminal failed: not a directory', folderPath);
    return;
  }
  openTerminal(resolvedPath, undefined, (err) => logger.error('[IPC] local:open-terminal failed:', err));
}

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  safeHandle('local:get-folders', () => {
    return getScanFolders(db);
  });

  safeHandle('local:add-folder', async (_event, folderPath?: string) => {
    let chosenPath = folderPath;
    if (!chosenPath) {
      const win = getWindow();
      const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
        properties: ['openDirectory'],
        title: 'Select a folder to scan for Git repositories',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      chosenPath = result.filePaths[0];
    }
    addScanFolder(db, chosenPath);
    saveDatabase();
    return { ok: true, path: chosenPath };
  });

  safeHandle('local:remove-folder', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return { ok: false, error: 'Invalid folderPath' };
    removeScanFolder(db, folderPath);
    saveDatabase();
    return { ok: true };
  });

  safeHandle('local:get-scan-status', () => {
    return { running: localScanRunning, progress: lastLocalScanProgress };
  });

  safeHandle('local:start-scan', () => {
    startLocalScanIfNeeded(db, getWindow, true);
    return { started: true };
  });

  safeHandle('local:get-index-status', async () => {
    return await getFileIndexState();
  });

  safeHandle('local:start-index', () => {
    const started = startFileIndexIfNeeded(db, getWindow, true);
    return { started };
  });

  safeHandle('local:list-repos', () => {
    return listLocalRepos(db);
  });

  safeHandle('local:list-repos-for-folder', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return [];
    return listLocalReposForFolder(db, folderPath);
  });

  safeHandle('local:open-folder', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return;
    void shell.openPath(folderPath);
  });

  safeHandle('local:open-terminal', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return;
    openTerminalInFolder(folderPath);
  });
}

// ── Local repo scan scheduling ────────────────────────────────────────────────

export function startLocalScanIfNeeded(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  _force = false,
): boolean {
  if (localScanRunning) {
    logger.debug('[LocalScan] Already running, skipping');
    return false;
  }

  const folders = getScanFolders(db);
  if (folders.length === 0) {
    logger.debug('[LocalScan] No scan folders configured, skipping');
    return false;
  }

  logger.info('[LocalScan] Starting scan of', folders.length, 'folder(s)');
  localScanRunning = true;

  runLocalDiscovery(db, (progress) => {
    lastLocalScanProgress = progress;
    getWindow()?.webContents.send('local:scan-progress', progress);
  }).then((done) => {
    localScanRunning = false;
    lastLocalScanProgress = done;
    saveDatabase();
    logger.info('[LocalScan] Finished —', done.reposFound, 'repo(s) found');
    getWindow()?.webContents.send('local:scan-complete', done);
    // Refresh the file content index now that the repo list is current.
    startFileIndexIfNeeded(db, getWindow);
  }).catch((err: unknown) => {
    localScanRunning = false;
    logger.error('[LocalScan] Failed:', err);
  });
  return true;
}
