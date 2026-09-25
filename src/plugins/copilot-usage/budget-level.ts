import type { CopilotUsage } from '../types';

export type CopilotBudgetLevel = 'unknown' | 'available' | 'warning' | 'limited';

/** Traffic-light level of month-to-date usage vs budget (and the month-end projection). */
export function copilotBudgetLevel(usage: CopilotUsage): CopilotBudgetLevel {
  if (usage.error) return 'unknown';
  if (usage.budgetCredits === null || usage.budgetCredits <= 0) return 'available';
  const ratio = usage.creditsUsed / usage.budgetCredits;
  if (ratio >= 1) return 'limited';
  if (ratio >= 0.8) return 'warning';
  if (usage.projectedCredits !== null && usage.projectedCredits > usage.budgetCredits) return 'warning';
  return 'available';
}
