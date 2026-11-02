import type { CopilotUsage } from '../types';
import { recordUsageSample } from '../../services/usage-history';
import { copilotUsageLimit } from './budget-level';

/**
 * Store month-to-date Copilot credits for the history dialog, one series per
 * account id. The primary account is recorded by its own usage check and the
 * other accounts by the all-accounts check, so each lands in its own row.
 */
export function recordCopilotCredits(accounts: Array<{ id: string; usage: CopilotUsage }>, at: number): void {
  const series: Record<string, { value: number; limit: number | null }> = {};
  for (const { id, usage } of accounts) {
    if (!usage.configured || usage.error || usage.stale) continue;
    series[id] = { value: usage.creditsUsed, limit: copilotUsageLimit(usage) };
  }
  recordUsageSample('copilot', { at, series });
}
