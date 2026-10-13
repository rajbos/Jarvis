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
});
