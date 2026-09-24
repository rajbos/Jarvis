// ── Local file index runner ───────────────────────────────────────────────────
// Orchestrates building jarvis-index.db from the local repos in the main
// database. Runs in the Electron main process after each local repo scan and
// on demand; emits progress to the renderer. Kept separate from the IPC
// handler so it can be tested without Electron.

import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { getDatabasePath } from '../../storage/database';
import { listLocalRepos } from '../../services/local-discovery';
import {
  getIndexDbPath,
  getIndexStatus,
  indexRepos,
  openIndexDatabase,
  saveIndexDatabase,
  type IndexProgress,
  type IndexStatus,
} from '../../services/local-file-index';
import { logger } from '../../services/logger';

/** Persist after this many repos so a crash mid-run keeps most of the work. */
const SAVE_EVERY_REPOS = 10;

let indexRunning = false;
let lastIndexProgress: IndexProgress | null = null;
let lastError: string | null = null;

export interface FileIndexState {
  running: boolean;
  progress: IndexProgress | null;
  error: string | null;
  indexPath: string | null;
  status: IndexStatus | null;
}

/** Resolve where the index file lives; `null` before the main DB is open. */
export function resolveIndexPath(): string | null {
  const dbPath = getDatabasePath();
  return dbPath ? getIndexDbPath(dbPath) : null;
}

/** Current runner state plus a summary read from the index file (if present). */
export async function getFileIndexState(): Promise<FileIndexState> {
  const indexPath = resolveIndexPath();
  let status: IndexStatus | null = null;
  if (indexPath && !indexRunning) {
    try {
      const idx = await openIndexDatabase(indexPath);
      try {
        status = getIndexStatus(idx);
      } finally {
        idx.close();
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { running: indexRunning, progress: lastIndexProgress, error: lastError, indexPath, status };
}

/**
 * Start indexing all known local repos unless a run is already in progress.
 * Returns true when a run was started.
 */
export function startFileIndexIfNeeded(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  force = false,
): boolean {
  if (indexRunning && !force) {
    logger.debug('[FileIndex] Already running, skipping');
    return false;
  }
  const indexPath = resolveIndexPath();
  if (!indexPath) {
    logger.debug('[FileIndex] Main database path unknown, skipping');
    return false;
  }
  const repos = listLocalRepos(db).map((r) => ({ localPath: r.localPath, name: r.name }));
  if (repos.length === 0) {
    logger.debug('[FileIndex] No local repos discovered yet, skipping');
    return false;
  }

  indexRunning = true;
  lastError = null;
  logger.info('[FileIndex] Indexing', repos.length, 'local repo(s) →', indexPath);

  void runFileIndex(indexPath, repos, getWindow)
    .then((done) => {
      logger.info('[FileIndex] Finished —', done.filesIndexed, 'file(s) (re)indexed across', done.reposDone, 'repo(s)');
    })
    .catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error('[FileIndex] Failed:', err);
    })
    .finally(() => {
      indexRunning = false;
    });
  return true;
}

async function runFileIndex(
  indexPath: string,
  repos: Array<{ localPath: string; name: string | null }>,
  getWindow: () => BrowserWindow | null,
): Promise<IndexProgress> {
  const idx = await openIndexDatabase(indexPath);
  try {
    const done = await indexRepos(idx, repos, {
      onProgress: (progress) => {
        lastIndexProgress = progress;
        getWindow()?.webContents.send('local:index-progress', progress);
      },
      onRepoDone: (_repo, i) => {
        if ((i + 1) % SAVE_EVERY_REPOS === 0) saveIndexDatabase(idx, indexPath);
      },
    });
    saveIndexDatabase(idx, indexPath);
    lastIndexProgress = done;
    getWindow()?.webContents.send('local:index-complete', done);
    return done;
  } finally {
    idx.close();
  }
}

/** Test hook: reset module state between runs. */
export function _resetFileIndexStateForTests(): void {
  indexRunning = false;
  lastIndexProgress = null;
  lastError = null;
}
