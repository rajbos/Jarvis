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

    expect(handlers.get('test:sync')!({})).toEqual({ error: 'sync failure' });
  });

  it('converts rejected promises to an error payload', async () => {
    safeHandle('test:async', async () => {
      throw new Error('async failure');
    });

    await expect(handlers.get('test:async')!({})).resolves.toEqual({ error: 'async failure' });
  });

  it('preserves successful return values', () => {
    safeHandle('test:success', () => ({ ok: true }));

    expect(handlers.get('test:success')!({})).toEqual({ ok: true });
  });
});
