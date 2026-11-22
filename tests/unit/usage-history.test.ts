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
import {
  chartY,
  downsampleUsageHistory,
  fitAxisDomain,
  historyAxisScale,
  historyBands,
  limitPercentSuffix,
  niceCeil,
  sparklineScale,
} from '../../src/plugins/shared/usage-history-chart';

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
    expect(historyBands([slot(0, 250, 500, null)], 'core', 0, 2 * MIN, 100, 100, 2 * MIN, { min: 0, max: 1000 })[0][0]).toMatchObject({ yMin: 75, yMax: 50 });
    expect(chartY(2000, null, 100, { min: 0, max: 1000 })).toBe(0);
  });
});

describe('niceCeil', () => {
  it('rounds up to a readable axis maximum', () => {
    expect([0, 7, 120, 250, 2600].map(niceCeil)).toEqual([1, 10, 200, 250, 5000]);
  });
});

describe('fitAxisDomain', () => {
  it('starts at 0 with headroom when the data spans a wide range', () => {
    expect(fitAxisDomain(0, 550)).toEqual({ min: 0, max: 600 });
  });
  it('zooms in on a narrow high band', () => {
    const d = fitAxisDomain(1200, 1348);
    expect(d.min).toBeGreaterThan(900);
    expect(d.max).toBeGreaterThanOrEqual(1348);
    expect(d.max - d.min).toBeLessThan(600);
  });
  it('handles empty data', () => {
    expect(fitAxisDomain(0, 0)).toEqual({ min: 0, max: 1 });
  });
  it('falls back for negative and non-finite input instead of returning an axis that misses the data', () => {
    expect(fitAxisDomain(-5, -1)).toEqual({ min: 0, max: 1 });
    expect(fitAxisDomain(Number.NaN, 5)).toEqual({ min: 0, max: 1 });
    expect(fitAxisDomain(5, Number.POSITIVE_INFINITY)).toEqual({ min: 0, max: 1 });
    expect(fitAxisDomain(-5, 100).min).toBe(0);
  });
  it('does not zoom a flat series', () => {
    const d = fitAxisDomain(500, 500);
    expect(d.min).toBe(0);
    expect(d.max).toBeGreaterThanOrEqual(500);
  });
  it('always contains the data and uses 4 equal round intervals', () => {
    for (const [lo, hi] of [[1200, 1348], [0, 550], [3, 9], [95, 100], [0.2, 0.9], [5, 5.4]] as const) {
      const d = fitAxisDomain(lo, hi);
      expect(d.min).toBeLessThanOrEqual(lo);
      expect(d.max).toBeGreaterThanOrEqual(hi);
      const step = (d.max - d.min) / 4;
      const mantissa = Number((step / 10 ** Math.floor(Math.log10(step))).toPrecision(6));
      expect([1, 1.5, 2, 2.5, 3, 4, 5, 10]).toContain(mantissa);
    }
  });
  it('returns tick values without floating-point residue', () => {
    const d = fitAxisDomain(5, 5.4);
    expect([d.min, d.max]).toEqual([Number(d.min.toPrecision(12)), Number(d.max.toPrecision(12))]);
    expect(String(d.min).length).toBeLessThan(8);
    expect(String(d.max).length).toBeLessThan(8);
  });
  it('maps values through a floored domain', () => {
    expect(chartY(150, null, 100, { min: 100, max: 200 })).toBe(50);
  });
});

type SlotSeries = Record<string, [min: number, max: number, limit: number | null]>;
const slot = (from: number, series: SlotSeries) => ({
  from,
  to: from + MIN,
  series: Object.fromEntries(Object.entries(series).map(([k, [min, max, limit]]) => [k, { min, max, last: max, limit }])),
});

