/**
 * Main window (index.html) rendered in headless Chromium against the fake
 * window.jarvis API. Covers every top-level tab and the Setup tab's step panels.
 */
import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { useViewHarness, type OpenedView } from './harness/view-harness';
import {
  GROUP_ACME,
  GROUP_GLOBEX,
  ORG_ACME,
  ORG_GLOBEX,
  REPO_ROCKET,
} from './harness/fixtures';

const harness = useViewHarness();

function tab(page: Page, name: RegExp) {
  return page.locator('.tab-bar').getByRole('button', { name });
}

async function expectCleanRender(view: OpenedView): Promise<void> {
  expect(view.errors, 'page errors / console.error output').toEqual([]);
  expect(view.blockedRequests, 'requests that tried to leave the harness').toEqual([]);
}

describe('main window — tabs', () => {
  it('opens on the Repo Dashboard with the fixture repos and status bar', async () => {
    const view = await harness.open('index');
    const { page } = view;

    await expect.poll(() => page.locator('.dash-repo-name').allInnerTexts()).toEqual(
      expect.arrayContaining(['rocket-sled', 'anvil-api', 'hammock']),
    );
    await expect.poll(() => page.locator('body').innerText()).toContain('OAuth 4,321/5,000');
    expect(await view.calls('dashboardGetSummary')).toHaveLength(1);
    await expectCleanRender(view);
  });

  const tabs: Array<{ name: RegExp; expected: string[]; loadedBy: Parameters<OpenedView['calls']>[0] }> = [
    { name: /Groups Dashboard/, expected: [GROUP_ACME, GROUP_GLOBEX], loadedBy: 'groupsList' },
    { name: /Agent Sessions/, expected: ['Teach the rocket sled to brake'], loadedBy: 'getActiveSessions' },
    { name: /Browser/, expected: ['Browser Skills', 'Fixture weather check'], loadedBy: 'browserListSkills' },
    { name: /Setup/, expected: ['GitHub Account', 'Local Repositories', 'Groups', 'Ollama AI', 'Claude AI'], loadedBy: 'getGitHubOAuthStatus' },
    { name: /Dismissed/, expected: ['Auto-Dismissed Notifications', 'Bump fixture-lib from 0.9.0 to 1.0.0'], loadedBy: 'listAutoDismissLog' },
  ];

  for (const t of tabs) {
    it(`renders the ${t.name.source} tab`, async () => {
      const view = await harness.open('index');
      await tab(view.page, t.name).click();
      await expect.poll(() => view.page.locator('.tab-active').innerText()).toMatch(t.name);
      for (const text of t.expected) {
        await expect.poll(() => view.page.locator('.container').innerText(), { message: text }).toContain(text);
      }
      expect((await view.calls(t.loadedBy)).length).toBeGreaterThan(0);
      await expectCleanRender(view);
    });
  }

  it('expands a dashboard repo to show its notifications', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await page.locator('.dash-repo-summary', { hasText: 'rocket-sled' }).click();
    await expect.poll(() => page.locator('.dash-notif-title').allInnerTexts()).toContain('Add turbo boost to the sled launcher');
    expect((await view.calls('listNotificationsForRepo')).map((c) => c.args[0])).toContain(REPO_ROCKET);
    await expectCleanRender(view);
  });
});

describe('main window — Setup tab panels', () => {
  async function openSetup(opts?: Parameters<typeof harness.open>[1]) {
    const view = await harness.open('index', opts);
    await tab(view.page, /Setup/).click();
    return view;
  }

  it('drills from Repository Discovery into an org and its repos', async () => {
    const view = await openSetup();
    const { page } = view;
    await page.getByText('Repository Discovery').click();
    await expect.poll(() => page.locator('.container').innerText()).toContain(ORG_GLOBEX);
    await page.getByText(ORG_ACME, { exact: true }).first().click();
    await expect.poll(() => page.locator('.container').innerText()).toContain('anvil-api');
    expect((await view.calls('listReposForOrg')).map((c) => c.args[0])).toEqual([ORG_ACME]);
    await expectCleanRender(view);
  });

  it('opens the local repositories browser for the configured folder', async () => {
    const view = await openSetup();
    await view.page.locator('#local-repos-step').click();
    await expect.poll(() => view.page.locator('.container').innerText()).toContain(ORG_GLOBEX);
    expect(await view.calls('localListReposForFolder')).toHaveLength(1);
    await expectCleanRender(view);
  });

  it('lists scanned secrets', async () => {
    const view = await openSetup();
    await view.page.locator('.secrets-layout .step').click();
    await expect.poll(() => view.page.locator('.container').innerText()).toContain('FIXTURE_DEPLOY_KEY');
    await expectCleanRender(view);
  });

  it('opens the groups panel', async () => {
    const view = await openSetup();
    await view.page.locator('#groups-step').click();
    await expect.poll(() => view.page.locator('.groups-layout').innerText()).toContain(GROUP_GLOBEX);
    await expectCleanRender(view);
  });

  it('opens the Ollama panel with the available models', async () => {
    const view = await openSetup();
    await view.page.locator('#ollama-step').click();
    await expect.poll(() => view.page.locator('.container').innerText()).toContain('tiny-fixture:1b');
    await expectCleanRender(view);
  });

  it('opens the Claude panel and refreshes its usage', async () => {
    const view = await openSetup();
    await view.page.locator('#claude-step').click();
    await expect.poll(async () => (await view.calls('getClaudeRateLimit')).length).toBeGreaterThan(1);
    await expectCleanRender(view);
  });
});

describe('main window — driving the fake API', () => {
  it('shows the sign-in flow when GitHub is not connected', async () => {
    const view = await harness.open('index', {
      responses: {
        getGitHubOAuthStatus: { authenticated: false },
        startGitHubOAuth: { userCode: 'FAKE-CODE', verificationUri: 'https://example.invalid/device' },
      },
    });
    const { page } = view;
    await tab(page, /Setup/).click();
    await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
    await expect.poll(() => page.locator('.user-code').innerText()).toBe('FAKE-CODE');
    expect(await view.calls('startGitHubOAuth')).toHaveLength(1);
    await expectCleanRender(view);
  });

  it('shows an error banner with retry when an IPC call fails', async () => {
    const view = await harness.open('index', {
      responses: { listOrgs: { ok: false, error: 'fixture failure' } },
    });
    const { page } = view;
    await tab(page, /Setup/).click();
    await page.getByText('Repository Discovery').click();
    await expect.poll(() => page.locator('.container').innerText()).toContain('fixture failure');
    // The failure is logged on purpose by the view; only that line is expected.
    expect(view.errors.every((e) => e.includes('fixture failure'))).toBe(true);
  });

  it('reacts to push events from the main process', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await expect.poll(() => tab(page, /Agent Sessions/).innerText()).toContain('(1 ready)');

    const snapshot = await page.evaluate(() => window.jarvis.getActiveSessions());
    const delivered = await view.emit('onActiveSessionsUpdated', { ...snapshot, readyCount: 4 });
    expect(delivered).toBeGreaterThan(0);
    await expect.poll(() => tab(page, /Agent Sessions/).innerText()).toContain('(4 ready)');

    await view.emit('onBackgroundStatus', 'Fixture background job finished');
    await expect.poll(() => page.locator('body').innerText()).toContain('Fixture background job finished');
    await expectCleanRender(view);
  });
});
