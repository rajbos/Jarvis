import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  registerPowerResumeHandler,
  resetPowerResumeHandlerForTests,
  RESUME_DEBOUNCE_MS,
} from '../../src/main/power-resume';

describe('registerPowerResumeHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    resetPowerResumeHandlerForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('registers the resume listener exactly once, even if called twice', () => {
    const monitor = new EventEmitter();
    const on = vi.spyOn(monitor, 'on');
    registerPowerResumeHandler(monitor, vi.fn());
    registerPowerResumeHandler(monitor, vi.fn());
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith('resume', expect.any(Function));
  });

  it('invokes the callback on resume and debounces rapid repeats', () => {
    const monitor = new EventEmitter();
    const cb = vi.fn();
    registerPowerResumeHandler(monitor, cb);

    monitor.emit('resume');
    monitor.emit('resume');
    expect(cb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS + 1);
    monitor.emit('resume');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('survives a throwing callback', () => {
    const monitor = new EventEmitter();
    registerPowerResumeHandler(monitor, () => { throw new Error('boom'); });
    expect(() => monitor.emit('resume')).not.toThrow();
  });
});
