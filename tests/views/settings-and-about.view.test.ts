/**
 * Settings (settings.html) and About (about.html) windows rendered in headless
 * Chromium against the fake window.jarvis API.
 */
import { describe, it, expect } from 'vitest';
import { useViewHarness, type OpenedView } from './harness/view-harness';
import { FIXTURE_USER } from './harness/fixtures';

const harness = useViewHarness();

async function expectCleanRender(view: OpenedView): Promise<void> {
  expect(view.errors, 'page errors / console.error output').toEqual([]);
  expect(view.blockedRequests, 'requests that tried to leave the harness').toEqual([]);
}

describe('settings window', () => {
  it('renders every settings section from the fake API', async () => {
    const view = await harness.open('settings');
    const body = view.page.locator('body');
    for (const text of [
      'Windows Startup',
      `@${FIXTURE_USER}`,
      'GitHub Accounts',
      '@test-user-work',
      '4,200 AI credits used this month of 5,000 budget',
      'GitHub Copilot AI Credits',
      'C:\\fixtures\\OneDrive - Acme Labs',
      'ruddr.io/app/fixture-workspace/',
      'MCP Server',
      'Repo Dashboard',
      'Notification Triage',
    ]) {
      await expect.poll(() => body.innerText(), { message: text }).toMatch(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
    await expectCleanRender(view);
  });

  it('saves the startup settings the user picked', async () => {
    const view = await harness.open('settings');
    const { page } = view;
    await page.getByLabel('Start Jarvis when I sign in to Windows').check();
    await page.getByRole('button', { name: 'Save Startup Settings' }).click();
    await expect.poll(async () => (await view.calls('setStartupSettings')).map((c) => c.args[0])).toEqual([
      { openAtLogin: true, startMinimized: false },
    ]);
    await expectCleanRender(view);
  });
});

describe('settings window — GitHub accounts', () => {
  it('shows each account with its usage and the owner → account mapping', async () => {
    const view = await harness.open('settings');
    const { page } = view;
    await expect.poll(() => page.locator('body').innerText()).toContain('acme-labs');
    await expect.poll(() => page.getByLabel('Account for acme-labs').inputValue()).toBe('test-user-work');
    await expectCleanRender(view);
  });

  it('lists a GHE.com account with its host and adds one with a PAT', async () => {
    const view = await harness.open('settings');
    const { page } = view;
    await expect.poll(() => page.locator('body').innerText()).toContain('fixture.ghe.com');
    await expect.poll(() => page.locator('body').innerText()).toContain('@fixture-bob');

    await page.getByLabel('GHE.com host').fill('new.ghe.com');
    await page.getByLabel('GHE.com personal access token').fill('fixture-token-not-real');
    await page.getByRole('button', { name: 'Add GHE.com account' }).click();
    await expect.poll(async () => (await view.calls('addGitHubHostAccount')).map((c) => c.args)).toEqual([
      ['new.ghe.com', 'fixture-token-not-real'],
    ]);
    await expectCleanRender(view);
  });

  it('adds another account through the device flow without replacing the primary', async () => {
    const view = await harness.open('settings');
    await view.page.getByRole('button', { name: 'Add GitHub account' }).click();
    await expect.poll(async () => (await view.calls('startGitHubOAuth')).map((c) => c.args[0])).toEqual([
      { additional: true },
    ]);
    await expectCleanRender(view);
  });

  it('saves a per-account Copilot budget', async () => {
    const view = await harness.open('settings');
    const input = view.page.getByLabel('Monthly Copilot budget for test-user-work');
    await input.fill('7500');
    await input.locator('xpath=following-sibling::button').click();
    await expect.poll(async () => (await view.calls('setGitHubAccountBudget')).map((c) => c.args)).toEqual([
      ['test-user-work', 7500],
    ]);
    await expectCleanRender(view);
  });
});

describe('about window', () => {
  it('shows the version and opens the repository link through the shell', async () => {
    const view = await harness.open('about');
    const { page } = view;
    await expect.poll(() => page.locator('body').innerText()).toContain('9.9.9-fixture');
    await page.getByText('Open the GitHub repository').click();
    await expect.poll(async () => (await view.calls('shellOpenUrl')).map((c) => c.args[0])).toEqual([
      'https://example.invalid/jarvis',
    ]);
    await expectCleanRender(view);
  });
});
