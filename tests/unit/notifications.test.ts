import { describe, it, expect, vi, beforeEach } from 'vitest';

const { show, on, ctor, isSupported } = vi.hoisted(() => ({
  show: vi.fn(),
  on: vi.fn(),
  ctor: vi.fn(),
  isSupported: vi.fn(),
}));

vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn().mockImplementation(function (opts: unknown) { ctor(opts); return { show, on }; }),
    { isSupported },
  ),
}));
vi.mock('../../src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { showSafeNotification } from '../../src/services/notifications';
import { logger } from '../../src/services/logger';

describe('showSafeNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSupported.mockReturnValue(true);
  });

  it('shows the notification when supported', () => {
    expect(showSafeNotification('T', 'B')).toBe(true);
    expect(ctor).toHaveBeenCalledWith({ title: 'T', body: 'B' });
    expect(show).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
  });

  it('wires up the click handler', () => {
    const onClick = vi.fn();
    showSafeNotification('T', 'B', { onClick });
    expect(on).toHaveBeenCalledWith('click', onClick);
  });

  it('logs instead of showing when unsupported', () => {
    isSupported.mockReturnValue(false);
    expect(showSafeNotification('T', 'B', { tag: '[X]' })).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[X] T: B');
  });

  it('swallows errors from show() and warns', () => {
    show.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(showSafeNotification('T', 'B', { tag: '[X]' })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('[X] Could not show notification:', 'boom');
  });

  it('swallows errors from isSupported()', () => {
    isSupported.mockImplementationOnce(() => { throw new Error('no electron'); });
    expect(showSafeNotification('T', 'B')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});
