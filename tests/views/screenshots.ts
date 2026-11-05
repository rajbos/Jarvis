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
    name: 'setup-orgs', view: 'index', tab: /Setup/, waitFor: ['Organizations', '2 repos'],
    prepare: (page) => page.locator('.discovery-toggle').click(),
  },
  {
    name: 'setup-secrets', view: 'index', tab: /Setup/, waitFor: ['Repository Secrets', 'FIXTURE_DEPLOY_KEY'],
    prepare: (page) => page.locator('#secrets-step').click(),
  },
  {
    name: 'setup-signed-out', view: 'index', tab: /Setup/, waitFor: ['Sign in with GitHub'],
    open: { responses: { getGitHubOAuthStatus: { authenticated: false } } },
  },
  {
    name: 'setup-oauth-expired', view: 'index', tab: /Setup/, waitFor: ['Sign in again'],
    open: {
      responses: {
        getGitHubRateLimit: {
          oauth: { configured: true, resource: null, error: 'HTTP 401 — token expired or revoked', tokenExpired: true },
          pat: { configured: false, resource: null },
          fetchedAt: '2030-01-15T12:00:00.000Z',
        },
      },
    },
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
    // Running, failed and idle tasks, with the pointer on an idle task's Run button.
    name: 'background-tasks-flyout', view: 'index', waitFor: ['Fetch notifications'],
    open: {
      responses: {
        listBackgroundTasks: [
          { id: 'notifications', label: 'Fetch notifications', running: false, intervalMs: 900_000, lastStatus: 'success' },
          { id: 'ruddr-hours-discovery', label: 'Ruddr hours discovery', running: true, intervalMs: 600_000, lastStatus: 'failed' },
          {
            id: 'ruddr-project-refresh', label: 'Ruddr project refresh', running: false, intervalMs: 3_600_000,
            lastStatus: 'failed', lastError: '2030-01-14: Ruddr week page did not render within 25s (url https://www.ruddr.io/app/fixture-workspace/time/week)',
          },
        ],
      },
    },
    prepare: async (page) => {
      await page.locator('.bg-status-tasks').hover();
      await page.locator('.bg-status-task-run').first().hover();
    },
  },
  {
    name: 'pat-rate-limit-flyout', view: 'index', waitFor: ['PAT resets at', 'GraphQL % remaining'],
    prepare: (page) => page.locator('.bg-status-ratelimit').last().hover(),
  },
  {
    name: 'pat-rate-limit-history', view: 'index', waitFor: ['PAT rate-limit history', 'Lowest in range'],
    prepare: async (page) => {
      await page.locator('.bg-status-ratelimit .bg-status-rate-limit').last().click();
      await page.getByRole('button', { name: '7d' }).click();
      await page.locator('.bg-rlh-chart svg').hover({ position: { x: 560, y: 120 } });
    },
  },
  {
    name: 'claude-usage-history', view: 'index', waitFor: ['Claude usage history', 'Highest in range'],
    prepare: async (page) => {
      await page.locator('.bg-status-rate-limit', { hasText: /^Claude/ }).click();
      await page.getByRole('button', { name: '7d' }).click();
    },
  },
  {
    name: 'copilot-credits-history', view: 'index', waitFor: ['Copilot AI credits', 'Highest in range'],
    prepare: (page) => page.locator('.bg-status-copilot .bg-status-rate-limit').click(),
  },
  {
    // Agent analysis in flight: the chat panel shows the "stop analysis" control.
    name: 'agent-analysis-running', view: 'index', waitFor: ['Analysing acme/rocket-sled', 'stop analysis'],
    open: { responses: { getSelectedOllamaModel: 'fixture-model:3b' } },
    prepare: async (page) => {
      await page.evaluate(() => window.__jarvisTest.emit('onOpenChat'));
      // The chat panel mounts (and subscribes to the event) asynchronously after onOpenChat, so a single emit can
      // fire before anyone listens. Re-emit until the panel reacts; the handler resets its state, so it is idempotent.
      await expect.poll(async () => {
        await page.evaluate(() => {
          window.__jarvisTest.emit('onAgentSessionStarting', {
            sessionId: 42, agentName: 'Notification Triage', scopeType: 'repo', scopeValue: 'acme/rocket-sled',
            workflowRunCount: 3, workflowFilter: null, provider: 'ollama',
          });
        });
        return page.locator('.ec-agent-stop').count();
      }, { message: 'waiting for the chat panel to pick up the agent session' }).toBe(1);
    },
  },
  {
    // Failed update check handed to the chat: the badge opens a diagnostic card.
    name: 'update-diagnostic', view: 'index',
    waitFor: ['Update could not be verified', 'Explain this', 'Open log', 'Rejecting downloaded update'],
    open: {
      responses: {
        getSelectedOllamaModel: 'fixture-model:3b',
        getUpdateState: {
          status: 'error',
          error: 'New version 9.9.10 is not signed by the application owner: no build provenance attestation exists for this download',
          diagnostic: {
            id: 'updates-fixture',
            source: 'updates',
            title: 'Update check failed',
            summary: 'Jarvis downloaded the update but could not prove it was built by the official release workflow, so it was not installed. This protects against tampered releases; check that the release has a build provenance attestation.',
            facts: [
              { label: 'Cause', value: 'Update could not be verified' },
              { label: 'Installed version', value: '9.9.9' },
              { label: 'Update version', value: '9.9.10' },
              { label: 'Error code', value: 'ERR_UPDATER_INVALID_SIGNATURE' },
              { label: 'Error', value: 'New version 9.9.10 is not signed by the application owner: no build provenance attestation exists for this download' },
            ],
            logFilter: 'Update',
            links: [
              { label: 'Releases page', url: 'https://example.invalid/jarvis/releases' },
              { label: 'Release v9.9.10', url: 'https://example.invalid/jarvis/releases/tag/v9.9.10' },
            ],
            retry: 'update-check',
            occurredAt: '2030-01-16T14:30:00.000Z',
          },
        },
        getDiagnosticLogTail: [
          '2030-01-16T14:29:58.000Z [INFO] [AutoUpdater] Found version 9.9.10 (url: Jarvis-Setup-9.9.10.exe)',
          '2030-01-16T14:30:00.000Z [WARN] [Updates] Rejecting downloaded update: no build provenance attestation exists for this download',
          '2030-01-16T14:30:00.000Z [WARN] [Updates] Update check failed: Error: New version 9.9.10 is not signed by the application owner',
        ],
      },
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: /Update check failed/ }).click();
      await page.getByRole('button', { name: /Recent log lines/ }).click();
    },
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
