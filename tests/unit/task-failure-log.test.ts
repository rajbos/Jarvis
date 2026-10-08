import { describe, it, expect, vi } from 'vitest';
import initSqlJs from 'sql.js';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return false; }
    show() {}
  },
}));

import {
  TaskFailureAlerter,
  recordTaskFailure,
  getRecentTaskFailures,
  MAX_FAILURES_PER_TASK,
} from '../../src/main/task-failure-log';
import { initializeSchema } from '../../src/storage/database';
import type { TaskRunRecord } from '../../src/main/task-scheduler';

function rec(status: TaskRunRecord['status'], taskId = 't1', error = 'boom'): TaskRunRecord {
  const at = new Date().toISOString();
  return { taskId, status, startedAt: at, finishedAt: at, durationMs: 1, error: status === 'success' ? undefined : error };
}

describe('TaskFailureAlerter', () => {
  it('notifies once when a task reaches the consecutive-failure threshold', () => {
    const notify = vi.fn();
    const alerter = new TaskFailureAlerter(notify, 2);
    alerter.handle(rec('failed'), 'Task one');
    expect(notify).not.toHaveBeenCalled();
    alerter.handle(rec('failed'), 'Task one');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('Task one');
    expect(notify.mock.calls[0][1]).toBe('boom');
    alerter.handle(rec('failed'), 'Task one');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('resets the streak after a success and ignores skipped runs', () => {
    const notify = vi.fn();
    const alerter = new TaskFailureAlerter(notify, 2);
    alerter.handle(rec('failed'), 'T');
    alerter.handle(rec('success'), 'T');
    alerter.handle(rec('skipped'), 'T');
    alerter.handle(rec('failed'), 'T');
    expect(notify).not.toHaveBeenCalled();
    alerter.handle(rec('failed'), 'T');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tracks streaks per task', () => {
    const notify = vi.fn();
    const alerter = new TaskFailureAlerter(notify, 2);
    alerter.handle(rec('failed', 'a'), 'A');
    alerter.handle(rec('failed', 'b'), 'B');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('task failure persistence', () => {
  it('stores failures, returns newest first and trims history per task', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    initializeSchema(db);

    for (let i = 0; i < MAX_FAILURES_PER_TASK + 5; i++) recordTaskFailure(db, rec('failed', 'a', `err ${i}`));
    recordTaskFailure(db, rec('failed', 'b', 'other'));

    const all = getRecentTaskFailures(db, 100);
    expect(all.filter((f) => f.taskId === 'a')).toHaveLength(MAX_FAILURES_PER_TASK);
    expect(all[0]).toMatchObject({ taskId: 'b', error: 'other' });
    expect(all.find((f) => f.taskId === 'a')?.error).toBe(`err ${MAX_FAILURES_PER_TASK + 4}`);
  });
});