describe('historyAxisScale', () => {
  const limited = [slot(0, { a: [10, 20, 100], b: [40, 60, 100] }), slot(MIN, { a: [20, 30, 100], b: [50, 80, 100] })];
  const mixed = [slot(0, { credits: [100, 140, null], quota: [10, 20, 300] }), slot(MIN, { credits: [140, 180, null], quota: [20, 25, 300] })];

  it('keeps the share-of-limit axis when every visible series is limited and absolute is off', () => {
    expect(historyAxisScale(limited, ['a', 'b'], false)).toBeNull();
  });

  it('switches to a raw axis fitted to the unlimited series when absolute is off', () => {
    expect(historyAxisScale([slot(0, { credits: [100, 180, null] })], ['credits'], false)).toEqual(fitAxisDomain(100, 180));
  });

  it('fits the raw axis across every visible series when one of them is unlimited', () => {
    expect(historyAxisScale(mixed, ['credits', 'quota'], false)).toEqual(fitAxisDomain(10, 180));
  });

  it('uses a raw axis over all visible series when absolute is set, even if all are limited', () => {
    expect(historyAxisScale(limited, ['a', 'b'], true)).toEqual(fitAxisDomain(10, 80));
  });

  it('gives the same fitted axis when absolute is set and a series is unlimited', () => {
    expect(historyAxisScale(mixed, ['credits', 'quota'], true)).toEqual(fitAxisDomain(10, 180));
  });

  it('ignores hidden series: hiding the unlimited one returns to the share-of-limit axis', () => {
    expect(historyAxisScale(mixed, ['quota'], false)).toBeNull();
  });

  it('rescales to the remaining visible series when one is hidden on an absolute chart', () => {
    expect(historyAxisScale(limited, ['a'], true)).toEqual(fitAxisDomain(10, 30));
  });

  it('falls back to 0..1 when absolute is set but no visible series has data', () => {
    expect(historyAxisScale([], ['a'], true)).toEqual({ min: 0, max: 1 });
    expect(historyAxisScale(limited, ['missing'], true)).toEqual({ min: 0, max: 1 });
    expect(historyAxisScale(limited, [], true)).toEqual({ min: 0, max: 1 });
  });

  it('keeps the share-of-limit axis for empty data when absolute is off', () => {
    expect(historyAxisScale([], ['a'], false)).toBeNull();
  });

  it('switches to a raw axis when only some slots of a series lack a limit', () => {
    const slots = [slot(0, { a: [10, 20, 100] }), slot(MIN, { a: [20, 40, null] })];
    expect(historyAxisScale(slots, ['a'], false)).toEqual(fitAxisDomain(10, 40));
  });
});

describe('limitPercentSuffix', () => {
  it('shows the share of the limit only on an absolute chart that shows limits', () => {
    expect(limitPercentSuffix(42, 100, true, true)).toBe(' (42%)');
    expect(limitPercentSuffix(1, 3, true, true)).toBe(' (33%)');
  });
  it('is empty when absolute is off, whatever the limit', () => {
    expect(limitPercentSuffix(42, 100, false, true)).toBe('');
    expect(limitPercentSuffix(42, 100, false, false)).toBe('');
  });
  it('is empty when limits are hidden', () => {
    expect(limitPercentSuffix(42, 100, true, false)).toBe('');
  });
  it('is empty without a positive limit', () => {
    expect(limitPercentSuffix(42, null, true, true)).toBe('');
    expect(limitPercentSuffix(42, 0, true, true)).toBe('');
  });
});

describe('sparklineScale', () => {
  const slots = [slot(0, { a: [5, 12, 100] }), slot(MIN, { a: [12, 30, 100], b: [1, 2, null] })];
  it('plots remaining as a share of the limit', () => {
    expect(sparklineScale(slots, 'a', 'remaining')).toBeNull();
  });
  it('plots used from 0 to the highest value seen for that series', () => {
    expect(sparklineScale(slots, 'a', 'used')).toEqual({ min: 0, max: 30 });
  });
  it('never uses an axis top below 1', () => {
    expect(sparklineScale(slots, 'b', 'used')).toEqual({ min: 0, max: 2 });
    expect(sparklineScale([], 'a', 'used')).toEqual({ min: 0, max: 1 });
    expect(sparklineScale([slot(0, { a: [0, 0.2, null] })], 'a', 'used')).toEqual({ min: 0, max: 1 });
  });
});
