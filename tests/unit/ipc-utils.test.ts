import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { safeHandle } from '../../src/plugins/ipc-utils';

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
