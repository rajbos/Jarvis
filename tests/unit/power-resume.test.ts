import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  APP_RESUMED_CHANNEL,
  notifyRenderersOfResume,
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

describe('notifyRenderersOfResume', () => {
  it('sends app:resumed to every window through the given sender', () => {
    const send = vi.fn();
    notifyRenderersOfResume(['main', 'settings'], send);
    expect(APP_RESUMED_CHANNEL).toBe('app:resumed');
    expect(send.mock.calls).toEqual([['main', 'app:resumed'], ['settings', 'app:resumed']]);
  });

  it('keeps notifying the rest when one send throws', () => {
    const send = vi.fn((win: string) => { if (win === 'broken') throw new Error('disposed'); });
    expect(() => notifyRenderersOfResume(['broken', 'next'], send)).not.toThrow();
    expect(send).toHaveBeenLastCalledWith('next', 'app:resumed');
  });
});
