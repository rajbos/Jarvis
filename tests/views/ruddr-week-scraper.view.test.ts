/**
 * Runs the browser extension's in-page Ruddr week reader (readRuddrWeek in
 * src/browser-extension/background.js) in headless Chromium against a
 * synthetic copy of Ruddr's /time/week page, polling it the way the
 * extension's service worker does, then feeds the result through the same
 * parser the main process uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { launchBrowser } from './harness/view-harness';
import { parseWeekScrape } from '../../src/services/ruddr-hours';
import type { RuddrWeekScrape } from '../../src/services/ruddr-hours';

const FIXTURE = path.resolve(__dirname, 'fixtures/ruddr-week.html');

type Snapshot = RuddrWeekScrape & { inputCount: number; hasValues: boolean; expectsHours: boolean };

/** The reader's source, cut out of background.js so it runs exactly as shipped. */
function readerSource(): string {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/browser-extension/background.js'), 'utf-8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function readRuddrWeek(');
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('readRuddrWeek not found in background.js');
  return src.slice(start, end + 2);
}

describe('Ruddr week scraper', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
    // The first page of a cold browser can take many seconds; pay that here,
    // under the hook timeout, instead of inside the first test.
    const warm = await browser.newPage();
    await warm.goto(pathToFileURL(FIXTURE).href);
    await warm.close();
  });
  afterAll(async () => { await browser?.close(); });

  async function scrape(date: string, waitMs = 5000): Promise<RuddrWeekScrape> {
    const page = await browser.newPage();
    try {
      await page.goto(pathToFileURL(FIXTURE).href);
      // Same stop rule as cmdScrapeRuddrWeek: ready, row count stable for two
      // polls, and a filled-in cell when the header shows hours.
      const call = `(${readerSource()})(${JSON.stringify(date)})`;
      const deadline = Date.now() + waitMs;
      let snapshot = await page.evaluate(call) as Snapshot;
      let lastCount = -1;
      let stableFor = 0;
      while (Date.now() < deadline) {
        if (snapshot.ready) {
          stableFor = snapshot.inputCount === lastCount ? stableFor + 1 : 0;
          lastCount = snapshot.inputCount;
          if (stableFor >= 2 && (!snapshot.expectsHours || snapshot.hasValues)) break;
        }
        await new Promise((r) => setTimeout(r, 400));
        snapshot = await page.evaluate(call) as Snapshot;
      }
      return snapshot;
    } finally {
      await page.close();
    }
  }

  it('reads every row once the late-rendered grid appears', async () => {
    const result = await scrape('2026-10-05');

    expect(result.ready).toBe(true);
    expect(result.days.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(result.days[3]).toEqual({ day: 'Thu', date: '2026-10-08', total: '8:00' });
    expect(result.totalHours).toBe('19,00');
    expect(result.billableTypes).toEqual({ billable: '8,00', non_billable: '0,00', internal: '11,00', time_off: '0,00' });
    expect(result.approval).toEqual({ approved: '19,00' });
    expect(result.memberId).toBe('00000000-0000-0000-0000-000000000001');

    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      clientName: 'Acme Corp',
      projectName: 'Acme | Copilot Rollout',
      projectPath: '/app/fixture-ws/portfolio/projects/acme-corp/acme-copilot-rollout',
      taskName: null,
      hours: { Mon: '', Thu: '8:00', Sun: '' },
    });
    // Allocation placeholders are not logged time.
    expect(Object.values(result.rows[1].hours).every((v) => v === '')).toBe(true);
    expect(result.rows[2]).toMatchObject({
      taskName: 'Pre-sales',
      taskPath: '/app/fixture-ws/portfolio/projects/internal/internal-work/tasks/23/details',
      hours: { Mon: '1:00', Tue: '4:00', Wed: '3:00' },
    });
  });

  it('produces a week the main process accepts', async () => {
    const parsed = parseWeekScrape('2026-10-05', await scrape('2026-10-05'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.week.totalMinutes).toBe(19 * 60);
    expect(parsed.week.entries).toHaveLength(6);
  });

  it('reports not ready when the page shows another week', async () => {
    const result = await scrape('2026-10-12', 800);
    expect(result.ready).toBe(false);
    expect(parseWeekScrape('2026-10-12', result)).toEqual({ ok: false, error: 'page_not_ready' });
  });
});
