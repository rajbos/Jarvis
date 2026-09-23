/**
 * Failure-path tests for the `tasks:*` IPC handlers registered in
 * src/main/background-tasks.ts, migrated to safeHandle().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/services/local-discovery', () => ({
  getScanFolders: vi.fn(() => []),
}));

vi.mock('../../src/plugins/local-repos/handler', () => ({
  startLocalScanIfNeeded: vi.fn(() => false),
}));

vi.mock('../../src/plugins/notifications/handler', () => ({
  runBootWorkflowCheck: vi.fn(async () => undefined),
  syncGitHubNotifications: vi.fn(async () => undefined),
  runAutoDismissSweep: vi.fn(async () => undefined),
}));

vi.mock('../../src/plugins/groups/handler', () => ({
  refreshRuddrProjectsInBackground: vi.fn(async () => undefined),
  prewarmRuddrCache: vi.fn(async () => undefined),
}));

import {
  startBackgroundTasks,
  stopBackgroundTasks,
  registerTaskIpcHandlers,
  getBackgroundTaskScheduler,
} from '../../src/main/background-tasks';

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

describe('background task IPC handlers (safeHandle failure paths)', () => {
  beforeEach(() => {
    handlers.clear();
    stopBackgroundTasks();
  });

  it('tasks:run-now still returns an ok:false payload (unchanged catch) when the scheduler is not running', async () => {
    registerTaskIpcHandlers();

    const runNow = handlerFor('tasks:run-now');
    await expect(runNow(undefined, 'some-task')).resolves.toEqual({
      ok: false,
      error: 'Task scheduler is not running',
    });
  });

  it('tasks:list wraps an unexpected exception as ok:false instead of rejecting the IPC call', async () => {
    startBackgroundTasks({} as never, () => null, { githubReady: false });
    registerTaskIpcHandlers();

    const scheduler = getBackgroundTaskScheduler();
    vi.spyOn(scheduler!, 'listTasks').mockImplementation(() => {
      throw new Error('boom');
    });

    const listTasks = handlerFor('tasks:list');
    // The handler itself is synchronous, so safeHandle's sync catch branch
    // returns the error payload directly rather than a rejected promise.
    expect(listTasks(undefined)).toEqual({ ok: false, error: 'boom' });
  });
});
