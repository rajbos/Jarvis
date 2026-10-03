/**
 * Main window (index.html) rendered in headless Chromium against the fake
 * window.jarvis API. Covers every top-level tab and the Setup tab's step panels.
 */
import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import type { CopilotUsage, GitHubAccountInfo, GitHubAccountUsage } from '../../src/plugins/types';
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

describe('main window — Copilot flyout', () => {
  it('stacks the other accounts below the primary one', async () => {
    const view = await harness.open('index');
    const flyout = view.page.locator('.bg-status-copilot .bg-status-claude-pop');
    await expect.poll(() => flyout.textContent()).toContain('@test-user-work');

    const text = (await flyout.textContent()) ?? '';
    // Primary first, then the other accounts with their own usage and budget.
    expect(text.indexOf('@test-user')).toBeLessThan(text.indexOf('@test-user-work'));
    expect(text).toContain('4,200 / 5,000 AIC');
    expect(text).toContain('@fixture-bob');
    expect(text).toContain('fixture.ghe.com');
    // The badge says how many more accounts it covers.
    expect(await view.page.locator('.bg-status-copilot .bg-status-rate-limit').innerText()).toContain('+2');
    await expectCleanRender(view);
  });

  it('keeps the single-account flyout unchanged when there are no other accounts', async () => {
    const view = await harness.open('index', { responses: { getGitHubAccountsUsage: { ok: true, usage: [] } } });
    const flyout = view.page.locator('.bg-status-copilot .bg-status-claude-pop');
    await expect.poll(() => flyout.textContent()).toContain('AIC');
    expect(await flyout.textContent()).not.toContain('@');
    expect(await view.page.locator('.bg-status-copilot .bg-status-rate-limit').innerText()).not.toContain('+');
    await expectCleanRender(view);
  });
});

/** A tracked account plus a usage result for it, shaped like `getGitHubAccountsUsage` entries. */
function accountUsage(
  login: string,
  usage: Partial<CopilotUsage>,
  account: Partial<GitHubAccountInfo> = {},
): GitHubAccountUsage {
  const d = new Date();
  return {
    account: {
      id: login, host: 'github.com', login, avatarUrl: null, isPrimary: false, sources: ['gh-cli'], ghActive: false, ...account,
    },
    usage: {
      configured: true, source: 'gh-cli', login, plan: 'business', entitlementCredits: 1000,
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, resetsAt: Math.floor(Date.now() / 1000) + 86_400 * 10,
      creditsUsed: 100, includedCreditsUsed: 100, billedCredits: 0, billedAmountUsd: 0, byModel: [],
      budgetCredits: null, projectedCredits: null, fetchedAt: d.toISOString(),
      ...usage,
    },
  };
}

