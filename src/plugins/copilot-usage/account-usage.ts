// ── Per-account Copilot AI credit usage ──────────────────────────────────────
// Electron-free so it can be unit tested and reused for any number of accounts.
import {
  AI_CREDIT_USD,
  currentBillingMonth,
  fetchAiCreditUsage,
  fetchCopilotQuota,
  projectMonthEndUsage,
  type BillingMonth,
  type CopilotQuota,
} from '../../services/copilot-usage';
import type { CopilotUsage } from '../types';

/** Fields every usage result carries regardless of source. */
export type UsageBase = Pick<CopilotUsage, 'year' | 'month' | 'resetsAt' | 'budgetCredits' | 'fetchedAt'>;

export function usageBase(period: BillingMonth, budgetCredits: number | null, now: Date): UsageBase {
  return {
    year: period.year,
    month: period.month,
    resetsAt: period.resetsAt,
    budgetCredits,
    fetchedAt: now.toISOString(),
  };
}

const EMPTY_USAGE = {
  creditsUsed: 0,
  includedCreditsUsed: 0,
  billedCredits: 0,
  billedAmountUsd: 0,
  byModel: [],
  projectedCredits: null,
};

/** Map the internal quota endpoint's answer to a {@link CopilotUsage}. */
export function quotaToUsage(
  base: UsageBase,
  q: CopilotQuota,
  period: BillingMonth,
  now: Date,
  fallbackLogin?: string,
): CopilotUsage {
  const included = q.entitlementCredits === null ? q.creditsUsed : Math.min(q.creditsUsed, q.entitlementCredits);
  const billed = q.creditsUsed - included;
  return {
    ...base,
    resetsAt: q.resetsAt ?? base.resetsAt,
    configured: true,
    source: 'gh-cli',
    login: q.login || fallbackLogin,
    plan: q.plan,
    entitlementCredits: q.entitlementCredits,
    creditsUsed: q.creditsUsed,
    includedCreditsUsed: included,
    billedCredits: billed,
    billedAmountUsd: Math.round(billed * AI_CREDIT_USD * 100) / 100,
    byModel: [],
    projectedCredits: projectMonthEndUsage(q.creditsUsed, period, now),
  };
}

/** Everything Jarvis can authenticate as for one GitHub account. */
export interface AccountCredentials {
  login: string;
  /** REST API base of the account's host (default: github.com). */
  apiBase?: string;
  /** The GitHub CLI's token for this account (works for org/enterprise seats). */
  ghToken: string | null;
  oauth: { accessToken: string; scopes: string } | null;
  pat: string | null;
}

/**
 * Month-to-date Copilot usage for one account. Same source order as the
 * single-account check: GitHub CLI quota, then the OAuth token's billing
 * report, then the PAT's.
 */
export async function fetchAccountCopilotUsage(
  creds: AccountCredentials,
  budgetCredits: number | null,
  now: Date = new Date(),
): Promise<CopilotUsage> {
  const period = currentBillingMonth(now);
  const base = usageBase(period, budgetCredits, now);

  if (!creds.ghToken && !creds.oauth && !creds.pat) {
    return { ...base, ...EMPTY_USAGE, configured: false, login: creds.login };
  }

  let quotaError: string | undefined;
  if (creds.ghToken) {
    const quota = await fetchCopilotQuota(creds.ghToken, creds.apiBase);
    if (quota.ok) return quotaToUsage(base, quota.quota, period, now, creds.login);
    quotaError = quota.error;
  }

  const attempts: Array<{ source: 'oauth' | 'pat'; token: string }> = [];
  if (creds.oauth) attempts.push({ source: 'oauth', token: creds.oauth.accessToken });
  if (creds.pat) attempts.push({ source: 'pat', token: creds.pat });

  let lastError: string | undefined;
  let missingScope = false;
  for (const attempt of attempts) {
    const result = await fetchAiCreditUsage(attempt.token, creds.login, period, creds.apiBase);
    if (result.ok) {
      return {
        ...base,
        ...result.summary,
        configured: true,
        source: attempt.source,
        login: creds.login,
        projectedCredits: projectMonthEndUsage(result.summary.creditsUsed, period, now),
      };
    }
    lastError = result.error;
    missingScope = missingScope || result.missingScope;
  }

  const oauthHasUserScope = creds.oauth ? (creds.oauth.scopes ?? '').split(/[\s,]+/).includes('user') : undefined;
  return {
    ...base,
    ...EMPTY_USAGE,
    configured: true,
    source: attempts[0]?.source,
    login: creds.login,
    missingScope,
    oauthHasUserScope,
    error: missingScope
      ? 'This account cannot read personal billing data. Copilot is probably billed through an organization — log in to the GitHub CLI (gh auth login) as this account so the quota can be read.'
      : lastError ?? quotaError ?? 'Usage check failed',
  };
}
