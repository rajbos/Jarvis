/**
 * Renders every Jarvis window and main-window tab headless from the synthetic
 * fixtures and saves one PNG per view, so a renderer / CSS change can be looked
 * at without launching the app.
 *
 *   npm run screenshots                       → screenshots/<name>.png
 *   npm run screenshots -- -t agent-sessions  → only the views whose name matches
 *   JARVIS_SCREENSHOT_DIR=out npm run screenshots
 *
 * Output is deterministic: the fixture clock and the page clock are pinned, the
 * viewport is fixed, the locale/timezone are en-US/UTC and all CSS animations
 * and transitions are disabled (see `deterministic` in view-harness.ts).
 *
 * This file is run by vitest.screenshots.config.ts only — it is not part of
 * `npm run test:views`.
 */
import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { useViewHarness, type OpenViewOptions, type ViewName } from './harness/view-harness';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(ROOT, process.env.JARVIS_SCREENSHOT_DIR ?? 'screenshots');
/** Fixed clock: a Wednesday afternoon so relative dates ("Yesterday", "Mon") stay stable. */
const NOW = Date.UTC(2030, 0, 16, 14, 32, 0);
const VIEWPORT = { width: 1600, height: 900 };

interface Shot {
  /** Output file name (without .png) and the `-t` filter key. */
  name: string;
  view: ViewName;
  /** Main-window tab to click before capturing, matched against the tab bar buttons. */
  tab?: RegExp;
  /** Text that must be visible before the capture (proves the data loaded). */
  waitFor: string[];
  /** Extra steps after the tab is open (e.g. opening a Setup step). */
  prepare?: (page: Page) => Promise<void>;
  /** Capture the whole scrollable page instead of just the viewport. */
  fullPage?: boolean;
  open?: Omit<OpenViewOptions, 'now' | 'viewport' | 'deterministic'>;
}

const SHOTS: Shot[] = [
  { name: 'repo-dashboard', view: 'index', waitFor: ['rocket-sled', 'anvil-api', 'hammock'] },
  { name: 'groups-dashboard', view: 'index', tab: /Groups Dashboard/, waitFor: ['Acme Retainer', 'Globex Pilot'] },
  {
    name: 'agent-sessions', view: 'index', tab: /Agent Sessions/,
    waitFor: ['Teach the rocket sled to brake', 'Running 17/21', 'Failed 2/9', 'Not pushed', 'PR lookup failed', 'No PR yet'],
  },
  { name: 'browser', view: 'index', tab: /Browser/, waitFor: ['Browser Skills', 'Fixture weather check'] },
  { name: 'setup', view: 'index', tab: /Setup/, waitFor: ['GitHub Account', 'Local Repositories', 'Groups', 'Ollama AI', 'Claude AI'] },
  {
    name: 'setup-signed-out', view: 'index', tab: /Setup/, waitFor: ['Sign in with GitHub'],
    open: { responses: { getGitHubOAuthStatus: { authenticated: false } } },
  },
  { name: 'dismissed', view: 'index', tab: /Dismissed/, waitFor: ['Auto-Dismissed Notifications', 'Bump fixture-lib from 0.9.0 to 1.0.0'] },
  {
    name: 'copilot-flyout', view: 'index', waitFor: ['By model', '@test-user-work'],
    prepare: (page) => page.locator('.bg-status-copilot').hover(),
  },
  {
    name: 'copilot-raw-json', view: 'index', waitFor: ['raw API responses', 'GET /copilot_internal/user'],
    prepare: async (page) => {
      await page.locator('.bg-status-copilot').hover();
      await page.locator('.bg-status-copilot').getByRole('button', { name: 'Raw JSON' }).click();
    },
  },
  {
    name: 'pat-rate-limit-flyout', view: 'index', waitFor: ['PAT resets at', 'GraphQL % remaining'],
    prepare: (page) => page.locator('.bg-status-ratelimit').last().hover(),
  },
  { name: 'settings', view: 'settings', waitFor: ['Windows Startup', 'GitHub Accounts', 'MCP Server'], fullPage: true },
  { name: 'about', view: 'about', waitFor: ['9.9.9-fixture'] },
];

const harness = useViewHarness();

describe('view screenshots', () => {
  for (const shot of SHOTS) {
    it(shot.name, async () => {
      const view = await harness.open(shot.view, { ...shot.open, now: NOW, viewport: VIEWPORT, deterministic: true });
      const { page } = view;
      if (shot.tab) {
        await page.locator('.tab-bar').getByRole('button', { name: shot.tab }).click();
        await expect.poll(() => page.locator('.tab-active').innerText()).toMatch(shot.tab);
      }
      await shot.prepare?.(page);
      for (const text of shot.waitFor) {
        // Case-insensitive: several headings are upper-cased by CSS.
        await expect
          .poll(async () => (await page.locator('body').innerText()).toLowerCase(), { message: `waiting for "${text}"` })
          .toContain(text.toLowerCase());
      }
      // Let the last data-driven re-render and font loading settle.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);

      await mkdir(OUT_DIR, { recursive: true });
      const file = path.join(OUT_DIR, `${shot.name}.png`);
      await page.screenshot({ path: file, fullPage: shot.fullPage ?? false, animations: 'disabled', caret: 'hide' });
      console.log(`screenshot: ${file}`);

      expect(view.blockedRequests, 'requests that tried to leave the harness').toEqual([]);
      expect(view.errors, 'page errors / console.error output').toEqual([]);
    });
  }
});
