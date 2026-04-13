// ── Local repos IPC handlers ──────────────────────────────────────────────────
import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../../storage/database';
import {
  getScanFolders,
  addScanFolder,
  removeScanFolder,
  listLocalRepos,
  listLocalReposForFolder,
  linkLocalRepo,
  runLocalDiscovery,
  type ScanProgress,
} from '../../services/local-discovery';

let localScanRunning = false;
let lastLocalScanProgress: ScanProgress | null = null;

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('local:get-folders', () => {
    try {
      return getScanFolders(db);
    } catch (err) {
      console.error('[IPC] local:get-folders failed:', err);
      return [];
    }
  });

  ipcMain.handle('local:add-folder', async (_event, folderPath?: string) => {
    try {
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
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('local:remove-folder', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return { ok: false, error: 'Invalid folderPath' };
    try {
      removeScanFolder(db, folderPath);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('local:get-scan-status', () => {
    try {
      return { running: localScanRunning, progress: lastLocalScanProgress };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('local:start-scan', () => {
    try {
      startLocalScanIfNeeded(db, getWindow, true);
      return { started: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('local:list-repos', () => {
    try {
      return listLocalRepos(db);
    } catch (err) {
      console.error('[IPC] local:list-repos failed:', err);
      return [];
    }
  });

  ipcMain.handle('local:list-repos-for-folder', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return [];
    try {
      return listLocalReposForFolder(db, folderPath);
    } catch (err) {
      console.error('[IPC] local:list-repos-for-folder failed:', err);
      return [];
    }
  });

  ipcMain.handle('local:link-repo', (_event, localRepoId: number, githubRepoId: number | null) => {
    if (typeof localRepoId !== 'number') return { ok: false, error: 'Invalid localRepoId' };
    if (githubRepoId !== null && typeof githubRepoId !== 'number') return { ok: false, error: 'Invalid githubRepoId' };
    try {
      linkLocalRepo(db, localRepoId, githubRepoId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('local:open-folder', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return;
    void shell.openPath(folderPath);
  });
}

// ── Local repo scan scheduling ────────────────────────────────────────────────

export function startLocalScanIfNeeded(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  force = false,
): void {
  if (localScanRunning && !force) {
    console.log('[LocalScan] Already running, skipping');
    return;
  }

  const folders = getScanFolders(db);
  if (folders.length === 0) {
    console.log('[LocalScan] No scan folders configured, skipping');
    return;
  }

  console.log('[LocalScan] Starting scan of', folders.length, 'folder(s)');
  localScanRunning = true;

  runLocalDiscovery(db, (progress) => {
    lastLocalScanProgress = progress;
    getWindow()?.webContents.send('local:scan-progress', progress);
  }).then((done) => {
    localScanRunning = false;
    lastLocalScanProgress = done;
    saveDatabase();
    console.log('[LocalScan] Finished —', done.reposFound, 'repo(s) found');
    getWindow()?.webContents.send('local:scan-complete', done);
  }).catch((err: unknown) => {
    localScanRunning = false;
    console.error('[LocalScan] Failed:', err);
  });
}

const LOCAL_SCAN_INITIAL_DELAY_MS = 30_000;       // 30 seconds after boot
const LOCAL_SCAN_INTERVAL_MS = 60 * 60 * 1_000;  // 1 hour

/**
 * Schedule the periodic local-repo scan.
 * First run is delayed to avoid blocking startup; subsequent runs are hourly.
 */
export function scheduleLocalDiscovery(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): void {
  setTimeout(() => {
    startLocalScanIfNeeded(db, getWindow);
    setInterval(() => {
      startLocalScanIfNeeded(db, getWindow);
    }, LOCAL_SCAN_INTERVAL_MS);
  }, LOCAL_SCAN_INITIAL_DELAY_MS);
}
