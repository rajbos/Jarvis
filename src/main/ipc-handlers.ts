import { ipcMain, shell, Notification, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { loadConfig } from '../agent/config';
import { getOnboardingStatus, completeOnboardingStep } from '../agent/onboarding';
import { saveDatabase } from '../storage/database';
import {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  saveGitHubAuth,
  loadGitHubAuth,
} from '../services/github-oauth';

let activeDeviceFlow: {
  deviceCode: string;
  clientId: string;
  intervalMs: number;
  aborted: boolean;
} | null = null;

export function registerIpcHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('onboarding:status', () => {
    return getOnboardingStatus(db);
  });

  ipcMain.handle('github:oauth-status', () => {
    console.log('[IPC] github:oauth-status called');
    const auth = loadGitHubAuth(db);
    if (auth) {
      console.log('[IPC] Found existing auth for:', auth.login);
      return { authenticated: true, login: auth.login, scopes: auth.scopes };
    }
    console.log('[IPC] No existing GitHub auth found');
    return { authenticated: false };
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

      saveGitHubAuth(db, user.login, result.access_token, result.scope);
      completeOnboardingStep(db, 'github_oauth');
      saveDatabase();
      console.log('[Poll] Auth saved, pushing oauth-complete to renderer');

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
