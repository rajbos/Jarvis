// ── Discovery IPC handlers + startDiscoveryIfAuthed ──────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import {
  runDiscovery,
  runLightweightRefresh,
  runPatDiscovery,
  fetchStarredRepos,
  getLastOrgIndexedAt,
  listOrgs,
  type DiscoveryState,
  type DiscoveryProgress,
} from '../../services/github-discovery';
import { loadGitHubAuth, loadGitHubPat } from '../../services/github-oauth';
import { getConfigValue, setConfigValue, saveDatabase } from '../../storage/database';
import {
  activeDiscovery,
  lastDiscoveryProgress,
  setActiveDiscovery,
  setLastDiscoveryProgress,
} from './state';

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:discovery-status', () => {
    if (lastDiscoveryProgress) {
      return {
        running: activeDiscovery !== null && !activeDiscovery.aborted,
        progress: lastDiscoveryProgress,
        rateLimit: activeDiscovery?.lastRateLimit ?? null,
      };
    }

    const { orgs, directRepoCount } = listOrgs(db);
    const totalRepos = orgs.reduce((sum, o) => sum + o.repoCount, 0) + directRepoCount;
    return {
      running: activeDiscovery !== null && !activeDiscovery.aborted,
      progress: orgs.length > 0 || directRepoCount > 0
        ? { phase: 'done' as const, orgsFound: orgs.length, reposFound: totalRepos }
        : null,
      rateLimit: null,
    };
  });

  ipcMain.handle('github:start-discovery', () => {
    startDiscoveryIfAuthed(db, getWindow, true);
    return { started: true };
  });

  ipcMain.handle('github:start-pat-discovery', () => {
    const pat = loadGitHubPat(db);
    if (!pat) return { error: 'No PAT configured' };

    const auth = loadGitHubAuth(db);
    runPatDiscovery(db, pat, undefined, undefined, (progress) => {
      setLastDiscoveryProgress(progress);
      getWindow()?.webContents.send('github:discovery-progress', progress);
    }, auth?.login).then(() => {
      const doneProgress: DiscoveryProgress = {
        phase: 'done',
        orgsFound: lastDiscoveryProgress?.orgsFound ?? 0,
        reposFound: lastDiscoveryProgress?.reposFound ?? 0,
      };
      setLastDiscoveryProgress(doneProgress);
      getWindow()?.webContents.send('github:discovery-progress', doneProgress);
      getWindow()?.webContents.send('github:discovery-complete', doneProgress);
      console.log('[Discovery] PAT-only discovery finished');
    }).catch((err) => {
      console.error('[Discovery] PAT-only discovery failed:', err);
    });
    return { started: true };
  });
}

export function startDiscoveryIfAuthed(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  force = false,
): void {
  const auth = loadGitHubAuth(db);
  if (!auth) return;

  const sendStatus = (msg: string) => getWindow()?.webContents.send('app:background-status', msg);

  if (activeDiscovery && !activeDiscovery.aborted) {
    console.log('[Discovery] Already running, skipping');
    return;
  }

  const forceOAuthFlag = getConfigValue(db, 'force_oauth_discovery') === '1';
  const forcePatFlag = getConfigValue(db, 'force_pat_discovery') === '1';

  if (forceOAuthFlag) {
    console.log('[Discovery] force_oauth_discovery flag is set — running full discovery');
    force = true;
    setConfigValue(db, 'force_oauth_discovery', '0');
    saveDatabase();
  }

  if (!force && forcePatFlag) {
    const pat = loadGitHubPat(db);
    if (pat) {
      console.log('[Discovery] force_pat_discovery flag is set — running PAT-only discovery');
      setConfigValue(db, 'force_pat_discovery', '0');
      saveDatabase();

      runPatDiscovery(db, pat, undefined, undefined, (progress) => {
        setLastDiscoveryProgress(progress);
        getWindow()?.webContents.send('github:discovery-progress', progress);
      }, auth.login).then(() => {
        const doneProgress: DiscoveryProgress = {
          phase: 'done',
          orgsFound: lastDiscoveryProgress?.orgsFound ?? 0,
          reposFound: lastDiscoveryProgress?.reposFound ?? 0,
        };
        setLastDiscoveryProgress(doneProgress);
        getWindow()?.webContents.send('github:discovery-progress', doneProgress);
        getWindow()?.webContents.send('github:discovery-complete', doneProgress);
        console.log('[Discovery] PAT-only discovery finished');
      }).catch((err) => {
        console.error('[Discovery] PAT-only discovery failed:', err);
      });
      return;
    } else {
      setConfigValue(db, 'force_pat_discovery', '0');
      saveDatabase();
    }
  }

  if (force && forcePatFlag) {
    setConfigValue(db, 'force_pat_discovery', '0');
    saveDatabase();
  }

  if (!force) {
    const existing = listOrgs(db);
    if (existing.orgs.length > 0) {
      const lastIndexed = getLastOrgIndexedAt(db);
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const isStale = !lastIndexed || (Date.now() - new Date(lastIndexed + 'Z').getTime()) > ONE_HOUR_MS;

      if (isStale) {
        console.log('[Discovery] Data is stale, running lightweight refresh');
        sendStatus('Syncing repos\u2026');
        const pat = loadGitHubPat(db);
        runLightweightRefresh(db, auth.accessToken, (progress) => {
          setLastDiscoveryProgress(progress);
          getWindow()?.webContents.send('github:discovery-progress', progress);
        }, pat, auth.login).then(() => {
          console.log('[Discovery] Lightweight refresh finished');
          sendStatus('Repos synced.');
          getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
        }).catch((err) => {
          console.error('[Discovery] Lightweight refresh failed:', err);
        });
      } else {
        console.log(`[Discovery] Already have ${existing.orgs.length} org(s) in DB and data is fresh, skipping.`);

        if (existing.starredRepoCount === 0) {
          console.log('[Discovery] No starred repos indexed yet - fetching stars now');
          sendStatus('Fetching starred repos\u2026');
          const starState: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };
          const starProgress: DiscoveryProgress = { phase: 'starred', orgsFound: 0, reposFound: 0 };
          fetchStarredRepos(db, auth.accessToken, starState, starProgress, (p) => {
            setLastDiscoveryProgress(p);
            getWindow()?.webContents.send('github:discovery-progress', p);
          }).then(() => {
            const done: DiscoveryProgress = { phase: 'done', orgsFound: 0, reposFound: starProgress.reposFound };
            setLastDiscoveryProgress(done);
            sendStatus(starProgress.reposFound + ' starred repo' + (starProgress.reposFound !== 1 ? 's' : '') + ' loaded.');
            getWindow()?.webContents.send('github:discovery-complete', done);
          }).catch((err) => console.error('[Discovery] Starred-only fetch failed:', err));
        }
      }
      return;
    }
  }

  console.log('[Discovery] Starting background discovery for', auth.login);
  sendStatus('Discovering repos\u2026');
  const pat = loadGitHubPat(db);
  runDiscovery(db, auth.accessToken, (progress) => {
    setLastDiscoveryProgress(progress);
    getWindow()?.webContents.send('github:discovery-progress', progress);
  }, pat, auth.login).then((_state) => {
    setActiveDiscovery(null);
    console.log('[Discovery] Finished');
    sendStatus('Discovery finished — ' + (lastDiscoveryProgress?.reposFound ?? 0) + ' repos found.');
    getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
  }).catch((err) => {
    setActiveDiscovery(null);
    console.error('[Discovery] Failed:', err);
  });
}
