import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const notifications: Array<{
    options: { title: string; body: string };
    click?: () => void;
    show: ReturnType<typeof vi.fn>;
  }> = [];

  return {
    app: { isPackaged: true, getVersion: vi.fn(() => '1.2.3') },
    fetch: vi.fn(),
    openExternal: vi.fn(),
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
    net: { fetch: mocks.fetch },
    shell: { openExternal: mocks.openExternal },
    Notification: MockNotification,
  };
});

import { checkForUpdates, isNewerVersion, stopUpdateChecks } from '../../src/main/update-checker';

describe('update checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notifications.length = 0;
    mocks.app.isPackaged = true;
    mocks.app.getVersion.mockReturnValue('1.2.3');
    stopUpdateChecks();
  });

  it('compares semantic versions and accepts a leading v', () => {
    expect(isNewerVersion('v1.3.0', '1.2.3')).toBe(true);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
    expect(isNewerVersion('not-a-version', '1.2.3')).toBe(false);
  });

  it('notifies when a newer GitHub release is available', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v1.3.0',
        html_url: 'https://github.com/rajbos/Jarvis/releases/tag/v1.3.0',
      }),
    });

    await checkForUpdates();

    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.notifications[0]?.options.title).toBe('Jarvis 1.3.0 is available');
    mocks.notifications[0]?.click?.();
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://github.com/rajbos/Jarvis/releases/tag/v1.3.0',
    );
  });

  it('reports an up-to-date version for a manual check', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.2.3', html_url: 'https://example.test' }),
    });

    await checkForUpdates(true);

    expect(mocks.notifications[0]?.options).toEqual({
      title: 'Jarvis is up to date',
      body: 'Version 1.2.3 is the latest release.',
    });
  });

  it('reports when no releases have been published yet', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404 });

    await checkForUpdates(true);

    expect(mocks.notifications[0]?.options.title).toBe('No Jarvis releases found');
  });

  it('does not contact GitHub from an unpackaged development run', async () => {
    mocks.app.isPackaged = false;

    await checkForUpdates();

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.notifications).toHaveLength(0);
  });
});
