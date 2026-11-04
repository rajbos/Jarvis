import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  screen: {
    getAllDisplays: vi.fn(),
    getPrimaryDisplay: vi.fn(),
  },
}));

vi.mock('../../src/storage/database', () => ({
  saveDatabase: vi.fn(),
}));

import { shell } from 'electron';
import { attachExternalLinkHandler, ensureWindowBoundsVisible, type WindowBounds } from '../../src/main/windows';

const primaryDisplay = {
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

describe('ensureWindowBoundsVisible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps bounds that overlap a connected display', () => {
    const bounds: WindowBounds = { x: 100, y: 100, width: 600, height: 500 };

    expect(ensureWindowBoundsVisible(bounds, [primaryDisplay], primaryDisplay)).toBe(bounds);
  });

  it('moves partially visible bounds fully into the connected display', () => {
    const bounds: WindowBounds = { x: -500, y: -200, width: 600, height: 500 };

    expect(ensureWindowBoundsVisible(bounds, [primaryDisplay], primaryDisplay)).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 500,
    });
  });

  it('centers off-screen bounds on the primary display', () => {
    const bounds: WindowBounds = { x: 2200, y: 100, width: 600, height: 500 };

    expect(ensureWindowBoundsVisible(bounds, [primaryDisplay], primaryDisplay)).toEqual({
      x: 660,
      y: 270,
      width: 600,
      height: 500,
    });
  });

  it('fits an oversized off-screen window within the primary work area', () => {
    const bounds: WindowBounds = { x: -3000, y: 0, width: 2400, height: 1200 };

    expect(ensureWindowBoundsVisible(bounds, [primaryDisplay], primaryDisplay)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    });
  });
});

describe('attachExternalLinkHandler', () => {
  type Handler = (details: { url: string }) => { action: string };

  function attach(): Handler {
    let handler: Handler | undefined;
    const win = { webContents: { setWindowOpenHandler: vi.fn((h: Handler) => { handler = h; }) } };
    attachExternalLinkHandler(win as never);
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    return handler!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shell.openExternal).mockResolvedValue(undefined);
  });

  it.each(['https://github.com/login/device', 'http://example.com/a?b=c'])('opens %s externally and denies the window', (url) => {
    expect(attach()({ url })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vscode://file/foo',
    'ms-msdt:/id',
    'mailto:a@b.c',
    'about:blank',
    '',
    'not a url',
    '//example.com',
  ])('denies without opening %j', (url) => {
    expect(attach()({ url })).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('still denies when openExternal rejects', async () => {
    vi.mocked(shell.openExternal).mockRejectedValue(new Error('boom'));
    expect(attach()({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    await Promise.resolve();
  });
});
