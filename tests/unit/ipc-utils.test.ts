import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { safeHandle, safeSend } from '../../src/plugins/ipc-utils';

describe('safeHandle', () => {
  beforeEach(() => handlers.clear());

  it('converts synchronous exceptions to an error payload', () => {
    safeHandle('test:sync', () => {
      throw new Error('sync failure');
    });

    expect(handlers.get('test:sync')!({})).toEqual({ ok: false, error: 'sync failure' });
  });

  it('converts rejected promises to an error payload', async () => {
    safeHandle('test:async', async () => {
      throw new Error('async failure');
    });

    await expect(handlers.get('test:async')!({})).resolves.toEqual({ ok: false, error: 'async failure' });
  });

  it('converts non-Error thrown values to a string error payload', () => {
    safeHandle('test:sync-non-error', () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string failure';
    });

    expect(handlers.get('test:sync-non-error')!({})).toEqual({ ok: false, error: 'string failure' });
  });

  it('preserves successful return values', () => {
    safeHandle('test:success', () => ({ ok: true }));

    expect(handlers.get('test:success')!({})).toEqual({ ok: true });
  });
});

describe('safeSend', () => {
  function mockWindow({ winDestroyed = false, contentsDestroyed = false } = {}) {
    return {
      isDestroyed: () => winDestroyed,
      webContents: { isDestroyed: () => contentsDestroyed, send: vi.fn() },
    };
  }

  it('sends the channel and all arguments to a live window', () => {
    const win = mockWindow();
    safeSend(win, 'test:push', { a: 1 }, 'two');
    expect(win.webContents.send).toHaveBeenCalledWith('test:push', { a: 1 }, 'two');
  });

  it('skips a destroyed window without throwing', () => {
    const win = mockWindow({ winDestroyed: true });
    win.webContents.send.mockImplementation(() => { throw new Error('Object has been destroyed'); });
    expect(() => safeSend(win, 'test:push')).not.toThrow();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('skips a window whose webContents is destroyed', () => {
    const win = mockWindow({ contentsDestroyed: true });
    safeSend(win, 'test:push');
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('ignores a missing window', () => {
    expect(() => safeSend(null, 'test:push')).not.toThrow();
    expect(() => safeSend(undefined, 'test:push')).not.toThrow();
  });
});