describe('main window — Copilot flyout content', () => {
  async function openFlyout(others: GitHubAccountUsage[]) {
    const view = await harness.open('index', { responses: { getGitHubAccountsUsage: { ok: true, usage: others } } });
    const flyout = view.page.locator('.bg-status-copilot .bg-status-claude-pop');
    const badge = view.page.locator('.bg-status-copilot .bg-status-rate-limit');
    return { view, flyout, badge };
  }
  const headers = (flyout: ReturnType<Page['locator']>) => flyout.locator('.bg-status-claude-account-head').allInnerTexts();

  it('lists every account once, primary first', async () => {
    const { view, flyout } = await openFlyout([
      accountUsage('work-account', {}),
      accountUsage('guest-account', {}),
    ]);
    await expect.poll(async () => (await headers(flyout)).length).toBe(3);
    expect((await headers(flyout)).map((h) => h.trim())).toEqual(['@test-user', '@work-account', '@guest-account']);
    await expectCleanRender(view);
  });

  it('does not repeat the account the main block already shows', async () => {
    // Same login, different case and as a "other" entry: must not be stacked a second time.
    const { view, flyout, badge } = await openFlyout([
      accountUsage('Test-User', {}),
      accountUsage('work-account', {}),
    ]);
    await expect.poll(async () => (await headers(flyout)).length).toBe(2);
    expect((await headers(flyout)).map((h) => h.trim())).toEqual(['@test-user', '@work-account']);
    expect(await badge.innerText()).toContain('+1');
    await expectCleanRender(view);
  });

  it('leaves out accounts without credentials', async () => {
    const { flyout, badge } = await openFlyout([
      accountUsage('no-credentials', { configured: false }),
      accountUsage('work-account', {}),
    ]);
    await expect.poll(() => flyout.textContent()).toContain('@work-account');
    expect(await flyout.textContent()).not.toContain('no-credentials');
    expect(await badge.innerText()).toContain('+1');
  });

  it('shows each account its own numbers: usage, budget left, plan and projection', async () => {
    const { flyout } = await openFlyout([
      accountUsage('work-account', {
        plan: 'enterprise', entitlementCredits: 175_000, creditsUsed: 4_200, includedCreditsUsed: 4_200,
        budgetCredits: 5_000, projectedCredits: 6_300,
      }),
    ]);
    const block = flyout.locator('.bg-status-claude-account').first();
    await expect.poll(() => block.textContent()).toContain('@work-account');
    const text = (await block.textContent()) ?? '';
    expect(text).toContain('4,200 / 5,000 AIC · 84%'); // the budget is the ceiling
    expect(text).toContain('800 AIC left'); // 5,000 - 4,200
    expect(text).toContain('4,200 / 175,000 AIC'); // included vs the plan
    expect(text).toContain('170,800 left on enterprise');
    expect(text).toContain('6,300 AIC'); // projection
    // The primary's numbers must not leak into this block.
    expect(text).not.toContain('120');
  });

  it('colours each account by its own level and the badge by the worst one', async () => {
    const { flyout, badge } = await openFlyout([
      accountUsage('over-budget', { creditsUsed: 1_200, includedCreditsUsed: 1_000, billedCredits: 200, budgetCredits: 1_000 }),
      accountUsage('fine', { creditsUsed: 10 }),
    ]);
    const over = flyout.locator('.bg-status-claude-account', { hasText: '@over-budget' });
    const fine = flyout.locator('.bg-status-claude-account', { hasText: '@fine' });
    await expect.poll(() => over.locator('.bg-status-claude-state--limited').count()).toBe(1);
    expect(await fine.locator('.bg-status-claude-state--available').count()).toBe(1);
    // Red: the worst account decides, although the primary itself is healthy.
    expect(await badge.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(244, 67, 54)');
  });

  it('shows a failing account as such without hiding the others', async () => {
    const { flyout } = await openFlyout([
      accountUsage('broken', { error: 'HTTP 403: nope', creditsUsed: 0 }),
      accountUsage('work-account', { creditsUsed: 55 }),
    ]);
    const broken = flyout.locator('.bg-status-claude-account', { hasText: '@broken' });
    await expect.poll(() => broken.textContent()).toContain('Check failed: HTTP 403: nope');
    expect(await broken.textContent()).toContain('No data');
    expect(await flyout.locator('.bg-status-claude-account', { hasText: '@work-account' }).textContent()).toContain('55 / 1,000 AIC');
  });

  it('names the host of accounts that are not on github.com', async () => {
    const { flyout } = await openFlyout([
      accountUsage('bob', {}, { id: 'bob@corp.ghe.com', host: 'corp.ghe.com', sources: ['pat'] }),
      accountUsage('work-account', {}),
    ]);
    const ghe = flyout.locator('.bg-status-claude-account', { hasText: '@bob' });
    await expect.poll(() => ghe.textContent()).toContain('corp.ghe.com');
    expect(await flyout.locator('.bg-status-claude-account', { hasText: '@work-account' }).textContent()).not.toContain('.ghe.com');
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

  it('filters Agent Sessions by source pill', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await tab(page, /Agent Sessions/).click();
    const pills = page.locator('.as-pills');
    const row = page.getByText('Teach the rocket sled to brake');
    await expect.poll(() => row.count()).toBe(1);

    await pills.getByRole('button', { name: /Claude local/ }).click();
    await expect.poll(() => row.count()).toBe(0);
    await expect.poll(() => page.locator('body').innerText()).toContain('No sessions from this source right now.');

    await pills.getByRole('button', { name: /Copilot cloud/ }).click();
    await expect.poll(() => row.count()).toBe(1);
    expect(await pills.getByRole('button', { name: /Copilot cloud/ }).getAttribute('aria-pressed')).toBe('true');

    // Clicking the active pill again clears the filter.
    await pills.getByRole('button', { name: /Copilot cloud/ }).click();
    expect(await pills.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
    await expectCleanRender(view);
  });

  it('reacts to push events from the main process', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await expect.poll(() => tab(page, /Agent Sessions/).locator('.tab-badge').innerText()).toBe('1');

    const snapshot = await page.evaluate(() => window.jarvis.getActiveSessions());
    const delivered = await view.emit('onActiveSessionsUpdated', { ...snapshot, readyCount: 4 });
    expect(delivered).toBeGreaterThan(0);
    await expect.poll(() => tab(page, /Agent Sessions/).locator('.tab-badge').innerText()).toBe('4');

    await view.emit('onBackgroundStatus', 'Fixture background job finished');
    await expect.poll(() => page.locator('body').innerText()).toContain('Fixture background job finished');
    await expectCleanRender(view);
  });
});
