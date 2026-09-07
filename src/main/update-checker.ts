import { app, net, Notification, shell } from 'electron';

const RELEASE_API_URL = 'https://api.github.com/repos/rajbos/Jarvis/releases/latest';
const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  name?: string | null;
}

let initialCheckTimer: NodeJS.Timeout | null = null;
let periodicCheckTimer: NodeJS.Timeout | null = null;

function parseVersion(version: string): number[] | null {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
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

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      showNotification('Jarvis updates', 'Update checks are only available in the installed app.');
    }
    return;
  }

  try {
    const response = await net.fetch(RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Jarvis/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.status === 404) {
      if (manual) {
        showNotification('No Jarvis releases found', 'No published installer updates are available yet.');
      }
      return;
    }

    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }

    const release = await response.json() as GitHubRelease;
    if (!isNewerVersion(release.tag_name, app.getVersion())) {
      if (manual) {
        showNotification('Jarvis is up to date', `Version ${app.getVersion()} is the latest release.`);
      }
      return;
    }

    const version = release.tag_name.replace(/^v/i, '');
    showNotification(
      `Jarvis ${version} is available`,
      'Click to open the release page and download the new installer.',
      () => { void shell.openExternal(release.html_url); },
    );
  } catch (error) {
    console.warn('[Updates] Update check failed:', error);
    if (manual) {
      showNotification('Update check failed', 'Jarvis could not reach GitHub Releases. Try again later.');
    }
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
