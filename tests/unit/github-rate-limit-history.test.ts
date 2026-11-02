import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';

vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));

import {
  clearRateLimitHistory,
  getRateLimitHistory,
  recordRateLimitSample,
  reloadRateLimitHistory,
  RATE_LIMIT_HISTORY_WINDOW_MS,
} from '../../src/services/github-rate-limit-history';
import { attachUsageHistoryStore, detachUsageHistoryStore, queryUsageHistory } from '../../src/services/usage-history';
import { rateLimitSeries, tightestBucket, CHART_WINDOW_MS } from '../../src/plugins/github-auth/rate-limit-chart';
import type { GitHubRateLimitSource } from '../../src/plugins/types';

const res = (remaining: number, limit = 5000) => ({ remaining, limit, reset: 1_700_000_000, used: limit - remaining });

describe('github-rate-limit-history', () => {
  beforeEach(() => clearRateLimitHistory());

  it('keeps only tracked buckets, per source', () => {
    recordRateLimitSample('pat', { core: res(4000), graphql: res(100), search: res(20, 30), code_scanning_upload: res(1000, 1000) }, 1000);
    expect(getRateLimitHistory('pat', 1000)).toEqual([
      { at: 1000, buckets: { core: { remaining: 4000, limit: 5000 }, graphql: { remaining: 100, limit: 5000 }, search: { remaining: 20, limit: 30 } } },
    ]);
    expect(getRateLimitHistory('oauth', 1000)).toEqual([]);
  });

  it('drops samples older than the 2-hour window', () => {
    const now = 10 * RATE_LIMIT_HISTORY_WINDOW_MS;
    recordRateLimitSample('oauth', { core: res(1) }, now - RATE_LIMIT_HISTORY_WINDOW_MS - 1);
    recordRateLimitSample('oauth', { core: res(2) }, now - 60_000);
    recordRateLimitSample('oauth', { core: res(3) }, now);
    expect(getRateLimitHistory('oauth', now).map((s) => s.buckets.core?.remaining)).toEqual([2, 3]);
  });
});

describe('rate-limit-chart', () => {
  it('maps samples onto the 2-hour chart area', () => {
    const now = CHART_WINDOW_MS * 5;
    const history = [
      { at: now - CHART_WINDOW_MS, buckets: { core: { remaining: 5000, limit: 5000 } } },
      { at: now - CHART_WINDOW_MS / 2, buckets: { core: { remaining: 2500, limit: 5000 } } },
      { at: now, buckets: { core: { remaining: 0, limit: 5000 }, graphql: { remaining: 5000, limit: 5000 } } },
    ];
    expect(rateLimitSeries(history, 'core', now, 200, 100)).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 100 },
    ]);
    expect(rateLimitSeries(history, 'graphql', now, 200, 100)).toEqual([{ x: 200, y: 0 }]);
  });

  it('headlines the bucket closest to running out', () => {
    const source: GitHubRateLimitSource = {
      configured: true,
      resource: res(5000),
      resources: { core: res(5000), graphql: res(12), search: res(0, 30) },
    };
    expect(tightestBucket(source)?.name).toBe('graphql');
    expect(tightestBucket({ configured: true, resource: res(42) })?.resource.remaining).toBe(42);
    expect(tightestBucket({ configured: true, resource: null })).toBeNull();
  });
});

describe('github rate-limit history persistence', () => {
  beforeEach(() => clearRateLimitHistory());
  afterEach(() => detachUsageHistoryStore());

  it('stores samples per token and reloads the in-memory window after a restart', async () => {
    const SQL = await initSqlJs();
    attachUsageHistoryStore(new SQL.Database());
    const now = 100 * RATE_LIMIT_HISTORY_WINDOW_MS;
    recordRateLimitSample('pat', { core: res(4000), graphql: res(10) }, now - 3 * RATE_LIMIT_HISTORY_WINDOW_MS);
    recordRateLimitSample('pat', { core: res(3000) }, now - 600_000);

    clearRateLimitHistory();
    reloadRateLimitHistory(now);
    expect(getRateLimitHistory('pat', now)).toEqual([{ at: now - 600_000, buckets: { core: { remaining: 3000, limit: 5000 } } }]);

    const day = queryUsageHistory('github-pat', 24 * 60 * 60 * 1000, now);
    expect(day.sampleCount).toBe(2);
    expect(day.low.graphql).toEqual({ value: 10, limit: 5000, at: now - 3 * RATE_LIMIT_HISTORY_WINDOW_MS });
    expect(queryUsageHistory('github-oauth', 24 * 60 * 60 * 1000, now).sampleCount).toBe(0);
  });
});
