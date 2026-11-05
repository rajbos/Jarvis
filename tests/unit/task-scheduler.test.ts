import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskScheduler, RESUME_STAGGER_MS } from '../../src/main/task-scheduler';
import { logger } from '../../src/services/logger';

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

  it('logs a warning when a task run fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const scheduler = new TaskScheduler();
    scheduler.register({ id: 'failing', label: 'Failing task', run: async () => { throw new Error('boom'); } });

    await scheduler.runNow('failing');

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[Tasks\] failing failed after \d+ms:$/), 'boom');
    warn.mockRestore();
  });

  it('does not log a warning when a task succeeds', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const scheduler = new TaskScheduler();
    scheduler.register({ id: 'ok', label: 'Ok task', run: async () => 1 });

    await scheduler.runNow('ok');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  describe('onResume', () => {
    it('runs overdue tasks staggered and keeps their interval afterwards', async () => {
      const a = vi.fn();
      const b = vi.fn();
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const scheduler = new TaskScheduler();
      scheduler.register({ id: 'a', label: 'A', intervalMs: 60_000, run: a });
      scheduler.register({ id: 'b', label: 'B', intervalMs: 60_000, run: b });
      scheduler.start();

      // Simulate sleep: wall clock jumps without the timers firing.
      vi.setSystemTime(Date.now() + 3 * 3600_000);
      scheduler.onResume();

      expect(info.mock.calls.some((c) => /Resume detected — 2 task\(s\)/.test(String(c[0])))).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RESUME_STAGGER_MS);
      expect(b).toHaveBeenCalledTimes(1);

      // Not double-fired, and the regular cadence resumes.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a).toHaveBeenCalledTimes(2);
      scheduler.stop();
    });

    it('does nothing for tasks that are not overdue or when stopped', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler();
      scheduler.register({ id: 'a', label: 'A', intervalMs: 60_000, run });
      scheduler.onResume();
      scheduler.start();
      scheduler.onResume();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).not.toHaveBeenCalled();
      scheduler.stop();
    });
  });
});
