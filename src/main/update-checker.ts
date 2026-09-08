import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let initialCheckTimer: NodeJS.Timeout | null = null;
let periodicCheckTimer: NodeJS.Timeout | null = null;
let manualCheckInFlight = false;
let listenersRegistered = false;

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

  autoUpdater.on('update-available', (info) => {
    showNotification(`Jarvis ${info.version} is available`, 'Downloading the update in the background…');
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheckInFlight) {
      showNotification('Jarvis is up to date', `Version ${app.getVersion()} is the latest release.`);
    }
    manualCheckInFlight = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    showNotification(
      `Jarvis ${info.version} is ready to install`,
      'Click to restart Jarvis and finish installing.',
      () => { autoUpdater.quitAndInstall(); },
    );
  });

  autoUpdater.on('error', (error) => {
    console.warn('[Updates] Update check failed:', error);
    if (manualCheckInFlight) {
      showNotification('Update check failed', 'Jarvis could not reach GitHub Releases. Try again later.');
    }
    manualCheckInFlight = false;
  });
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
    console.warn('[Updates] Update check failed:', error);
    if (manual) {
      showNotification('Update check failed', 'Jarvis could not reach GitHub Releases. Try again later.');
    }
    manualCheckInFlight = false;
  }
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
