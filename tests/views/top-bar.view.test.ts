/**
 * Always-visible top-bar components of the main window (index.html): the repo
 * SearchBar and the UpdateButton, rendered headless against the fake window.jarvis.
 */
import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { useViewHarness, type OpenedView } from './harness/view-harness';
import { ORG_ACME, REPO_ROCKET } from './harness/fixtures';

const harness = useViewHarness();

async function expectCleanRender(view: OpenedView): Promise<void> {
  expect(view.errors, 'page errors / console.error output').toEqual([]);
  expect(view.blockedRequests, 'requests that tried to leave the harness').toEqual([]);
}

describe('top bar — Search bar', () => {
  const input = (page: Page) => page.locator('.search-wrap input');
  const results = (page: Page) => page.locator('.search-results');

  it('ignores queries shorter than two characters', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).fill('r');
    // Longer than the 200ms debounce, so a (wrongly) scheduled search would have fired.
    await page.waitForTimeout(400);
    expect(await view.calls('searchRepos')).toHaveLength(0);
    expect(await results(page).count()).toBe(0);
    await expectCleanRender(view);
  });

  it('debounces typing into a single search and lists the matching repo', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).pressSequentially('rocket', { delay: 20 });
    await expect.poll(() => page.locator('.search-result-item').count()).toBe(1);

    const item = page.locator('.search-result-item');
    expect(await item.locator('.sri-name').innerText()).toBe('rocket-sled');
    expect(await item.locator('.sri-org').innerText()).toBe(ORG_ACME);
    const calls = await view.calls('searchRepos');
    expect(calls.map((c) => c.args)).toEqual([['rocket']]);
    await expectCleanRender(view);
  });

  it('shows an empty state when nothing matches', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).fill('zzz-no-such-repo');
    await expect.poll(() => page.locator('.search-empty').innerText()).toBe('No repositories found');
    await expectCleanRender(view);
  });

  it('shows the failure message when the search returns an IPC error', async () => {
    const view = await harness.open('index', {
      responses: { searchRepos: { ok: false, error: 'fixture search failure' } },
    });
    const { page } = view;
    await input(page).fill('rocket');
    await expect.poll(() => page.locator('.search-empty').innerText()).toBe('Search failed: fixture search failure');
    expect(await page.locator('.search-result-item').count()).toBe(0);
    // The failure is logged on purpose by the component; only that line is expected.
    expect(view.errors.every((e) => e.includes('fixture search failure'))).toBe(true);
  });

  it('opens the repo on github.com when a result is clicked and closes the dropdown', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).fill('rocket');
    await page.locator('.search-result-item').click();
    await expect.poll(() => results(page).count()).toBe(0);
    const calls = await view.calls('openUrl');
    expect(calls.map((c) => c.args)).toEqual([[`https://github.com/${REPO_ROCKET}`]]);
    await expectCleanRender(view);
  });

  it('closes the dropdown and blurs the input on Escape', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).fill('rocket');
    await expect.poll(() => results(page).count()).toBe(1);
    await input(page).press('Escape');
    await expect.poll(() => results(page).count()).toBe(0);
    expect(await input(page).evaluate((el) => el === document.activeElement)).toBe(false);
    await expectCleanRender(view);
  });

  it('closes the dropdown on an outside click but not on a click inside', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).fill('rocket');
    await expect.poll(() => results(page).count()).toBe(1);
    await input(page).click();
    expect(await results(page).count()).toBe(1);
    await page.mouse.click(2, 2);
    await expect.poll(() => results(page).count()).toBe(0);
    await expectCleanRender(view);
  });

  it('clears the results when the query is shortened below two characters', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await input(page).fill('rocket');
    await expect.poll(() => results(page).count()).toBe(1);
    await input(page).fill('r');
    await expect.poll(() => results(page).count()).toBe(0);
    await expectCleanRender(view);
  });
});

