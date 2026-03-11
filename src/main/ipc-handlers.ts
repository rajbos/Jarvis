import { ipcMain, shell, Notification, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { loadConfig } from '../agent/config';
import { getOnboardingStatus, completeOnboardingStep } from '../agent/onboarding';
import { saveDatabase, getConfigValue, setConfigValue } from '../storage/database';
import {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  saveGitHubAuth,
  loadGitHubAuth,
  saveGitHubPat,
  loadGitHubPat,
  deleteGitHubPat,
  deleteGitHubAuth,
} from '../services/github-oauth';
import {
  runDiscovery,
  runLightweightRefresh,
  runPatDiscovery,
  fetchStarredRepos,
  getLastOrgIndexedAt,
  abortDiscovery,
  listOrgs,
  setOrgDiscoveryEnabled,
  type DiscoveryState,
  type DiscoveryProgress,
} from '../services/github-discovery';
import { checkOllama } from '../services/ollama';

let activeDeviceFlow: {
  deviceCode: string;
  clientId: string;
  intervalMs: number;
  aborted: boolean;
} | null = null;

let activeDiscovery: DiscoveryState | null = null;
let lastDiscoveryProgress: DiscoveryProgress | null = null;

export function registerIpcHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('onboarding:status', () => {
    return getOnboardingStatus(db);
  });

  ipcMain.handle('ollama:status', async () => {
    return checkOllama();
  });

  ipcMain.handle('ollama:list-models', async () => {
    const result = await checkOllama();
    return { available: result.available, models: result.models, error: result.error };
  });

  ipcMain.handle('github:oauth-status', async () => {
    console.log('[IPC] github:oauth-status called');
    const auth = loadGitHubAuth(db);
    if (auth) {
      console.log('[IPC] Found existing auth for:', auth.login);
      let avatarUrl = auth.avatarUrl;

      // Backfill avatar_url if it was never stored (pre-migration rows)
      if (!avatarUrl) {
        try {
          const user = await fetchGitHubUser(auth.accessToken);
          if (user.avatar_url) {
            avatarUrl = user.avatar_url;
            saveGitHubAuth(db, auth.login, auth.accessToken, auth.scopes, avatarUrl);
            saveDatabase();
          }
        } catch (e) {
          console.warn('[IPC] Could not backfill avatar_url:', e);
        }
      }

      return { authenticated: true, login: auth.login, scopes: auth.scopes, avatarUrl };
    }
    console.log('[IPC] No existing GitHub auth found');
    return { authenticated: false };
  });

  ipcMain.handle('github:discovery-status', () => {
    // If discovery ran this session, return live progress
    if (lastDiscoveryProgress) {
      return {
        running: activeDiscovery !== null && !activeDiscovery.aborted,
        progress: lastDiscoveryProgress,
        rateLimit: activeDiscovery?.lastRateLimit ?? null,
      };
    }

    // Otherwise, build progress from stored DB data
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

    runPatDiscovery(db, pat, undefined, undefined, (progress) => {
      lastDiscoveryProgress = progress;
      getWindow()?.webContents.send('github:discovery-progress', progress);
    }).then(() => {
      const doneProgress: DiscoveryProgress = {
        phase: 'done',
        orgsFound: lastDiscoveryProgress?.orgsFound ?? 0,
        reposFound: lastDiscoveryProgress?.reposFound ?? 0,
      };
      lastDiscoveryProgress = doneProgress;
      getWindow()?.webContents.send('github:discovery-progress', doneProgress);
      getWindow()?.webContents.send('github:discovery-complete', doneProgress);
      console.log('[Discovery] PAT-only discovery finished');
    }).catch((err) => {
      console.error('[Discovery] PAT-only discovery failed:', err);
    });
    return { started: true };
  });

  ipcMain.handle('github:list-orgs', () => {
    return listOrgs(db);
  });

  ipcMain.handle('github:set-org-enabled', (_event, orgLogin: string, enabled: boolean) => {
    setOrgDiscoveryEnabled(db, orgLogin, enabled);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:save-pat', async (_event, pat: string) => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated' };
    // Validate the PAT by calling /user
    try {
      const user = await fetchGitHubUser(pat);
      if (user.login.toLowerCase() !== auth.login.toLowerCase()) {
        return { error: `PAT belongs to ${user.login}, but you are signed in as ${auth.login}` };
      }
    } catch {
      return { error: 'Invalid token — could not authenticate with GitHub' };
    }
    saveGitHubPat(db, auth.login, pat);
    // A new PAT means we should re-discover to pick up repos it can see
    setConfigValue(db, 'force_pat_discovery', '1');
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:delete-pat', () => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { ok: false };
    deleteGitHubPat(db, auth.login);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:logout', () => {
    deleteGitHubAuth(db);
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('github:start-oauth-discovery', () => {
    setConfigValue(db, 'force_oauth_discovery', '1');
    saveDatabase();
    startDiscoveryIfAuthed(db, getWindow);
    return { ok: true };
  });

  ipcMain.handle('github:pat-status', async () => {
    const pat = loadGitHubPat(db);
    if (!pat) return { hasPat: false };
    try {
      const user = await fetchGitHubUser(pat);
      return { hasPat: true, login: user.login, name: user.name, avatarUrl: user.avatar_url };
    } catch {
      return { hasPat: true };
    }
  });

  ipcMain.handle('github:open-url', (_event, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('github:search-repos', (_event, query: string) => {
    if (!query || query.trim().length < 2) return [];

    // Split into individual words so "myorg reponame" matches across org and repo name
    const words = query.trim().split(/\s+/).filter((w) => w.length > 0);
    const bindParams: string[] = [];

    // Each word must appear in full_name OR name (AND between words = narrowing)
    const conditions = words.map((w) => {
      bindParams.push(`%${w}%`, `%${w}%`);
      return `(r.full_name LIKE ? OR r.name LIKE ?)`;
    }).join(' AND ');

    // For ordering: repos whose name matches the first word rank higher
    const firstPattern = `%${words[0]}%`;
    bindParams.push(firstPattern);

    const sql = `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived
       FROM github_repos r
       LEFT JOIN github_orgs o ON o.id = r.org_id
       WHERE (${conditions})
         AND (r.org_id IS NULL OR o.discovery_enabled = 1)
       ORDER BY
         CASE WHEN r.name LIKE ? THEN 0 ELSE 1 END,
         r.last_pushed_at DESC
       LIMIT 50`;

    const stmt = db.prepare(sql);
    const rows: { full_name: string; name: string; description: string | null; language: string | null; private: number; fork: number; archived: number }[] = [];
    stmt.bind(bindParams);
    while (stmt.step()) rows.push(stmt.getAsObject() as typeof rows[0]);
    stmt.free();
    return rows;
  });

  ipcMain.handle('github:list-repos-for-org', (_event, orgLogin: string | null) => {
    let stmt;
    if (orgLogin === null) {
      // Direct repos (personal + collaborator)
      stmt = db.prepare(
        `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived,
                r.default_branch, r.parent_full_name, r.last_pushed_at, r.last_updated_at
         FROM github_repos r
         WHERE r.org_id IS NULL
         ORDER BY r.last_pushed_at DESC`,
      );
      stmt.bind([]);
    } else {
      stmt = db.prepare(
        `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived,
                r.default_branch, r.parent_full_name, r.last_pushed_at, r.last_updated_at
         FROM github_repos r
         JOIN github_orgs o ON o.id = r.org_id
         WHERE o.login = ?
         ORDER BY r.last_pushed_at DESC`,
      );
      stmt.bind([orgLogin]);
    }
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  });

  ipcMain.handle('github:list-starred', () => {
    const stmt = db.prepare(
      `SELECT full_name, name, description, language, private, fork, archived,
              default_branch, parent_full_name, last_pushed_at
       FROM github_repos
       WHERE starred = 1
       ORDER BY last_pushed_at DESC`,
    );
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  });

  ipcMain.handle('github:start-oauth', async () => {
    console.log('[IPC] github:start-oauth called');

    // Abort any existing flow
    if (activeDeviceFlow) {
      activeDeviceFlow.aborted = true;
      activeDeviceFlow = null;
    }

    const config = loadConfig();
    const clientId = config.github.oauthClientId;
    console.log('[IPC] Client ID:', clientId ? `${clientId.substring(0, 8)}...` : 'NOT SET');

    if (!clientId) {
      return { error: 'GitHub OAuth Client ID is not configured. Set it in config.json.' };
    }

    try {
      console.log('[IPC] Requesting device code from GitHub...');
      const deviceCode = await requestDeviceCode(clientId, config.github.scopes);
      console.log('[IPC] Got device code, user_code:', deviceCode.user_code);

      const flow = {
        deviceCode: deviceCode.device_code,
        clientId,
        intervalMs: deviceCode.interval * 1000,
        aborted: false,
      };
      activeDeviceFlow = flow;

      // Open the verification URL in the default browser
      shell.openExternal(deviceCode.verification_uri);

      // Kick off polling in the background — main process owns the timing
      startPollingLoop(flow, db, getWindow);

      return {
        status: 'pending',
        userCode: deviceCode.user_code,
        verificationUri: deviceCode.verification_uri,
        expiresIn: deviceCode.expires_in,
      };
    } catch (err) {
      return { error: String(err) };
    }
  });
}

async function startPollingLoop(
  flow: { deviceCode: string; clientId: string; intervalMs: number; aborted: boolean },
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000; // 15-minute max

  while (!flow.aborted && Date.now() < deadline) {
    await sleep(flow.intervalMs);

    if (flow.aborted) break;

    try {
      const result = await pollForToken(flow.clientId, flow.deviceCode, flow);
      console.log('[Poll] pollForToken result:', result ? 'got token' : 'still pending');

      if (!result) continue;

      // Got a token — save it and notify
      activeDeviceFlow = null;
      const user = await fetchGitHubUser(result.access_token);
      console.log('[Poll] GitHub user:', user.login);

      saveGitHubAuth(db, user.login, result.access_token, result.scope, user.avatar_url);
      completeOnboardingStep(db, 'github_oauth');
      saveDatabase();
      console.log('[Poll] Auth saved, pushing oauth-complete to renderer');

      // Kick off background discovery now that we have auth
      startDiscoveryIfAuthed(db, getWindow, true);

      new Notification({
        title: 'Jarvis',
        body: `Signed in as ${user.login}. GitHub connection ready!`,
      }).show();

      getWindow()?.webContents.send('github:oauth-complete', {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
      });
      return;
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('slow_down')) {
        // slow_down is now handled inside pollForToken by adjusting flow.intervalMs
        continue;
      }
      console.error('[Poll] Fatal error, aborting:', msg);
      activeDeviceFlow = null;
      getWindow()?.webContents.send('github:oauth-complete', { error: msg });
      return;
    }
  }

  if (!flow.aborted) {
    console.log('[Poll] Device flow timed out');
    activeDeviceFlow = null;
    getWindow()?.webContents.send('github:oauth-complete', { error: 'Authorization timed out. Please try again.' });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startDiscoveryIfAuthed(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  force = false,
): void {
  const auth = loadGitHubAuth(db);
  if (!auth) return;

  if (activeDiscovery && !activeDiscovery.aborted) {
    console.log('[Discovery] Already running, skipping');
    return;
  }

  // Check config flags for forced re-runs
  const forceOAuthFlag = getConfigValue(db, 'force_oauth_discovery') === '1';
  const forcePatFlag = getConfigValue(db, 'force_pat_discovery') === '1';

  if (forceOAuthFlag) {
    console.log('[Discovery] force_oauth_discovery flag is set — running full discovery');
    force = true;
    setConfigValue(db, 'force_oauth_discovery', '0');
    saveDatabase();
  }

  // If only the PAT flag is set (no full re-run needed), run just the PAT pass
  if (!force && forcePatFlag) {
    const pat = loadGitHubPat(db);
    if (pat) {
      console.log('[Discovery] force_pat_discovery flag is set — running PAT-only discovery');
      setConfigValue(db, 'force_pat_discovery', '0');
      saveDatabase();

      runPatDiscovery(db, pat, undefined, undefined, (progress) => {
        lastDiscoveryProgress = progress;
        getWindow()?.webContents.send('github:discovery-progress', progress);
      }).then(() => {
        // Emit done after PAT-only pass
        const doneProgress: DiscoveryProgress = {
          phase: 'done',
          orgsFound: lastDiscoveryProgress?.orgsFound ?? 0,
          reposFound: lastDiscoveryProgress?.reposFound ?? 0,
        };
        lastDiscoveryProgress = doneProgress;
        getWindow()?.webContents.send('github:discovery-progress', doneProgress);
        getWindow()?.webContents.send('github:discovery-complete', doneProgress);
        console.log('[Discovery] PAT-only discovery finished');
      }).catch((err) => {
        console.error('[Discovery] PAT-only discovery failed:', err);
      });
      return;
    } else {
      // No PAT configured, just clear the flag
      setConfigValue(db, 'force_pat_discovery', '0');
      saveDatabase();
    }
  }

  // Clear PAT flag if doing a full run (full run includes PAT pass)
  if (force && forcePatFlag) {
    setConfigValue(db, 'force_pat_discovery', '0');
    saveDatabase();
  }

  // Skip automatic discovery if orgs already exist (data was persisted from a previous run)
  if (!force) {
    const existing = listOrgs(db);
    if (existing.orgs.length > 0) {
      // Check if data is stale (> 1 hour old) — run lightweight refresh if so
      const lastIndexed = getLastOrgIndexedAt(db);
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const isStale = !lastIndexed || (Date.now() - new Date(lastIndexed + 'Z').getTime()) > ONE_HOUR_MS;

      if (isStale) {
        console.log('[Discovery] Data is stale, running lightweight refresh (orgs + collaborator repos)');
        const pat = loadGitHubPat(db);
        runLightweightRefresh(db, auth.accessToken, (progress) => {
          lastDiscoveryProgress = progress;
          getWindow()?.webContents.send('github:discovery-progress', progress);
        }, pat).then(() => {
          console.log('[Discovery] Lightweight refresh finished');
          getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
        }).catch((err) => {
          console.error('[Discovery] Lightweight refresh failed:', err);
        });
      } else {
        console.log(`[Discovery] Already have ${existing.orgs.length} org(s) in DB and data is fresh, skipping.`);

        // First boot after starred feature was added — fetch stars standalone
        if (existing.starredRepoCount === 0) {
          console.log('[Discovery] No starred repos indexed yet — fetching stars now');
          const starState: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };
          const starProgress: DiscoveryProgress = { phase: 'starred', orgsFound: 0, reposFound: 0 };
          fetchStarredRepos(db, auth.accessToken, starState, starProgress, (p) => {
            lastDiscoveryProgress = p;
            getWindow()?.webContents.send('github:discovery-progress', p);
          }).then(() => {
            const done: DiscoveryProgress = { phase: 'done', orgsFound: 0, reposFound: starProgress.reposFound };
            lastDiscoveryProgress = done;
            getWindow()?.webContents.send('github:discovery-complete', done);
          }).catch((err) => console.error('[Discovery] Starred-only fetch failed:', err));
        }
      }
      return;
    }
  }

  console.log('[Discovery] Starting background discovery for', auth.login);
  const pat = loadGitHubPat(db);
  runDiscovery(db, auth.accessToken, (progress) => {
    lastDiscoveryProgress = progress;
    getWindow()?.webContents.send('github:discovery-progress', progress);
  }, pat).then((state) => {
    activeDiscovery = null;
    console.log('[Discovery] Finished');
    getWindow()?.webContents.send('github:discovery-complete', lastDiscoveryProgress);
  }).catch((err) => {
    activeDiscovery = null;
    console.error('[Discovery] Failed:', err);
  });
}
