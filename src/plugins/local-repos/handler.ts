// ── Local repos IPC handlers ──────────────────────────────────────────────────
import { spawn } from 'node:child_process';
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

function launchDetached(command: string, args: string[], folderPath: string, onError: (error: unknown) => void): void {
  try {
    const child = spawn(command, args, {
      cwd: folderPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('spawn', () => {
      child.unref();
    });
    child.once('error', onError);
  } catch (err) {
    onError(err);
  }
}

function openTerminal(folderPath: string): void {
  // Prefer Windows Terminal when available, but keep working on machines that
  // only have the classic command prompt.
  launchDetached('wt.exe', ['-d', folderPath], folderPath, () => {
    const commandShell = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    launchDetached(commandShell, ['/k'], folderPath, (err) => {
      console.error('[IPC] local:open-terminal failed:', err);
    });
  });
}

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

  ipcMain.handle('local:open-terminal', (_event, folderPath: string) => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) return;
    openTerminal(folderPath);
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
