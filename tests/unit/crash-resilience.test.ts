import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));

import { attachCrashHandlers } from '../../src/main/windows';
import { logger } from '../../src/services/logger';
import { ErrorBoundary, describeError } from '../../src/plugins/shared/ErrorBoundary';

function fakeWindow() {
  const wcHandlers: Record<string, (...a: unknown[]) => void> = {};
  const winHandlers: Record<string, (...a: unknown[]) => void> = {};
  const win = {
    reload: vi.fn(),
    isDestroyed: () => false,
    on: (e: string, h: (...a: unknown[]) => void) => { winHandlers[e] = h; },
    webContents: { on: (e: string, h: (...a: unknown[]) => void) => { wcHandlers[e] = h; } },
  };
  return { win, wcHandlers, winHandlers };
}

describe('attachCrashHandlers', () => {
  it('logs and reloads after a renderer crash', () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { win, wcHandlers } = fakeWindow();
    attachCrashHandlers(win as never, 'main');
    wcHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 9 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('reason=crashed exitCode=9'));
    expect(win.reload).toHaveBeenCalledOnce();
  });

  it('does not reload after a clean exit or kill', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { win, wcHandlers } = fakeWindow();
    attachCrashHandlers(win as never, 'main');
    wcHandlers['render-process-gone']({}, { reason: 'clean-exit', exitCode: 0 });
    wcHandlers['render-process-gone']({}, { reason: 'killed', exitCode: 1 });
    expect(win.reload).not.toHaveBeenCalled();
  });

  it('logs unresponsive windows', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { win, winHandlers } = fakeWindow();
    attachCrashHandlers(win as never, 'about');
    winHandlers['unresponsive']();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('about'));
  });
});

describe('ErrorBoundary', () => {
  it('captures a thrown error into state', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('boom')).error?.message).toBe('boom');
    expect(ErrorBoundary.getDerivedStateFromError('str').error?.message).toBe('str');
  });

  it('renders a fallback alert when in the error state and children otherwise', () => {
    const b = new ErrorBoundary({ label: 'panel', children: 'ok' });
    expect(b.render()).toBe('ok');
    b.state = { error: new Error('boom') };
    const out = b.render() as { props: { role: string } };
    expect(out.props.role).toBe('alert');
  });

  it('logs only message and a truncated stack', () => {
    const e = new Error('x');
    e.stack = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    expect(describeError(e).split('\n')).toHaveLength(8);
    expect(describeError('plain')).toBe('plain');
  });
});
