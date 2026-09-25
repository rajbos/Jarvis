// ── GitHub Copilot AI credit usage service ───────────────────────────────────
//
// Since June 2026 Copilot is billed in AI credits (1 AIC = $0.01). Usage is
// metered per calendar month (UTC) and resets on the 1st. We read the current
// month's consumption from the enhanced billing platform:
//
//   GET /users/{username}/settings/billing/ai_credit/usage?year=YYYY&month=M
//
// Token requirements: a classic OAuth / PAT token needs the `user` scope; a
// fine-grained PAT needs the "Plan" user permission (read). Usage for Copilot
// seats billed through an organization or enterprise is NOT reported here —
// only the user's own (personal plan) consumption.
//
// There is no REST endpoint for personal budgets, so the monthly budget is a
// Jarvis setting that the user enters in the Settings window.

export const AI_CREDIT_USD = 0.01;

export interface AiCreditUsageItem {
  product: string;
  sku: string;
  model?: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

export interface AiCreditModelUsage {
  model: string;
  credits: number;
}

export interface AiCreditUsageSummary {
  /** Total AI credits consumed this month (included + billed). */
  creditsUsed: number;
  /** Credits covered by the plan's included allowance / discounts. */
  includedCreditsUsed: number;
  /** Credits billed on top of the included allowance. */
  billedCredits: number;
  /** Billed amount in USD. */
  billedAmountUsd: number;
  /** Per-model breakdown, largest first. */
  byModel: AiCreditModelUsage[];
}

export interface BillingMonth {
  year: number;
  /** 1-12 */
  month: number;
  /** Unix seconds — start of the month (UTC). */
  startsAt: number;
  /** Unix seconds — start of the next month (UTC), when usage resets. */
  resetsAt: number;
}

/** The calendar month (UTC) the given instant falls into. */
export function currentBillingMonth(now: Date = new Date()): BillingMonth {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  return {
    year,
    month: monthIndex + 1,
    startsAt: Math.floor(Date.UTC(year, monthIndex, 1) / 1000),
    resetsAt: Math.floor(Date.UTC(year, monthIndex + 1, 1) / 1000),
  };
}

/** Fraction (0..1) of the billing month that has elapsed at `now`. */
export function elapsedMonthFraction(period: BillingMonth, now: Date = new Date()): number {
  const nowSec = now.getTime() / 1000;
  const span = period.resetsAt - period.startsAt;
  return Math.min(1, Math.max(0, (nowSec - period.startsAt) / span));
}

/**
 * Linear projection of month-end usage from the usage so far. Returns null
 * early in the month (< ~1 day elapsed) where the extrapolation is noise.
 */
export function projectMonthEndUsage(creditsUsed: number, period: BillingMonth, now: Date = new Date()): number | null {
  const fraction = elapsedMonthFraction(period, now);
  if (fraction < 1 / 31) return null;
  return Math.round(creditsUsed / fraction);
}

/** Aggregate the raw usage line items into totals and a per-model breakdown. */
export function summarizeAiCreditUsage(items: AiCreditUsageItem[]): AiCreditUsageSummary {
  let creditsUsed = 0;
  let includedCreditsUsed = 0;
  let billedCredits = 0;
  let billedAmountUsd = 0;
  const models = new Map<string, number>();

  for (const item of items) {
    const gross = Number(item.grossQuantity) || 0;
    creditsUsed += gross;
    includedCreditsUsed += Number(item.discountQuantity) || 0;
    billedCredits += Number(item.netQuantity) || 0;
    billedAmountUsd += Number(item.netAmount) || 0;
    const model = item.model || item.sku || 'Other';
    models.set(model, (models.get(model) ?? 0) + gross);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    creditsUsed: round(creditsUsed),
    includedCreditsUsed: round(includedCreditsUsed),
    billedCredits: round(billedCredits),
    billedAmountUsd: round(billedAmountUsd),
    byModel: [...models.entries()]
      .map(([model, credits]) => ({ model, credits: round(credits) }))
      .filter((m) => m.credits > 0)
      .sort((a, b) => b.credits - a.credits),
  };
}

export type AiCreditFetchResult =
  | { ok: true; summary: AiCreditUsageSummary }
  | { ok: false; status: number; error: string; missingScope: boolean };

/** Fetch and summarise the AI credit usage of `login` for the given month. */
export async function fetchAiCreditUsage(
  token: string,
  login: string,
  period: BillingMonth,
): Promise<AiCreditFetchResult> {
  const url =
    `https://api.github.com/users/${encodeURIComponent(login)}/settings/billing/ai_credit/usage` +
    `?year=${period.year}&month=${period.month}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // GitHub answers 403 (or 404 for classic tokens lacking scope) when
      // the token can't read billing data.
      const missingScope = res.status === 403 || res.status === 404;
      let message = '';
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? '';
      } catch {
        message = body.slice(0, 200);
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}${message ? `: ${message}` : ''}`, missingScope };
    }
    const data = (await res.json()) as { usageItems?: AiCreditUsageItem[] };
    return { ok: true, summary: summarizeAiCreditUsage(Array.isArray(data.usageItems) ? data.usageItems : []) };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), missingScope: false };
  }
}
