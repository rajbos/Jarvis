import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutRegistry } from '../../src/plugins/shared/timeouts';

describe('TimeoutRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs the callback once after the delay and forgets the handle', () => {
    const reg = new TimeoutRegistry();
    const fn = vi.fn();
    reg.set('copied', fn, 1500);
    expect(reg.pending).toBe(1);
    vi.advanceTimersByTime(1499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reg.pending).toBe(0);
  });

  it('re-setting a key replaces the pending timer', () => {
    const reg = new TimeoutRegistry();
    const first = vi.fn();
    const second = vi.fn();
    reg.set('copied', first, 1500);
    vi.advanceTimersByTime(1000);
    reg.set('copied', second, 1500);
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs timers under different keys independently', () => {
    const reg = new TimeoutRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.set('dismiss:a', a, 260);
    reg.set('dismiss:b', b, 260);
    vi.advanceTimersByTime(260);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('clear() cancels one key only', () => {
    const reg = new TimeoutRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.set('a', a, 100);
    reg.set('b', b, 100);
    reg.clear('a');
    reg.clear('missing');
    vi.advanceTimersByTime(100);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels everything and ignores later set() calls', () => {
    const reg = new TimeoutRegistry();
    const pending = vi.fn();
    const late = vi.fn();
    reg.set('reload', pending, 2000);
    reg.dispose();
    expect(reg.pending).toBe(0);
    // e.g. an async click handler that resumes after the component unmounted
    reg.set('copied', late, 1500);
    vi.advanceTimersByTime(5000);
    expect(pending).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(reg.pending).toBe(0);
  });
});
