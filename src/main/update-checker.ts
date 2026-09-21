import { app, ipcMain, Notification, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../types/ipc-payloads';

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UP_TO_DATE_DISPLAY_MS = 4_000;

let initialCheckTimer: NodeJS.Timeout | null = null;
let periodicCheckTimer: NodeJS.Timeout | null = null;
let upToDateTimer: NodeJS.Timeout | null = null;
let manualCheckInFlight = false;
let listenersRegistered = false;

// The update state lives in the main process so it survives renderer reloads and
// missed notifications: a downloaded update stays visible in the UI until it is
// installed, instead of being lost with the toast that announced it.
let state: UpdateState = { status: 'idle' };
let getMainWindow: () => BrowserWindow | null = () => null;

function broadcastState(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updates:state', state);
  }
}

function setState(next: UpdateState): void {
  state = next;
  broadcastState();
}

export function getUpdateState(): UpdateState {
  return state;
}

function showNotification(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) {
    console.log(`[Updates] ${title}: ${body}`);
    return;
  }

  const notification = new Notification({ title, body });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

function registerListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  autoUpdater.on('checking-for-update', () => {
    // A downloaded update outranks a fresh check: keep the install prompt up so
    // the periodic 6-hour check never hides a ready update behind a spinner.
    if (state.status !== 'downloaded') setState({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    setState({ status: 'downloading', version: info.version, percent: 0 });
    showNotification(`Jarvis ${info.version} is available`, 'Downloading the update in the background…');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (state.status !== 'downloading') return;
    setState({ ...state, percent: Math.round(progress.percent ?? 0) });
  });

  autoUpdater.on('update-not-available', () => {
    if (state.status !== 'downloaded') {
      // Surface the result in-app so a manual check always gives visible feedback,
      // even if the OS notification is suppressed or unsupported.
      setState({ status: 'up-to-date' });
      if (upToDateTimer) clearTimeout(upToDateTimer);
      upToDateTimer = setTimeout(() => {
        upToDateTimer = null;
        if (state.status === 'up-to-date') setState({ status: 'idle' });
      }, UP_TO_DATE_DISPLAY_MS);
    }
    if (manualCheckInFlight) {
      showNotification('Jarvis is up to date', `Version ${app.getVersion()} is the latest release.`);
    }
    manualCheckInFlight = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', version: info.version });
    showNotification(
      `Jarvis ${info.version} is ready to install`,
      'Click to restart Jarvis and finish installing.',
      () => { installUpdate(); },
    );
  });

  autoUpdater.on('error', (error) => {
    console.warn('[Updates] Update check failed:', error);
    if (state.status !== 'downloaded') {
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    if (manualCheckInFlight) {
      showNotification('Update check failed', 'Jarvis could not reach GitHub Releases. Try again later.');
    }
    manualCheckInFlight = false;
  });
}

export function installUpdate(): void {
  if (state.status !== 'downloaded') return;
  autoUpdater.quitAndInstall();
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      showNotification('Jarvis updates', 'Update checks are only available in the installed app.');
    }
    return;
  }

  registerListeners();
  if (manual) manualCheckInFlight = true;

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // electron-updater usually reports failures via the 'error' event, but some
    // failures (e.g. missing publish config) only reject this promise — make sure
    // those are visible too instead of leaving the UI stuck on 'checking'.
    console.warn('[Updates] Update check failed:', error);
    if (state.status !== 'downloaded') {
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    if (manual) {
      showNotification('Update check failed', 'Jarvis could not reach GitHub Releases. Try again later.');
    }
    manualCheckInFlight = false;
  }
}

export function registerUpdateIpcHandlers(getWindow: () => BrowserWindow | null): void {
  getMainWindow = getWindow;

  ipcMain.handle('updates:get-state', (): UpdateState => state);
  ipcMain.handle('updates:check', async (): Promise<UpdateState> => {
    await checkForUpdates(true);
    return state;
  });
  ipcMain.handle('updates:install', (): { ok: boolean } => {
    if (state.status !== 'downloaded') return { ok: false };
    installUpdate();
    return { ok: true };
  });
}

export function startUpdateChecks(): void {
  if (!app.isPackaged || initialCheckTimer || periodicCheckTimer) return;

  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null;
    void checkForUpdates();
  }, INITIAL_CHECK_DELAY_MS);
  initialCheckTimer.unref();

  periodicCheckTimer = setInterval(() => { void checkForUpdates(); }, CHECK_INTERVAL_MS);
  periodicCheckTimer.unref();
}

export function stopUpdateChecks(): void {
  if (initialCheckTimer) clearTimeout(initialCheckTimer);
  if (periodicCheckTimer) clearInterval(periodicCheckTimer);
  initialCheckTimer = null;
  periodicCheckTimer = null;
}
