import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getAllDisplays: vi.fn(),
    getPrimaryDisplay: vi.fn(),
  },
}));

vi.mock('../../src/storage/database', () => ({
  saveDatabase: vi.fn(),
}));

import { ensureWindowBoundsVisible, type WindowBounds } from '../../src/main/windows';

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