describe('top bar — Update button', () => {
  const button = (page: Page) => page.locator('.update-btn');
  const diagnostic = {
    id: 'fixture-diagnostic',
    source: 'updates',
    title: 'Fixture update check failed',
    summary: 'The fixture update server could not be reached.',
    facts: [{ label: 'Fixture fact', value: 'fixture value' }],
    occurredAt: '2026-01-01T00:00:00.000Z',
  };

  it('shows "Up to date" for the default fixture state', async () => {
    const view = await harness.open('index');
    await expect.poll(() => button(view.page).innerText()).toBe('Up to date');
    expect(await button(view.page).getAttribute('class')).toContain('update-btn--progress');
    await expectCleanRender(view);
  });

  it('renders nothing while idle', async () => {
    const view = await harness.open('index', { responses: { getUpdateState: { status: 'idle' } } });
    // Wait for the initial state fetch before asserting absence.
    await expect.poll(async () => (await view.calls('getUpdateState')).length).toBeGreaterThan(0);
    expect(await button(view.page).count()).toBe(0);
    await expectCleanRender(view);
  });

  it('shows the checking state', async () => {
    const view = await harness.open('index', { responses: { getUpdateState: { status: 'checking' } } });
    await expect.poll(() => button(view.page).innerText()).toBe('Checking for updates…');
    await expectCleanRender(view);
  });

  it('shows download progress', async () => {
    const view = await harness.open('index', {
      responses: { getUpdateState: { status: 'downloading', version: '9.9.10', percent: 42 } },
    });
    await expect.poll(() => button(view.page).innerText()).toBe('Downloading 9.9.10… 42%');
    expect(await button(view.page).getAttribute('title')).toBe('Downloading Jarvis 9.9.10');
    await expectCleanRender(view);
  });

  it('installs a downloaded update when clicked', async () => {
    const view = await harness.open('index', {
      responses: { getUpdateState: { status: 'downloaded', version: '9.9.10' } },
    });
    const btn = button(view.page);
    await expect.poll(() => btn.innerText()).toBe('Update to 9.9.10');
    expect(await btn.getAttribute('class')).toContain('update-btn--ready');
    expect(await btn.getAttribute('title')).toBe('Restart Jarvis to install 9.9.10');
    await btn.click();
    expect(await view.calls('installUpdate')).toHaveLength(1);
    await expectCleanRender(view);
  });

  it('hands the diagnostic to the chat when the failed state is clicked', async () => {
    const view = await harness.open('index', {
      responses: { getUpdateState: { status: 'error', error: 'fixture update error', diagnostic } },
    });
    const { page } = view;
    const btn = button(page);
    await expect.poll(() => btn.innerText()).toBe('Update check failed — details');
    expect(await btn.getAttribute('class')).toContain('update-btn--error');
    expect(await btn.getAttribute('title')).toContain('fixture update error');

    await page.evaluate(() => {
      const w = window as unknown as { __shown: unknown[] };
      w.__shown = [];
      window.addEventListener('jarvis:show-diagnostic', (e) => w.__shown.push((e as CustomEvent).detail));
    });
    await btn.click();
    expect(await page.evaluate(() => (window as unknown as { __shown: unknown[] }).__shown)).toEqual([diagnostic]);
    await expectCleanRender(view);
  });

  it('follows update-state push events from the main process', async () => {
    const view = await harness.open('index');
    const { page } = view;
    await expect.poll(() => button(page).innerText()).toBe('Up to date');

    expect(await view.emit('onUpdateState', { status: 'downloading', version: '9.9.10', percent: 7 })).toBeGreaterThan(0);
    await expect.poll(() => button(page).innerText()).toBe('Downloading 9.9.10… 7%');

    await view.emit('onUpdateState', { status: 'downloaded', version: '9.9.10' });
    await expect.poll(() => button(page).innerText()).toBe('Update to 9.9.10');

    await view.emit('onUpdateState', { status: 'idle' });
    await expect.poll(() => button(page).count()).toBe(0);
    await expectCleanRender(view);
  });
});
