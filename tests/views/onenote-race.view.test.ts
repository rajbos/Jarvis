/**
 * OneNote panels (issue #491): a slow response for a previous groupId / filePath
 * must not overwrite the data of the newer selection.
 */
import { describe, it, expect } from 'vitest';
import { useViewHarness } from './harness/view-harness';

declare global {
  interface Window {
    __pending: { cache: { resolve(v: unknown): void; reject(r: unknown): void }[]; section: { resolve(v: unknown): void; reject(r: unknown): void }[] };
  }
}

const harness = useViewHarness();

const cachePage = (title: string) => ({
  pages: [{
    relativePath: 'x.one', sectionName: 'Sec', pageIndex: 0, pageLevel: 0, pageTitle: title,
    pageLastModified: '', pageDate: '', readSource: 'com', cachedAt: '2026-01-01T00:00:00Z',
  }],
});
const section = (name: string) => ({
  ok: true,
  section: { sectionName: name, filePath: name, pageCount: 0, pages: [] },
});

describe('OneNote panels stale responses', () => {
  it('OneNoteCachePanel ignores an older group response that resolves last', async () => {
    const { page } = await harness.open('onenote-race');
    await page.getByRole('button', { name: 'Switch group' }).click();
    await expect.poll(() => page.evaluate(() => window.__pending.cache.length)).toBe(2);

    await page.evaluate((r) => window.__pending.cache[1].resolve(r), cachePage('NEW group 2 page'));
    await expect.poll(() => page.getByText('NEW group 2 page').count()).toBe(1);
    await page.evaluate((r) => window.__pending.cache[0].resolve(r), cachePage('STALE group 1 page'));
    await page.waitForTimeout(100);

    expect(await page.getByText('STALE group 1 page').count()).toBe(0);
    expect(await page.getByText('NEW group 2 page').count()).toBe(1);
  });

  it('OneNoteCachePanel does not clear loading or show errors from a stale rejection', async () => {
    const { page } = await harness.open('onenote-race');
    await page.getByRole('button', { name: 'Switch group' }).click();
    await expect.poll(() => page.evaluate(() => window.__pending.cache.length)).toBe(2);

    await page.evaluate(() => window.__pending.cache[0].reject('stale failure'));
    await page.waitForTimeout(100);
    expect(await page.getByText('stale failure').count()).toBe(0);
    expect(await page.getByText('Loading…').count()).toBeGreaterThan(0);
  });

  it('OneNoteSectionPanel ignores an older file response that resolves last', async () => {
    const { page } = await harness.open('onenote-race');
    await page.getByRole('button', { name: 'Switch file' }).click();
    await expect.poll(() => page.evaluate(() => window.__pending.section.length)).toBe(2);

    await page.evaluate((r) => window.__pending.section[1].resolve(r), section('NEW-section-b'));
    await expect.poll(() => page.getByText('NEW-section-b').count()).toBeGreaterThan(0);
    await page.evaluate((r) => window.__pending.section[0].resolve(r), section('STALE-section-a'));
    await page.waitForTimeout(100);

    expect(await page.getByText('STALE-section-a').count()).toBe(0);
    expect(await page.getByText('NEW-section-b').count()).toBeGreaterThan(0);
  });
});
