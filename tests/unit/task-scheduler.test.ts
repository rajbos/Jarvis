import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskScheduler } from '../../src/main/task-scheduler';

describe('TaskScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a registered task immediately and records success metadata', async () => {
    const run = vi.fn(async () => ({ ok: true, count: 2 }));
    const scheduler = new TaskScheduler();
    scheduler.register({ id: 'demo', label: 'Demo task', run });

    const result = await scheduler.runNow('demo');

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    expect(result.taskId).toBe('demo');
    expect(result.result).toEqual({ ok: true, count: 2 });
    expect(result.finishedAt).toBeTruthy();
    expect(scheduler.listTasks()[0]).toMatchObject({
      id: 'demo',
      label: 'Demo task',
      running: false,
      lastStatus: 'success',
      lastResult: { ok: true, count: 2 },
    });
  });

  it('records failed runs without throwing from runNow', async () => {
    const run = vi.fn(async () => { throw new Error('boom'); });
    const scheduler = new TaskScheduler();
    scheduler.register({ id: 'failing', label: 'Failing task', run });

    const result = await scheduler.runNow('failing');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(scheduler.getTask('failing')?.lastStatus).toBe('failed');
    expect(scheduler.getTask('failing')?.lastError).toBe('boom');
  });

  it('skips overlapping runs of the same task', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const scheduler = new TaskScheduler();
    scheduler.register({ id: 'slow', label: 'Slow task', run });

    const first = scheduler.runNow('slow');
    await Promise.resolve();
    const second = await scheduler.runNow('slow');

    expect(second.status).toBe('skipped');
    expect(second.error).toBe('Task already running');
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(scheduler.getTask('slow')?.running).toBe(false);
  });

  it('runs recurring tasks after initial delay and interval', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new TaskScheduler();
    scheduler.register({
      id: 'recurring',
      label: 'Recurring task',
      initialDelayMs: 1000,
      intervalMs: 5000,
      run,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('throws for duplicate task ids and unknown runNow ids', async () => {
    const scheduler = new TaskScheduler();
    scheduler.register({ id: 'x', label: 'X', run: async () => undefined });

    expect(() => scheduler.register({ id: 'x', label: 'Duplicate', run: async () => undefined })).toThrow(/already registered/);
    await expect(scheduler.runNow('missing')).rejects.toThrow(/Unknown task/);
  });
});
