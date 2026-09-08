import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const notifications: Array<{
    options: { title: string; body: string };
    click?: () => void;
    show: ReturnType<typeof vi.fn>;
  }> = [];

  class MockAutoUpdater extends EventEmitter {
    checkForUpdates = vi.fn(async () => undefined);
    quitAndInstall = vi.fn();
  }

  return {
    app: { isPackaged: true, getVersion: vi.fn(() => '1.2.3') },
    autoUpdater: new MockAutoUpdater(),
    notifications,
  };
});

vi.mock('electron', () => {
  class MockNotification {
    static isSupported = vi.fn(() => true);
    readonly show = vi.fn();
    readonly options: { title: string; body: string };
    click?: () => void;

    constructor(options: { title: string; body: string }) {
      this.options = options;
      mocks.notifications.push(this);
    }

    on(event: string, callback: () => void): void {
      if (event === 'click') this.click = callback;
    }
  }

  return {
    app: mocks.app,
    Notification: MockNotification,
  };
});

vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }));

const { autoUpdater } = mocks;

let checkForUpdates: typeof import('../../src/main/update-checker')['checkForUpdates'];

describe('update checker', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.notifications.length = 0;
    mocks.app.isPackaged = true;
    mocks.app.getVersion.mockReturnValue('1.2.3');
    autoUpdater.removeAllListeners();

    // The module registers its autoUpdater listeners once per import, so reset
    // modules between tests to get a fresh registration against the mock.
    vi.resetModules();
    ({ checkForUpdates } = await import('../../src/main/update-checker'));
  });

  it('does not contact GitHub from an unpackaged development run', async () => {
    mocks.app.isPackaged = false;

    await checkForUpdates();

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.notifications).toHaveLength(0);
  });

  it('notifies and starts a background download when a newer release is available', async () => {
    await checkForUpdates();
    autoUpdater.emit('update-available', { version: '1.3.0' });

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.notifications[0]?.options).toEqual({
      title: 'Jarvis 1.3.0 is available',
      body: 'Downloading the update in the background…',
    });
  });

  it('prompts to restart and install once the download finishes, and installs on click', async () => {
    await checkForUpdates();
    autoUpdater.emit('update-downloaded', { version: '1.3.0' });

    expect(mocks.notifications[0]?.options.title).toBe('Jarvis 1.3.0 is ready to install');
    mocks.notifications[0]?.click?.();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('reports an up-to-date version only for a manual check', async () => {
    await checkForUpdates(true);
    autoUpdater.emit('update-not-available');

    expect(mocks.notifications[0]?.options).toEqual({
      title: 'Jarvis is up to date',
      body: 'Version 1.2.3 is the latest release.',
    });
  });

  it('stays quiet on an automatic up-to-date result', async () => {
    await checkForUpdates();
    autoUpdater.emit('update-not-available');

    expect(mocks.notifications).toHaveLength(0);
  });

  it('reports a failure only for a manual check', async () => {
    await checkForUpdates(true);
    autoUpdater.emit('error', new Error('network down'));

    expect(mocks.notifications[0]?.options.title).toBe('Update check failed');
  });
});
