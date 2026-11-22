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
import { findPruneCandidates, pruneBranches, type PruneDeps } from '../../services/branch-prune';
import { fetchPullRequests, prLookupKey, type PrLookup, type PrLookupResult } from '../../services/pr-readiness';
import { accessForRepo, ghCliFallbacks } from '../../services/github-repo-access';
import { DEFAULT_HOST } from '../../services/github-host';
import { resolveGitContext } from '../../services/git-context';
import {
  discoverClaudeLocalSessions,
  discoverCopilotLocalSessions,
  type CopilotLocalDiscovery,
  type LocalSessionDiscoveryOptions,
} from '../../services/local-agent-sessions';
import path from 'node:path';
import type { ActiveAgentSession, PruneRequestItem } from '../types';

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

/**
 * Branches and folders that agent sessions use right now; throws when sessions
 * cannot be listed. Exported for tests.
 */
export async function activeSessionUse(
  options: LocalSessionDiscoveryOptions = {},
): Promise<{ branches: Set<string>; paths: string[] }> {
  // Strict: an unreadable session store must stop pruning, not look like "no sessions".
  const discovery = { ...options, strict: true };
  let copilot: CopilotLocalDiscovery;
  let claude: ActiveAgentSession[];
  try {
    [copilot, claude] = await Promise.all([discoverCopilotLocalSessions(discovery), discoverClaudeLocalSessions(discovery)]);
  } catch (err) {
    logger.warn('[LocalRepos] Could not list agent sessions; refusing to prune:', err);
    throw new Error('Could not verify which branches running agent sessions use, so nothing was pruned. Try again.', { cause: err });
  }
  const branches = new Set<string>();
  const paths: string[] = [];
  for (const session of [...copilot.sessions, ...claude]) {
    if (session.branch) branches.add(session.branch);
    if (session.cwd) {
      paths.push(session.cwd);
      const branch = resolveGitContext(session.cwd)?.branch;
      if (branch) branches.add(branch);
    }
  }
  return { branches, paths };
}

function pruneDeps(db: SqlJsDatabase): PruneDeps {
  return {
    activeUse: activeSessionUse,
    fetchPrs: async (lookups: PrLookup[]) => {
      const results = new Map<string, PrLookupResult>();
      const byRepo = new Map<string, PrLookup[]>();
      for (const l of lookups) {
        if (l.kind !== 'branch') continue;
        byRepo.set(l.repoFullName, [...(byRepo.get(l.repoFullName) ?? []), l]);
      }
      let any = false;
      for (const [repo, group] of byRepo) {
        const access = await accessForRepo(db, repo, DEFAULT_HOST);
        if (!access) continue;
        any = true;
        const got = await fetchPullRequests(access.token, group);
        const failed = group.filter((l) => !got.get(prLookupKey(l))?.ok);
        if (failed.length > 0) {
          // The account may not be SSO-authorized for the org: retry with the GitHub CLI's logins.
          for (const fb of await ghCliFallbacks(access, DEFAULT_HOST)) {
            const retry = await fetchPullRequests(fb.token, failed);
            for (const [k, v] of retry) if (v.ok) got.set(k, v);
          }
        }
        for (const [k, v] of got) results.set(k, v);
      }
      return any ? results : null;
    },
  };
}

/** Only repos Jarvis discovered may be pruned — the renderer cannot point this at an arbitrary folder. */
function isKnownRepo(db: SqlJsDatabase, repoPath: string): boolean {
  const wanted = path.resolve(repoPath).toLowerCase();
  return listLocalRepos(db).some((r) => path.resolve(r.localPath).toLowerCase() === wanted);
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

  safeHandle('local:get-prune-candidates', async (_event, repoPath: string) => {
    if (typeof repoPath !== 'string' || repoPath.length === 0) return { ok: false, error: 'Invalid repoPath' };
    if (!isKnownRepo(db, repoPath)) return { ok: false, error: 'Not a known local repository' };
    return await findPruneCandidates(repoPath, pruneDeps(db));
  });

  safeHandle('local:prune', async (_event, repoPath: string, items: PruneRequestItem[]) => {
    if (typeof repoPath !== 'string' || repoPath.length === 0) return { ok: false, error: 'Invalid repoPath' };
    if (!Array.isArray(items) || items.length === 0 || items.length > 500) return { ok: false, error: 'Invalid items' };
    const valid = items.every((i) => i && typeof i.branch === 'string' && i.branch.length > 0 && typeof i.sha === 'string' && /^[0-9a-f]{40,64}$/.test(i.sha));
    if (!valid) return { ok: false, error: 'Invalid items' };
    if (!isKnownRepo(db, repoPath)) return { ok: false, error: 'Not a known local repository' };
    const results = await pruneBranches(repoPath, items.map((i) => ({ branch: i.branch, sha: i.sha })), pruneDeps(db));
    return { results };
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
