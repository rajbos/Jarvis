/**
 * Which browser the view harness tries first. Needs no browser itself; it lives
 * here because the harness is only type-checked and run with the view tests.
 */
import { describe, expect, it } from 'vitest';
import { browserChannels } from './harness/view-harness';

const BUNDLED_FIRST = [undefined, 'msedge', 'chrome'];

describe('browserChannels', () => {
  it('tries Edge first on a Windows dev machine', () => {
    expect(browserChannels('fast', { platform: 'win32', ci: false })).toEqual(['msedge', undefined, 'chrome']);
  });

  it('keeps bundled Chromium first in CI and on other platforms', () => {
    expect(browserChannels('fast', { platform: 'win32', ci: true })).toEqual(BUNDLED_FIRST);
    expect(browserChannels('fast', { platform: 'linux', ci: false })).toEqual(BUNDLED_FIRST);
  });

  it('keeps bundled Chromium first for screenshots everywhere', () => {
    expect(browserChannels('bundled', { platform: 'win32', ci: false })).toEqual(BUNDLED_FIRST);
  });
});
