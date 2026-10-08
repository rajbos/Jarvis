import type { Database as SqlJsDatabase } from 'sql.js';
import { Notification } from 'electron';
import { logger } from '../services/logger';
import { saveDatabase } from '../storage/database';
import type { TaskRunRecord } from './task-scheduler';

/** Failures kept per task in the task_failures table. */
export const MAX_FAILURES_PER_TASK = 20;
/** Consecutive failures of one task before a desktop notification is shown. */
export const NOTIFY_AFTER_CONSECUTIVE_FAILURES = 2;

export interface TaskFailureEntry {
  taskId: string;
  failedAt: string;
  error: string;
}

/** Persist a failed run so it survives restarts; trims history per task. */
export function recordTaskFailure(db: SqlJsDatabase, record: TaskRunRecord): void {
  try {
    db.run('INSERT INTO task_failures (task_id, failed_at, error) VALUES (?, ?, ?)', [
      record.taskId,
      record.finishedAt,
      record.error ?? 'Unknown error',
    ]);
    db.run(
      `DELETE FROM task_failures WHERE task_id = ? AND id NOT IN (
         SELECT id FROM task_failures WHERE task_id = ? ORDER BY id DESC LIMIT ?)`,
      [record.taskId, record.taskId, MAX_FAILURES_PER_TASK],
    );
    saveDatabase();
  } catch (err) {
    logger.warn('[Tasks] Could not persist task failure:', err instanceof Error ? err.message : String(err));
  }
}

export function getRecentTaskFailures(db: SqlJsDatabase, limit = 50): TaskFailureEntry[] {
  const result = db.exec('SELECT task_id, failed_at, error FROM task_failures ORDER BY id DESC LIMIT ?', [limit]);
  if (result.length === 0) return [];
  return result[0].values.map((row) => ({
    taskId: row[0] as string,
    failedAt: row[1] as string,
    error: row[2] as string,
  }));
}

export function showTaskFailureNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) {
      logger.info(`[Tasks] ${title}: ${body}`);
      return;
    }
    new Notification({ title, body }).show();
  } catch (err) {
    logger.warn('[Tasks] Could not show task failure notification:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Tracks consecutive failures per task and fires `notify` once per failure
 * streak (when it reaches the threshold), so a task that fails every cycle
 * while the window is closed in the tray alerts the user without spamming.
 */
export class TaskFailureAlerter {
  private readonly streaks = new Map<string, number>();

  constructor(
    private readonly notify: (title: string, body: string) => void = showTaskFailureNotification,
    private readonly threshold = NOTIFY_AFTER_CONSECUTIVE_FAILURES,
  ) {}

  handle(record: TaskRunRecord, label: string): void {
    if (record.status === 'success') {
      this.streaks.delete(record.taskId);
      return;
    }
    if (record.status !== 'failed') return;
    const streak = (this.streaks.get(record.taskId) ?? 0) + 1;
    this.streaks.set(record.taskId, streak);
    if (streak === this.threshold) {
      this.notify(`Jarvis background task failing: ${label}`, record.error ?? 'Unknown error');
    }
  }
}
