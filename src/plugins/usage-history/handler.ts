import type { Database as SqlJsDatabase } from 'sql.js';
import { safeHandle } from '../ipc-utils';
import { attachUsageHistoryStore, queryUsageHistory, USAGE_HISTORY_METRICS } from '../../services/usage-history';
import { reloadRateLimitHistory } from '../../services/github-rate-limit-history';
import type { UsageHistoryMetric } from '../types';

export function registerHandlers(db: SqlJsDatabase): void {
  attachUsageHistoryStore(db);
  reloadRateLimitHistory();

  safeHandle('usage-history:query', (_e, metric: string, rangeMs: number) => {
    if (!USAGE_HISTORY_METRICS.includes(metric as UsageHistoryMetric)) throw new Error(`Unknown usage metric: ${metric}`);
    if (!Number.isFinite(rangeMs) || rangeMs <= 0) throw new Error('rangeMs must be a positive number');
    return queryUsageHistory(metric as UsageHistoryMetric, rangeMs);
  });
}
