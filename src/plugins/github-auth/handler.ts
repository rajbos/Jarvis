// ── GitHub OAuth + PAT IPC handlers ──────────────────────────────────────────
import { ipcMain, shell, Notification } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
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
} from '../../services/github-oauth';
import { saveDatabase, setConfigValue } from '../../storage/database';
import { loadConfig } from '../../agent/config';
import { completeOnboardingStep } from '../../agent/onboarding';
import { startDiscoveryIfAuthed } from '../discovery/handler';

let activeDeviceFlow: {
  deviceCode: string;
  clientId: string;
  intervalMs: number;
  aborted: boolean;
} | null = null;

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:oauth-status', async () => {
    console.log('[IPC] github:oauth-status called');
    const auth = loadGitHubAuth(db);
    if (auth) {
      let avatarUrl = auth.avatarUrl;
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
    return { authenticated: false };
  });

  ipcMain.handle('github:open-url', (_event, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('github:get-run-url-for-check-suite', async (_event, checkSuiteApiUrl: string) => {
    if (typeof checkSuiteApiUrl !== 'string') return null;
    const match = checkSuiteApiUrl.match(
      /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/check-suites\/(\d+)$/,
    );
    if (!match) return null;
    const [, owner, repo, checkSuiteId] = match;
    const auth = loadGitHubAuth(db);
    if (!auth) return null;
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    try {
      const runsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs?check_suite_id=${checkSuiteId}&per_page=10`,
        { headers },
      );
      if (runsRes.ok) {
        const data = (await runsRes.json()) as {
          workflow_runs: Array<{ html_url: string; conclusion: string | null }>;
        };
        const failed = data.workflow_runs.find(
          (r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled',
        );
        const run = failed ?? data.workflow_runs[0];
        if (run) return run.html_url;
      }
      const suiteRes = await fetch(checkSuiteApiUrl, { headers });
      if (suiteRes.ok) {
        const suite = (await suiteRes.json()) as { head_branch: string | null };
        if (suite.head_branch) {
          return `https://github.com/${owner}/${repo}/actions?query=branch%3A${encodeURIComponent(suite.head_branch)}`;
        }
      }
    } catch { /* fall through */ }
    return null;
  });

  ipcMain.handle('github:save-pat', async (_event, pat: string) => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated' };
    try {
      const user = await fetchGitHubUser(pat);
      if (user.login.toLowerCase() !== auth.login.toLowerCase()) {
        return { error: `PAT belongs to ${user.login}, but you are signed in as ${auth.login}` };
      }
    } catch {
      return { error: 'Invalid token — could not authenticate with GitHub' };
    }
    saveGitHubPat(db, auth.login, pat);
    const { setConfigValue } = await import('../../storage/database');
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

  ipcMain.handle('github:start-oauth-discovery', () => {

    setConfigValue(db, 'force_oauth_discovery', '1');
    saveDatabase();
    startDiscoveryIfAuthed(db, getWindow);
    return { ok: true };
  });

  ipcMain.handle('github:start-oauth', async () => {
    console.log('[IPC] github:start-oauth called');
    if (activeDeviceFlow) {
      activeDeviceFlow.aborted = true;
      activeDeviceFlow = null;
    }

    const config = loadConfig();
    const clientId = config.github.oauthClientId;
    if (!clientId) {
      return { error: 'GitHub OAuth Client ID is not configured. Set it in config.json.' };
    }

    try {
      const deviceCode = await requestDeviceCode(clientId, config.github.scopes);
      const flow = {
        deviceCode: deviceCode.device_code,
        clientId,
        intervalMs: deviceCode.interval * 1000,
        aborted: false,
      };
      activeDeviceFlow = flow;
      shell.openExternal(deviceCode.verification_uri);
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
  ipcMain.handle('github:get-rate-limit', async () => {
    const auth = loadGitHubAuth(db);
    const pat = loadGitHubPat(db);

    type RateLimitResource = { limit: number; remaining: number; reset: number; used: number };

    const fetchForToken = async (token: string): Promise<{ resource: RateLimitResource | null; error?: string }> => {
      try {
        const res = await fetch('https://api.github.com/rate_limit', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (!res.ok) return { resource: null, error: `HTTP ${res.status}` };
        const data = (await res.json()) as { resources: { core: RateLimitResource } };
        return { resource: data.resources.core };
      } catch (err) {
        return { resource: null, error: String(err) };
      }
    };

    const [oauthResult, patResult] = await Promise.all([
      auth ? fetchForToken(auth.accessToken) : Promise.resolve(null),
      pat ? fetchForToken(pat) : Promise.resolve(null),
    ]);

    return {
      oauth: auth
        ? { configured: true, resource: oauthResult!.resource, error: oauthResult!.error }
        : { configured: false, resource: null },
      pat: pat
        ? { configured: true, resource: patResult!.resource, error: patResult!.error }
        : { configured: false, resource: null },
      fetchedAt: new Date().toISOString(),
    };
  });

}

async function startPollingLoop(
  flow: { deviceCode: string; clientId: string; intervalMs: number; aborted: boolean },
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;

  while (!flow.aborted && Date.now() < deadline) {
    await sleep(flow.intervalMs);
    if (flow.aborted) break;

    try {
      const result = await pollForToken(flow.clientId, flow.deviceCode, flow);
      if (!result) continue;

      activeDeviceFlow = null;
      const user = await fetchGitHubUser(result.access_token);
      saveGitHubAuth(db, user.login, result.access_token, result.scope, user.avatar_url);
      completeOnboardingStep(db, 'github_oauth');
      saveDatabase();

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
      if (msg.includes('slow_down')) continue;
      console.error('[Poll] Fatal error, aborting:', msg);
      activeDeviceFlow = null;
      getWindow()?.webContents.send('github:oauth-complete', { error: msg });
      return;
    }
  }

  if (!flow.aborted) {
    activeDeviceFlow = null;
    getWindow()?.webContents.send('github:oauth-complete', { error: 'Authorization timed out. Please try again.' });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
