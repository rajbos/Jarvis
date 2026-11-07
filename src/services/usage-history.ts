/**
 * Stored usage readings for the status-bar history dialog: GitHub rate limits
 * per token, Claude's 5-hour / 7-day windows and Copilot credits. Every poll
 * that produced a reading writes one row per metric; rows are kept for 30 days.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import type { UsageHistoryMetric, UsageHistoryRange, UsageHistorySample } from '../plugins/types';
import { downsampleUsageHistory } from '../plugins/shared/usage-history-chart';
import { USAGE_SAMPLES_TABLE_SQL } from '../storage/schema';
import { saveDatabase } from '../storage/database';
import { logger } from './logger';

/** How far back samples are kept in the database. */
export const USAGE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const USAGE_HISTORY_METRICS: readonly UsageHistoryMetric[] = ['github-oauth', 'github-pat', 'claude', 'copilot', 'github-api-calls'];

const PRUNE_EVERY_MS = 60 * 60 * 1000;

let store: SqlJsDatabase | null = null;
let lastPruneAt = 0;

export function attachUsageHistoryStore(db: SqlJsDatabase): void {
  store = db;
  lastPruneAt = 0;
  try {
    // The migration chain only advances one version per launch, so make sure
    // the table exists even when this database has not reached v39 yet.
    db.run(USAGE_SAMPLES_TABLE_SQL);
  } catch (err) {
    logger.warn('[usage-history] Could not create the samples table:', err instanceof Error ? err.message : String(err));
  }
}

export function detachUsageHistoryStore(): void {
  store = null;
}

export function recordUsageSample(metric: UsageHistoryMetric, sample: UsageHistorySample): void {
  if (!store || Object.keys(sample.series).length === 0) return;
  const data: Record<string, [number, number | null]> = {};
  for (const [name, { value, limit }] of Object.entries(sample.series)) data[name] = [value, limit];
  try {
    store.run('INSERT OR REPLACE INTO usage_samples (metric, at, data) VALUES (?, ?, ?)', [metric, sample.at, JSON.stringify(data)]);
    if (sample.at - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = sample.at;
      store.run('DELETE FROM usage_samples WHERE at < ?', [sample.at - USAGE_HISTORY_RETENTION_MS]);
    }
    saveDatabase();
  } catch (err) {
    logger.warn(`[usage-history] Could not store ${metric} sample:`, err instanceof Error ? err.message : String(err));
  }
}

export function readUsageSamples(metric: UsageHistoryMetric, from: number, to: number): UsageHistorySample[] {
  if (!store) return [];
  const res = store.exec(
    'SELECT at, data FROM usage_samples WHERE metric = ? AND at >= ? AND at <= ? ORDER BY at',
    [metric, from, to],
  );
  if (res.length === 0) return [];
  const out: UsageHistorySample[] = [];
  for (const [at, data] of res[0].values) {
    try {
      const parsed = JSON.parse(String(data)) as Record<string, [number, number | null]>;
      const series: UsageHistorySample['series'] = {};
      for (const [name, [value, limit]] of Object.entries(parsed)) series[name] = { value, limit };
      out.push({ at: Number(at), series });
    } catch {
      // A row that does not parse is skipped rather than failing the whole range.
    }
  }
  return out;
}

/** Samples of one metric from the last `rangeMs`, downsampled for the history dialog. */
export function queryUsageHistory(metric: UsageHistoryMetric, rangeMs: number, now: number = Date.now()): UsageHistoryRange {
  const range = Math.min(Math.max(rangeMs, 60_000), USAGE_HISTORY_RETENTION_MS);
  const start = now - range;
  const samples = readUsageSamples(metric, start, now);
  let oldestAt: number | null = null;
  if (store) {
    const res = store.exec('SELECT MIN(at) FROM usage_samples WHERE metric = ?', [metric]);
    oldestAt = (res[0]?.values[0]?.[0] as number | null) ?? null;
  }
  return { metric, start, end: now, oldestAt, sampleCount: samples.length, ...downsampleUsageHistory(samples, start, now) };
}
