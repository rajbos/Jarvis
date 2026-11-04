import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const windows: any[] = [];
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  return { windows, display };
});

vi.mock('electron', () => {
  const BrowserWindow = vi.fn(function (this: any, opts: any) {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const wcHandlers: Record<string, (...a: any[]) => void> = {};
    Object.assign(this, {
      opts,
      handlers,
      wcHandlers,
      loadFile: vi.fn(),
      reload: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
      setBounds: vi.fn(),
      on: vi.fn((e: string, cb: any) => { handlers[e] = cb; }),
      once: vi.fn((e: string, cb: any) => { handlers[e] = cb; }),
      webContents: {
        on: vi.fn((e: string, cb: any) => { wcHandlers[e] = cb; }),
        setWindowOpenHandler: vi.fn(),
      },
    });
    h.windows.push(this);
  });
  return {
    BrowserWindow,
    nativeImage: { createFromPath: vi.fn(() => ({})) },
    screen: {
      getAllDisplays: vi.fn(() => [h.display]),
      getPrimaryDisplay: vi.fn(() => h.display),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
  };
});

vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));
vi.mock('../../src/services/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../src/main/freeze-diagnostics', () => ({
  UNRESPONSIVE_NOTIFY_THRESHOLD_MS: 5000,
  buildUnresponsiveDiagnostic: vi.fn((name: string, ms: number) => ({ name, ms })),
  reportFreeze: vi.fn(),
}));

import {
  createAboutWindow,
  createOnboardingWindow,
  createSettingsWindow,
} from '../../src/main/windows';
import { reportFreeze } from '../../src/main/freeze-diagnostics';

/** Minimal config-table stand-in keyed by the bound key. */
function fakeDb(initial: Record<string, string> = {}) {
  const store = { ...initial };
  const db = {
    store,
    prepare: vi.fn(() => {
      let key = '';
      return {
        bind: (p: string[]) => { key = p[0]; },
        step: () => key in store,
        getAsObject: () => ({ value: store[key] }),
        free: vi.fn(),
      };
    }),
    run: vi.fn((_sql: string, params: string[]) => { store[params[0]] = params[1]; }),
  };
  return db as any;
}

const last = () => h.windows[h.windows.length - 1];

beforeEach(() => {
  h.windows.length = 0;
  vi.clearAllMocks();
});

describe('createOnboardingWindow', () => {
  it('applies saved bounds from window_bounds', () => {
    const saved = { x: 100, y: 100, width: 700, height: 500 };
    createOnboardingWindow(fakeDb({ window_bounds: JSON.stringify(saved) }));
    expect(last().opts).toMatchObject(saved);
  });

  it('persists bounds on resized/moved', () => {
    const db = fakeDb();
    createOnboardingWindow(db);
    last().handlers.moved();
    expect(JSON.parse(db.store.window_bounds)).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });
});

describe('createSettingsWindow', () => {
  it('defaults to 1040x700 without saved bounds', () => {
    createSettingsWindow(fakeDb());
    expect(last().opts).toMatchObject({ width: 1040, height: 700 });
  });

  it('restores saved bounds from settings_bounds, independent of window_bounds', () => {
    const saved = { x: 50, y: 60, width: 900, height: 650 };
    createSettingsWindow(fakeDb({
      settings_bounds: JSON.stringify(saved),
      window_bounds: JSON.stringify({ x: 0, y: 0, width: 600, height: 500 }),
    }));
    expect(last().opts).toMatchObject(saved);
  });

  it('recenters saved bounds that are off-screen', () => {
    createSettingsWindow(fakeDb({ settings_bounds: JSON.stringify({ x: 5000, y: 5000, width: 900, height: 650 }) }));
    expect(last().opts).toMatchObject({ x: 510, y: 195, width: 900, height: 650 });
  });

  it('writes settings_bounds without touching window_bounds', () => {
    const db = fakeDb();
    createSettingsWindow(db);
    last().handlers.resized();
    expect(db.store.settings_bounds).toBeDefined();
    expect(db.store.window_bounds).toBeUndefined();
  });

  it('works without a db (no persistence)', () => {
    expect(() => createSettingsWindow()).not.toThrow();
    expect(last().handlers.resized).toBeUndefined();
  });
});

describe('will-navigate guard', () => {
  it.each([
    ['onboarding', () => createOnboardingWindow(fakeDb())],
    ['settings', () => createSettingsWindow(fakeDb())],
    ['about', () => createAboutWindow()],
  ])('%s window blocks external URLs but allows file://', (_n, create) => {
    create();
    const block = { preventDefault: vi.fn() };
    last().wcHandlers['will-navigate'](block, 'https://example.com');
    expect(block.preventDefault).toHaveBeenCalled();
    const allow = { preventDefault: vi.fn() };
    last().wcHandlers['will-navigate'](allow, 'file:///x/index.html');
    expect(allow.preventDefault).not.toHaveBeenCalled();
  });
});

describe('attachCrashHandlers', () => {
  it('reloads on a crash but not on clean-exit or killed', () => {
    createAboutWindow();
    const win = last();
    win.wcHandlers['render-process-gone']({}, { reason: 'killed', exitCode: 1 });
    win.wcHandlers['render-process-gone']({}, { reason: 'clean-exit', exitCode: 0 });
    expect(win.reload).not.toHaveBeenCalled();
    win.wcHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 9 });
    expect(win.reload).toHaveBeenCalledTimes(1);
  });

  it('reports a freeze only when it lasted past the threshold', () => {
    vi.useFakeTimers();
    try {
      createAboutWindow();
      const win = last();
      win.handlers.unresponsive();
      vi.advanceTimersByTime(1000);
      win.handlers.responsive();
      expect(reportFreeze).not.toHaveBeenCalled();
      win.handlers.unresponsive();
      vi.advanceTimersByTime(6000);
      win.handlers.responsive();
      expect(reportFreeze).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

