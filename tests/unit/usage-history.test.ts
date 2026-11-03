import { describe, it, expect, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';

vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));

import {
  attachUsageHistoryStore,
  detachUsageHistoryStore,
  queryUsageHistory,
  readUsageSamples,
  recordUsageSample,
  USAGE_HISTORY_RETENTION_MS,
} from '../../src/services/usage-history';
import { chartY, downsampleUsageHistory, historyBands, niceCeil } from '../../src/plugins/shared/usage-history-chart';

const MIN = 60 * 1000;
const sample = (at: number, series: Record<string, [number, number | null]>) => ({
  at,
  series: Object.fromEntries(Object.entries(series).map(([k, [value, limit]]) => [k, { value, limit }])),
});

describe('usage-history store', () => {
  afterEach(() => detachUsageHistoryStore());

  it('round-trips samples per metric, including series without a limit', async () => {
    const SQL = await initSqlJs();
    attachUsageHistoryStore(new SQL.Database());
    recordUsageSample('copilot', sample(1000, { credits: [120, null] }));
    recordUsageSample('claude', sample(2000, { five_hour: [42.5, 100], seven_day: [12, 100] }));
    expect(readUsageSamples('copilot', 0, 5000)).toEqual([sample(1000, { credits: [120, null] })]);
    expect(readUsageSamples('claude', 0, 5000)).toEqual([sample(2000, { five_hour: [42.5, 100], seven_day: [12, 100] })]);
  });

  it('is a no-op without a store and skips empty samples', async () => {
    recordUsageSample('claude', sample(1000, { five_hour: [1, 100] }));
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    attachUsageHistoryStore(db);
    recordUsageSample('claude', { at: 1000, series: {} });
    expect(db.exec('SELECT COUNT(*) FROM usage_samples')[0].values[0][0]).toBe(0);
  });

  it('drops samples past the retention window', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    attachUsageHistoryStore(db);
    const now = 2 * USAGE_HISTORY_RETENTION_MS;
    recordUsageSample('claude', sample(now - USAGE_HISTORY_RETENTION_MS - MIN, { five_hour: [1, 100] }));
    recordUsageSample('claude', sample(now, { five_hour: [2, 100] }));
    expect(db.exec('SELECT COUNT(*) FROM usage_samples')[0].values[0][0]).toBe(1);
  });

  it('reports how far back a metric goes', async () => {
    const SQL = await initSqlJs();
    attachUsageHistoryStore(new SQL.Database());
    recordUsageSample('claude', sample(10 * MIN, { five_hour: [5, 100] }));
    recordUsageSample('claude', sample(200 * MIN, { five_hour: [80, 100] }));
    const range = queryUsageHistory('claude', 60 * MIN, 210 * MIN);
    expect(range).toMatchObject({ metric: 'claude', sampleCount: 1, oldestAt: 10 * MIN, start: 150 * MIN, end: 210 * MIN });
    expect(range.high.five_hour).toEqual({ value: 80, limit: 100, at: 200 * MIN });
  });
});

describe('downsampleUsageHistory', () => {
  it('keeps the lowest and highest value per slot so dips survive zooming out', () => {
    const samples = [
      sample(1 * MIN, { core: [4000, 5000] }),
      sample(3 * MIN, { core: [100, 5000] }),
      sample(5 * MIN, { core: [4500, 5000] }),
      sample(40 * MIN, { core: [2000, 5000], graphql: [50, 5000] }),
    ];
    const { slots, low, high, slotMs } = downsampleUsageHistory(samples, 0, 60 * MIN, 6);
    expect(slotMs).toBe(10 * MIN);
    expect(slots).toEqual([
      { from: 0, to: 10 * MIN, series: { core: { min: 100, max: 4500, last: 4500, limit: 5000 } } },
      {
        from: 40 * MIN,
        to: 50 * MIN,
        series: { core: { min: 2000, max: 2000, last: 2000, limit: 5000 }, graphql: { min: 50, max: 50, last: 50, limit: 5000 } },
      },
    ]);
    expect(low.core).toEqual({ value: 100, limit: 5000, at: 3 * MIN });
    expect(high.core).toEqual({ value: 4500, limit: 5000, at: 5 * MIN });
    expect(low.graphql?.value).toBe(50);
  });

  it('ranks by share of the limit, so a lower limit can hold the low', () => {
    const { low } = downsampleUsageHistory([sample(MIN, { a: [100, 1000] }), sample(2 * MIN, { a: [50, 100] })], 0, 10 * MIN);
    expect(low.a.value).toBe(100);
  });

  it('never makes a slot shorter than one 2-minute poll', () => {
    expect(downsampleUsageHistory([], 0, 10 * MIN, 360).slotMs).toBe(2 * MIN);
  });
});

describe('historyBands', () => {
  const slot = (from: number, min: number, max: number, limit: number | null = 100) => ({
    from, to: from + 2 * MIN, series: { core: { min, max, last: max, limit } },
  });

  it('splits the line where no samples were recorded for a while', () => {
    const slots = [slot(0, 50, 100), slot(2 * MIN, 0, 50), slot(60 * MIN, 100, 100)];
    expect(historyBands(slots, 'core', 0, 100 * MIN, 100, 100, 2 * MIN)).toEqual([
      [{ x: 1, yMin: 50, yMax: 0, slotIndex: 0 }, { x: 3, yMin: 100, yMax: 50, slotIndex: 1 }],
      [{ x: 61, yMin: 0, yMax: 0, slotIndex: 2 }],
    ]);
    expect(historyBands(slots, 'graphql', 0, 100 * MIN, 100, 100, 2 * MIN)).toEqual([]);
  });

  it('scales series without a limit against the given axis maximum', () => {
    expect(historyBands([slot(0, 250, 500, null)], 'core', 0, 2 * MIN, 100, 100, 2 * MIN, 1000)[0][0]).toMatchObject({ yMin: 75, yMax: 50 });
    expect(chartY(2000, null, 100, 1000)).toBe(0);
  });
});

describe('niceCeil', () => {
  it('rounds up to a readable axis maximum', () => {
    expect([0, 7, 120, 250, 2600].map(niceCeil)).toEqual([1, 10, 200, 250, 5000]);
  });
});
