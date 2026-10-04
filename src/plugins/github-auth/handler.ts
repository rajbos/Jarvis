// ── GitHub OAuth + PAT IPC handlers ──────────────────────────────────────────
import { shell, clipboard, Notification, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  validateGitHubPat,
  saveGitHubAuth,
  loadGitHubAuth,
  saveGitHubPat,
  loadGitHubPat,
  getPrimaryGitHubLogin,
  setPrimaryGitHubLogin,
  deleteGitHubPat,
  deleteGitHubAuth,
} from '../../services/github-oauth';
import { saveDatabase, setConfigValue } from '../../storage/database';
import { loadConfig, resolveGitHubScopes } from '../../agent/config';
import { completeOnboardingStep } from '../../agent/onboarding';
import { startDiscoveryIfAuthed } from '../discovery/handler';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import { checkCopilotUsage } from '../copilot-usage/handler';
import { DEFAULT_HOST, apiBaseForHost, hostOfUrl, webBaseForHost } from '../../services/github-host';
import { accessForPrimary, accessForRepo } from '../../services/github-repo-access';

/**
 * Sign-in can be started from the main window or the Settings window, so the
 * result goes to every open window — otherwise the window that started the
 * device flow never learns it finished.
 */
function broadcastOAuthComplete(payload: { login?: string; name?: string | null; avatarUrl?: string; error?: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('github:oauth-complete', payload);
  }
}

/** Re-run the Copilot usage check after the GitHub token changed. */
function recheckCopilotUsage(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  checkCopilotUsage(db, getWindow).catch((err) => {
    logger.warn('[copilot-usage] Re-check after auth change failed:', err instanceof Error ? err.message : String(err));
  });
}

