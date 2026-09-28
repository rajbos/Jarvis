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
