import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { TaskScheduler } from './task-scheduler';
import type { TaskRunRecord, TaskStatus } from './task-scheduler';
import { getScanFolders } from '../services/local-discovery';
import { startLocalScanIfNeeded } from '../plugins/local-repos/handler';
import { runBootWorkflowCheck, syncGitHubNotifications, runAutoDismissSweep } from '../plugins/notifications/handler';
import { refreshRuddrProjectsInBackground, prewarmRuddrCache } from '../plugins/groups/handler';
import { checkCopilotUsage } from '../plugins/copilot-usage/handler';
import { runActiveSessionsSweep } from '../plugins/active-sessions/handler';
import { safeHandle } from '../plugins/ipc-utils';
import { logger } from '../services/logger';

export const LOCAL_DISCOVERY_INITIAL_DELAY_MS = 30_000;
export const LOCAL_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;
export const RUDDR_REFRESH_INITIAL_DELAY_MS = 30_000;
export const RUDDR_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const GITHUB_NOTIFICATIONS_INITIAL_DELAY_MS = 60_000;
export const GITHUB_NOTIFICATIONS_INTERVAL_MS = 5 * 60 * 1000;
export const GITHUB_AUTO_DISMISS_INITIAL_DELAY_MS = 90_000;
export const GITHUB_AUTO_DISMISS_INTERVAL_MS = 10 * 60 * 1000;
export const COPILOT_USAGE_INITIAL_DELAY_MS = 20_000;
export const COPILOT_USAGE_INTERVAL_MS = 30 * 60 * 1000;
export const ACTIVE_SESSIONS_INITIAL_DELAY_MS = 20_000;
export const ACTIVE_SESSIONS_INTERVAL_MS = 2 * 60 * 1000;

let scheduler: TaskScheduler | null = null;

function broadcastTaskUpdate(getWindow: () => BrowserWindow | null, record: TaskRunRecord): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('tasks:run-complete', record);
  }
}

function registerTask(
  taskScheduler: TaskScheduler,
  getWindow: () => BrowserWindow | null,
  definition: Parameters<TaskScheduler['register']>[0],
): void {
  taskScheduler.register({
    ...definition,
    run: async () => {
      const result = await definition.run();
      return result;
    },
  });
}

export function createBackgroundTaskScheduler(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): TaskScheduler {
  const taskScheduler = new TaskScheduler((record) => broadcastTaskUpdate(getWindow, record));

  registerTask(taskScheduler, getWindow, {
    id: 'github-workflow-cache-prewarm',
    label: 'GitHub workflow cache prewarm',
    run: async () => {
      await runBootWorkflowCheck(db, getWindow);
      return { ok: true };
    },
  });

  registerTask(taskScheduler, getWindow, {
    id: 'local-discovery',
    label: 'Local repo discovery',
    initialDelayMs: LOCAL_DISCOVERY_INITIAL_DELAY_MS,
    intervalMs: LOCAL_DISCOVERY_INTERVAL_MS,
    run: () => {
      const folders = getScanFolders(db);
      if (folders.length === 0) return { skipped: true, reason: 'No scan folders configured' };
      const started = startLocalScanIfNeeded(db, getWindow);
      return { started, folderCount: folders.length };
    },
  });

  registerTask(taskScheduler, getWindow, {
    id: 'ruddr-project-refresh',
    label: 'Ruddr project refresh',
    initialDelayMs: RUDDR_REFRESH_INITIAL_DELAY_MS,
    intervalMs: RUDDR_REFRESH_INTERVAL_MS,
    run: () => refreshRuddrProjectsInBackground(db, getWindow, true),
  });

  registerTask(taskScheduler, getWindow, {
    id: 'github-notifications-sync',
    label: 'GitHub notifications sync',
    initialDelayMs: GITHUB_NOTIFICATIONS_INITIAL_DELAY_MS,
    intervalMs: GITHUB_NOTIFICATIONS_INTERVAL_MS,
    run: () => syncGitHubNotifications(db, getWindow),
  });

  registerTask(taskScheduler, getWindow, {
    id: 'github-auto-dismiss',
    label: 'GitHub auto-dismiss sweep',
    initialDelayMs: GITHUB_AUTO_DISMISS_INITIAL_DELAY_MS,
    intervalMs: GITHUB_AUTO_DISMISS_INTERVAL_MS,
    run: () => runAutoDismissSweep(db, getWindow),
  });

  registerTask(taskScheduler, getWindow, {
    id: 'copilot-ai-credit-usage',
    label: 'Copilot AI credit usage check',
    initialDelayMs: COPILOT_USAGE_INITIAL_DELAY_MS,
    intervalMs: COPILOT_USAGE_INTERVAL_MS,
    run: async () => {
      const usage = await checkCopilotUsage(db, getWindow);
      if (!usage.configured) return { skipped: true, reason: 'GitHub not connected' };
      if (usage.error) throw new Error(usage.error);
      return { creditsUsed: usage.creditsUsed, budgetCredits: usage.budgetCredits };
    },
  });

  registerTask(taskScheduler, getWindow, {
    id: 'active-sessions-readiness',
    label: 'Agent sessions PR readiness',
    initialDelayMs: ACTIVE_SESSIONS_INITIAL_DELAY_MS,
    intervalMs: ACTIVE_SESSIONS_INTERVAL_MS,
    run: () => runActiveSessionsSweep(db, getWindow),
  });

  return taskScheduler;
}

export function startBackgroundTasks(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  options: { githubReady: boolean } = { githubReady: true },
): TaskScheduler {
  scheduler?.stop();
  scheduler = createBackgroundTaskScheduler(db, getWindow);
  scheduler.start();

  void prewarmRuddrCache(db).catch((err: unknown) => {
    logger.warn('[Tasks] Ruddr cache pre-warm failed:', err instanceof Error ? err.message : String(err));
  });

  if (options.githubReady) {
    void scheduler.runNow('github-workflow-cache-prewarm');
  }

  return scheduler;
}

export function stopBackgroundTasks(): void {
  scheduler?.stop();
  scheduler = null;
}

export function getBackgroundTaskScheduler(): TaskScheduler | null {
  return scheduler;
}

export function registerTaskIpcHandlers(): void {
  safeHandle('tasks:list', (): TaskStatus[] => scheduler?.listTasks() ?? []);
  safeHandle('tasks:run-now', async (_event, taskId: string): Promise<TaskRunRecord | { ok: false; error: string }> => {
    if (typeof taskId !== 'string' || taskId.length === 0) return { ok: false, error: 'Invalid taskId' };
    if (!scheduler) return { ok: false, error: 'Task scheduler is not running' };
    return await scheduler.runNow(taskId);
  });
}