let activeDeviceFlow: {
  deviceCode: string;
  clientId: string;
  intervalMs: number;
  aborted: boolean;
  /** Adding a further account: the current primary account stays primary. */
  additional: boolean;
} | null = null;

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  safeHandle('github:oauth-status', async () => {
    logger.debug('[IPC] github:oauth-status called');
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
          logger.warn('[IPC] Could not backfill avatar_url:', e);
        }
      }
      return { authenticated: true, login: auth.login, scopes: auth.scopes, avatarUrl };
    }
    // Not usable — but say why, and which credential single-account features use instead.
    const stored = getPrimaryGitHubLogin(db);
    const fallback = await accessForPrimary(db);
    return {
      authenticated: false,
      unreadableLogin: stored,
      fallback: fallback ? { login: fallback.login, source: fallback.source } : null,
    };
  });

  safeHandle('github:open-url', (_event, url: string) => {
    if (typeof url === 'string' && /^https:\/\/(?:github\.com|[a-z0-9-]+\.ghe\.com)\//.test(url)) {
      shell.openExternal(url);
    }
  });

  safeHandle('github:get-run-url-for-check-suite', async (_event, checkSuiteApiUrl: string) => {
    if (typeof checkSuiteApiUrl !== 'string') return null;
    const match = checkSuiteApiUrl.match(
      /^https:\/\/api\.(?:github\.com|[a-z0-9-]+\.ghe\.com)\/repos\/([^/]+)\/([^/]+)\/check-suites\/(\d+)$/,
    );
    if (!match) return null;
    const [, owner, repo, checkSuiteId] = match;
    // Use the account that serves this repo, on the repo's own host.
    const host = hostOfUrl(checkSuiteApiUrl) ?? DEFAULT_HOST;
    const access = await accessForRepo(db, `${owner}/${repo}`, host);
    if (!access) return null;
    const apiBase = apiBaseForHost(host);
    const headers = {
      Authorization: `Bearer ${access.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    try {
      const runsRes = await fetch(
        `${apiBase}/repos/${owner}/${repo}/actions/runs?check_suite_id=${checkSuiteId}&per_page=10`,
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
          return `${webBaseForHost(host)}/${owner}/${repo}/actions?query=branch%3A${encodeURIComponent(suite.head_branch)}`;
        }
      }
    } catch { /* fall through */ }
    return null;
  });

  safeHandle('github:get-issue-state', async (_event, subjectUrl: string) => {
    if (typeof subjectUrl !== 'string') return null;
    const issueUrl = subjectUrl.match(/^https:\/\/api\.(?:github\.com|[a-z0-9-]+\.ghe\.com)\/repos\/([^/]+)\/([^/]+)\/issues\/\d+$/);
    if (!issueUrl) return null;
    const access = await accessForRepo(db, `${issueUrl[1]}/${issueUrl[2]}`, hostOfUrl(subjectUrl) ?? DEFAULT_HOST);
    if (!access) return null;
    const headers = {
      Authorization: `Bearer ${access.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    try {
      const issueRes = await fetch(subjectUrl, { headers });
      if (!issueRes.ok) return null;
      const issue = (await issueRes.json()) as { state: string };
      if (issue.state !== 'closed') return { state: 'open' as const, closedByMe: false, closedViaMergedPr: false };

      // Fetch events to determine who closed the issue and whether a PR did it
      const eventsRes = await fetch(`${subjectUrl}/events`, { headers });
      let closedByMe = false;
      let closedViaMergedPr = false;
      if (eventsRes.ok) {
        const events = (await eventsRes.json()) as Array<{
          event: string;
          actor: { login: string } | null;
          commit_id: string | null;
        }>;
        // Find the most recent 'closed' event
        const closedEvent = [...events].reverse().find((e) => e.event === 'closed');
        if (closedEvent) {
          closedByMe = (closedEvent.actor?.login ?? '').toLowerCase() === access.login.toLowerCase();
          // commit_id is set when the issue was closed by a commit (e.g. merging a PR with a closing keyword)
          closedViaMergedPr = closedEvent.commit_id !== null && closedEvent.commit_id !== '';
        }
      }
      return { state: 'closed' as const, closedByMe, closedViaMergedPr };
    } catch { return null; }
  });

  safeHandle('github:save-pat', async (_event, pat: string) => {
    // The stored sign-in's login is enough: a PAT also restores access when its token can't be decrypted.
    const login = getPrimaryGitHubLogin(db);
    if (!login) return { error: 'Not authenticated' };
    try {
      const user = await fetchGitHubUser(pat);
      if (user.login.toLowerCase() !== login.toLowerCase()) {
        return { error: `PAT belongs to ${user.login}, but you are signed in as ${login}` };
      }
    } catch {
      return { error: 'Invalid token — could not authenticate with GitHub' };
    }
    saveGitHubPat(db, login, pat);
    const { setConfigValue } = await import('../../storage/database');
    setConfigValue(db, 'force_pat_discovery', '1');
    saveDatabase();
    getWindow()?.webContents.send('github:pat-status-changed');
    return { ok: true };
  });

  safeHandle('github:delete-pat', () => {
    const login = getPrimaryGitHubLogin(db);
    if (!login) return { ok: false };
    deleteGitHubPat(db, login);
    saveDatabase();
    getWindow()?.webContents.send('github:pat-status-changed');
    return { ok: true };
  });

  safeHandle('github:logout', () => {
    deleteGitHubAuth(db);
    saveDatabase();
    recheckCopilotUsage(db, getWindow);
    return { ok: true };
  });

  safeHandle('github:pat-status', async () => {
    const pat = loadGitHubPat(db);
    if (!pat) return { hasPat: false };
    const result = await validateGitHubPat(pat);
    if (result.status === 'valid') {
      return { hasPat: true, expired: false, login: result.user.login, name: result.user.name, avatarUrl: result.user.avatar_url };
    }
    if (result.status === 'expired') {
      return { hasPat: true, expired: true };
    }
    // Couldn't determine validity (offline, GitHub 5xx, …) — don't claim the token is broken
    return { hasPat: true, expired: false };
  });

  safeHandle('github:start-oauth-discovery', () => {

    setConfigValue(db, 'force_oauth_discovery', '1');
    saveDatabase();
    startDiscoveryIfAuthed(db, getWindow);
    return { ok: true };
  });

  safeHandle('github:start-oauth', async (_event, opts?: { additional?: boolean }) => {
    logger.debug('[IPC] github:start-oauth called');
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
      const deviceCode = await requestDeviceCode(clientId, resolveGitHubScopes(config.github.scopes));
      const flow = {
        deviceCode: deviceCode.device_code,
        clientId,
        intervalMs: deviceCode.interval * 1000,
        aborted: false,
        additional: opts?.additional === true,
      };
      activeDeviceFlow = flow;
      // Copy the code before the browser takes focus: a renderer can't write the
      // clipboard once its window is in the background.
      let copied = false;
      try {
        clipboard.writeText(deviceCode.user_code);
        copied = true;
      } catch (err) {
        logger.warn('[IPC] Could not copy device code to clipboard:', err instanceof Error ? err.message : String(err));
      }
      shell.openExternal(deviceCode.verification_uri);
      startPollingLoop(flow, db, getWindow);
      return {
        status: 'pending',
        userCode: deviceCode.user_code,
        verificationUri: deviceCode.verification_uri,
        expiresIn: deviceCode.expires_in,
        copied,
      };
    } catch (err) {
      return { error: String(err) };
    }
  });
  safeHandle('github:get-rate-limit', async () => {
    const auth = loadGitHubAuth(db);
    const pat = loadGitHubPat(db);

    type RateLimitResource = { limit: number; remaining: number; reset: number; used: number };

    const fetchForToken = async (token: string): Promise<{ resource: RateLimitResource | null; error?: string; tokenExpiresAt?: string | null; tokenExpired?: boolean }> => {
      try {
        const res = await fetch('https://api.github.com/rate_limit', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        // GitHub returns the expiry date of expiring tokens (fine-grained PATs)
        // on every authenticated response — surface it so the UI can warn early.
        const tokenExpiresAt = res.headers.get('github-authentication-token-expiration');
        if (res.status === 401) {
          return { resource: null, error: 'HTTP 401 — token expired or revoked', tokenExpiresAt, tokenExpired: true };
        }
        if (!res.ok) return { resource: null, error: `HTTP ${res.status}`, tokenExpiresAt };
        const data = (await res.json()) as { resources: { core: RateLimitResource } };
        return { resource: data.resources.core, tokenExpiresAt };
      } catch (err) {
        return { resource: null, error: String(err) };
      }
    };

    const [oauthResult, patResult] = await Promise.all([
      auth ? fetchForToken(auth.accessToken) : Promise.resolve(null),
      pat ? fetchForToken(pat) : Promise.resolve(null),
    ]);

    // The rate-limit call doubles as a liveness check for the PAT: a 401 here
    // means the token is expired/revoked — let the renderer switch to the
    // "PAT expired" state immediately.
    if (patResult?.tokenExpired) {
      getWindow()?.webContents.send('github:pat-expired');
    }

    return {
      oauth: auth
        ? { configured: true, resource: oauthResult!.resource, error: oauthResult!.error }
        : { configured: false, resource: null },
      pat: pat
        ? {
            configured: true,
            resource: patResult!.resource,
            error: patResult!.error,
            tokenExpiresAt: patResult!.tokenExpiresAt ?? null,
            tokenExpired: patResult!.tokenExpired ?? false,
          }
        : { configured: false, resource: null },
      fetchedAt: new Date().toISOString(),
    };
  });

}

async function startPollingLoop(
  flow: { deviceCode: string; clientId: string; intervalMs: number; aborted: boolean; additional: boolean },
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
      // Pin the current primary before the new sign-in becomes the "latest" one,
      // so adding an account never silently switches the one everything else uses.
      const previousPrimary = flow.additional ? getPrimaryGitHubLogin(db) : null;
      saveGitHubAuth(db, user.login, result.access_token, result.scope, user.avatar_url);
      if (previousPrimary) setPrimaryGitHubLogin(db, previousPrimary);
      completeOnboardingStep(db, 'github_oauth');
      saveDatabase();

      startDiscoveryIfAuthed(db, getWindow, true);

      new Notification({
        title: 'Jarvis',
        body: `Signed in as ${user.login}. GitHub connection ready!`,
      }).show();

      broadcastOAuthComplete({
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
      });
      recheckCopilotUsage(db, getWindow);
      return;
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('slow_down')) continue;
      logger.error('[Poll] Fatal error, aborting:', msg);
      activeDeviceFlow = null;
      broadcastOAuthComplete({ error: msg });
      return;
    }
  }

  if (!flow.aborted) {
    activeDeviceFlow = null;
    broadcastOAuthComplete({ error: 'Authorization timed out. Please try again.' });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate the stored PAT and, when GitHub rejects it (401 — expired or
 * revoked), push a `github:pat-expired` event to the renderer so the UI can
 * switch to the "PAT expired" state. Returns true when the PAT is expired.
 * Used at app startup; the renderer event is skipped silently when no window
 * exists yet — the renderer re-checks via `github:pat-status` on mount anyway.
 */
export async function checkPatForExpiry(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<boolean> {
  const pat = loadGitHubPat(db);
  if (!pat) return false;
  const result = await validateGitHubPat(pat);
  if (result.status !== 'expired') return false;
  logger.warn('[PAT] Stored Personal Access Token is expired or revoked');
  getWindow()?.webContents.send('github:pat-expired');
  return true;
}
