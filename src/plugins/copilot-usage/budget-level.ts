import type { CopilotUsage } from '../types';

export type CopilotBudgetLevel = 'unknown' | 'available' | 'warning' | 'limited';

/**
 * The ceiling usage is measured against: the user's budget when set, else the
 * plan's included credits (quota endpoint); null when neither is known.
 */
export function copilotUsageLimit(usage: CopilotUsage): number | null {
  if (usage.budgetCredits !== null && usage.budgetCredits > 0) return usage.budgetCredits;
  if (usage.entitlementCredits && usage.entitlementCredits > 0) return usage.entitlementCredits;
  return null;
}

/** Traffic-light level of month-to-date usage vs the limit (and the month-end projection). */
export function copilotBudgetLevel(usage: CopilotUsage): CopilotBudgetLevel {
  if (usage.error) return 'unknown';
  const limit = copilotUsageLimit(usage);
  if (limit === null) return 'available';
  const ratio = usage.creditsUsed / limit;
  if (ratio >= 1) return 'limited';
  if (ratio >= 0.8) return 'warning';
  if (usage.projectedCredits !== null && usage.projectedCredits > limit) return 'warning';
  return 'available';
}
