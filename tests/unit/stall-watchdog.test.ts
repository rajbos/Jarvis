import { describe, it, expect, vi, afterEach } from 'vitest';
import { startStallWatchdog, stopStallWatchdog } from '../../src/services/stall-watchdog';
import { logger } from '../../src/services/logger';

describe('stall watchdog', () => {
  afterEach(() => {
    stopStallWatchdog();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs a stall with context when the timer fires late', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    startStallWatchdog({ intervalMs: 100, thresholdMs: 1000, context: () => 'running tasks: a, b' });

    // Simulate a 5s synchronous block: the clock jumps before the next tick runs.
    vi.setSystemTime(Date.now() + 5000);
    vi.advanceTimersByTime(100);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/\[Stall\] main thread blocked for ~\d+ms.*running tasks: a, b/);
  });

  it('stays quiet when ticks are on time', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    startStallWatchdog({ intervalMs: 100, thresholdMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('calls onStall only for stalls at or above notifyThresholdMs', () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const onStall = vi.fn();
    startStallWatchdog({ intervalMs: 100, thresholdMs: 1000, notifyThresholdMs: 3000, context: () => 'ctx', onStall });

    vi.setSystemTime(Date.now() + 2000);
    vi.advanceTimersByTime(100);
    expect(onStall).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 5000);
    vi.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBeGreaterThanOrEqual(3000);
    expect(onStall.mock.calls[0][1]).toBe('ctx');
  });

  it('does not call onStall when ticks are on time', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    startStallWatchdog({ intervalMs: 100, thresholdMs: 1000, onStall });
    vi.advanceTimersByTime(2000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('treats a gap above maxPlausibleStallMs as a sleep, not a stall', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const onStall = vi.fn();
    startStallWatchdog({ intervalMs: 100, thresholdMs: 1000, maxPlausibleStallMs: 60_000, onStall });

    vi.setSystemTime(Date.now() + 8 * 3600_000);
    vi.advanceTimersByTime(100);

    expect(warn).not.toHaveBeenCalled();
    expect(onStall).not.toHaveBeenCalled();
    expect(info.mock.calls[0][0]).toMatch(/\[Power\] Resumed after ~480min sleep gap/);
  });

  it('still reports a stall just under maxPlausibleStallMs', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const onStall = vi.fn();
    startStallWatchdog({ intervalMs: 100, thresholdMs: 1000, maxPlausibleStallMs: 60_000, onStall });

    vi.setSystemTime(Date.now() + 50_000);
    vi.advanceTimersByTime(100);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
