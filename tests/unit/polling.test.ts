import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startPolling, type PollingEnv } from '../../src/plugins/shared/polling';

function fakeEnv() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number; due: number }>();
  const resume = new Set<() => void>();
  const visible = new Set<() => void>();
  const env: PollingEnv = {
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms, due: now + ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    now: () => now,
    onResume: (cb) => { resume.add(cb); return () => resume.delete(cb); },
    onVisible: (cb) => { visible.add(cb); return () => visible.delete(cb); },
  };
  return {
    env,
    /** Advance the clock; `sleeping` skips timer ticks like a suspended machine. */
    advance(ms: number, sleeping = false) {
      const end = now + ms;
      if (!sleeping) {
        for (;;) {
          const next = [...timers.values()].sort((a, b) => a.due - b.due)[0];
          if (!next || next.due > end) break;
          now = next.due;
          next.due += next.ms;
          next.fn();
        }
      } else {
        for (const t of timers.values()) t.due = end + t.ms;
      }
      now = end;
    },
    resume: () => [...resume].forEach((cb) => cb()),
    visible: () => [...visible].forEach((cb) => cb()),
    counts: () => ({ timers: timers.size, resume: resume.size, visible: visible.size }),
  };
}

describe('startPolling', () => {
  let f: ReturnType<typeof fakeEnv>;
  beforeEach(() => { f = fakeEnv(); });

  it('runs on the interval but not on start', () => {
    const run = vi.fn();
    startPolling(run, 1000, { env: f.env });
    expect(run).not.toHaveBeenCalled();
    f.advance(3000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('runs immediately when the system resumes from sleep', () => {
    const run = vi.fn();
    startPolling(run, 2 * 60 * 1000, { env: f.env });
    f.advance(3 * 60 * 60 * 1000, true);
    expect(run).not.toHaveBeenCalled();
    f.resume();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses onWake instead of run for wake refreshes', () => {
    const run = vi.fn();
    const onWake = vi.fn();
    startPolling(run, 1000, { env: f.env, onWake });
    f.resume();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('refreshes on becoming visible only when a tick is overdue', () => {
    const run = vi.fn();
    startPolling(run, 60_000, { env: f.env });
    f.advance(10_000);
    f.visible();
    expect(run).not.toHaveBeenCalled();
    f.advance(120_000, true);
    f.visible();
    expect(run).toHaveBeenCalledTimes(1);
    // A second visible right after the refresh is not stale any more.
    f.visible();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a resume refresh resets the staleness clock for visibility', () => {
    const run = vi.fn();
    startPolling(run, 60_000, { env: f.env });
    f.advance(120_000, true);
    f.resume();
    f.visible();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop clears the timer and both subscriptions', () => {
    const run = vi.fn();
    const stop = startPolling(run, 1000, { env: f.env });
    expect(f.counts()).toEqual({ timers: 1, resume: 1, visible: 1 });
    stop();
    expect(f.counts()).toEqual({ timers: 0, resume: 0, visible: 0 });
    f.advance(5000);
    f.resume();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps polling after a refresh throws or rejects', async () => {
    const run = vi.fn()
      .mockImplementationOnce(() => { throw new Error('boom'); })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    startPolling(run, 1000, { env: f.env });
    f.advance(3000);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
