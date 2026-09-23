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
    ipcMain: { handle: vi.fn() },
    send: vi.fn(),
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
    ipcMain: mocks.ipcMain,
    Notification: MockNotification,
  };
});

vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }));

const { autoUpdater } = mocks;

type UpdateCheckerModule = typeof import('../../src/main/update-checker');
let checkForUpdates: UpdateCheckerModule['checkForUpdates'];
let getUpdateState: UpdateCheckerModule['getUpdateState'];
let registerUpdateIpcHandlers: UpdateCheckerModule['registerUpdateIpcHandlers'];

/** Stand-in main window that records everything pushed over `updates:state`. */
function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: mocks.send } };
}

/** Pull an ipcMain.handle callback out of the mock by channel name. */
function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const entry = mocks.ipcMain.handle.mock.calls.find((call) => call[0] === channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  return entry[1] as (...args: unknown[]) => unknown;
}

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
    ({ checkForUpdates, getUpdateState, registerUpdateIpcHandlers } = await import('../../src/main/update-checker'));
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

  // ── Persistent update state ───────────────────────────────────────────────
  // A downloaded update must stay actionable after its notification is gone,
  // which is what the top-bar update button reads.

  it('tracks download progress and the ready-to-install state', async () => {
    await checkForUpdates();
    expect(getUpdateState()).toEqual({ status: 'idle' });

    autoUpdater.emit('update-available', { version: '1.3.0' });
    expect(getUpdateState()).toEqual({ status: 'downloading', version: '1.3.0', percent: 0 });

    autoUpdater.emit('download-progress', { percent: 42.7 });
    expect(getUpdateState()).toEqual({ status: 'downloading', version: '1.3.0', percent: 43 });

    autoUpdater.emit('update-downloaded', { version: '1.3.0' });
    expect(getUpdateState()).toEqual({ status: 'downloaded', version: '1.3.0' });
  });

  it('keeps a downloaded update visible across later checks and failures', async () => {
    await checkForUpdates();
    autoUpdater.emit('update-downloaded', { version: '1.3.0' });

    autoUpdater.emit('checking-for-update');
    expect(getUpdateState()).toEqual({ status: 'downloaded', version: '1.3.0' });

    autoUpdater.emit('update-not-available');
    expect(getUpdateState()).toEqual({ status: 'downloaded', version: '1.3.0' });

    autoUpdater.emit('error', new Error('network down'));
    expect(getUpdateState()).toEqual({ status: 'downloaded', version: '1.3.0' });
  });

  it('pushes every state change to the renderer', async () => {
    registerUpdateIpcHandlers(() => fakeWindow() as never);
    await checkForUpdates();

    autoUpdater.emit('update-available', { version: '1.3.0' });
    autoUpdater.emit('update-downloaded', { version: '1.3.0' });

    expect(mocks.send).toHaveBeenCalledWith('updates:state', { status: 'downloading', version: '1.3.0', percent: 0 });
    expect(mocks.send).toHaveBeenCalledWith('updates:state', { status: 'downloaded', version: '1.3.0' });
  });

  it('installs from the renderer only once an update is downloaded', async () => {
    registerUpdateIpcHandlers(() => fakeWindow() as never);
    const install = handlerFor('updates:install');
    await checkForUpdates();

    expect(install()).toEqual({ ok: false });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    autoUpdater.emit('update-downloaded', { version: '1.3.0' });

    expect(install()).toEqual({ ok: true });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('serves the current state to a renderer that starts after the download', async () => {
    registerUpdateIpcHandlers(() => fakeWindow() as never);
    await checkForUpdates();
    autoUpdater.emit('update-downloaded', { version: '1.3.0' });

    expect(handlerFor('updates:get-state')()).toEqual({ status: 'downloaded', version: '1.3.0' });
  });

  it('treats a renderer-triggered check as manual, so it always gets a notification', async () => {
    registerUpdateIpcHandlers(() => fakeWindow() as never);
    const check = handlerFor('updates:check');

    const pending = check();
    autoUpdater.emit('update-not-available');
    await pending;

    expect(mocks.notifications[0]?.options.title).toBe('Jarvis is up to date');
  });

  it('surfaces an up-to-date result in shared state for any trigger, not just the button', async () => {
    await checkForUpdates();
    autoUpdater.emit('update-not-available');

    expect(getUpdateState()).toEqual({ status: 'up-to-date' });
  });

  it('sets an error state even when checkForUpdates rejects without emitting an error event', async () => {
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('no publish config'));

    await checkForUpdates();

    expect(getUpdateState()).toEqual({ status: 'error', error: 'no publish config' });
  });

  // ── safeHandle migration ────────────────────────────────────────────────
  // updates:get-state/check/install have no internal try/catch of their own,
  // so a thrown exception used to reject the ipcMain.invoke() call. safeHandle
  // now turns that into a resolved { ok: false, error } payload instead.

  it('turns an unexpected updates:install exception into an ok:false payload instead of rejecting', async () => {
    registerUpdateIpcHandlers(() => fakeWindow() as never);
    await checkForUpdates();
    autoUpdater.emit('update-downloaded', { version: '1.3.0' });

    const install = handlerFor('updates:install');
    autoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('install failed');
    });

    expect(install()).toEqual({ ok: false, error: 'install failed' });
  });
});
