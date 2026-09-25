// ── GitHub Copilot AI credit usage IPC handlers ──────────────────────────────
import { Notification } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import { fetchGitHubUser, loadGitHubAuth, loadGitHubPat } from '../../services/github-oauth';
import {
  currentBillingMonth,
  fetchAiCreditUsage,
  projectMonthEndUsage,
  type AiCreditFetchResult,
} from '../../services/copilot-usage';
import { getConfigValue, setConfigValue, saveDatabase } from '../../storage/database';
import type { CopilotUsage } from '../types';

const KEY_BUDGET = 'copilot_aic_monthly_budget';
/** `YYYY-MM:<threshold>` of the last budget alert, so each alert fires once per month. */
const KEY_ALERTED = 'copilot_aic_budget_alerted';
const ALERT_THRESHOLDS = [100, 80];

let lastUsage: CopilotUsage | null = null;
let patLogin: { pat: string; login: string } | null = null;

/** Reset module state (tests only). */
export function _resetCopilotUsageState(): void {
  lastUsage = null;
  patLogin = null;
}

export function getCopilotBudget(db: SqlJsDatabase): number | null {
  const raw = getConfigValue(db, KEY_BUDGET);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function setCopilotBudget(db: SqlJsDatabase, credits: number | null): void {
  if (credits === null) {
    db.run('DELETE FROM config WHERE key = ?', [KEY_BUDGET]);
  } else {
    setConfigValue(db, KEY_BUDGET, String(credits));
  }
  saveDatabase();
}

function hasUserScope(scopes: string | undefined): boolean {
  return (scopes ?? '').split(/[\s,]+/).includes('user');
}

function notifyBudgetThreshold(db: SqlJsDatabase, usage: CopilotUsage): void {
  if (usage.budgetCredits === null || usage.budgetCredits <= 0) return;
  const pct = (usage.creditsUsed / usage.budgetCredits) * 100;
  const threshold = ALERT_THRESHOLDS.find((t) => pct >= t);
  if (threshold === undefined) return;

  const monthKey = `${usage.year}-${String(usage.month).padStart(2, '0')}`;
  const last = getConfigValue(db, KEY_ALERTED);
  const [lastMonth, lastThreshold] = (last ?? '').split(':');
  if (lastMonth === monthKey && Number(lastThreshold) >= threshold) return;

  setConfigValue(db, KEY_ALERTED, `${monthKey}:${threshold}`);
  saveDatabase();
  new Notification({
    title: 'Jarvis',
    body: threshold >= 100
      ? `GitHub Copilot budget reached — ${Math.round(usage.creditsUsed)} of ${usage.budgetCredits} AI credits used this month.`
      : `GitHub Copilot at ${Math.round(pct)}% of budget — ${Math.round(usage.creditsUsed)} of ${usage.budgetCredits} AI credits used this month.`,
  }).show();
}

function broadcast(getWindow: () => BrowserWindow | null, usage: CopilotUsage): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('copilot-usage:updated', usage);
}

/**
 * Fetch this month's Copilot AI credit usage using the linked GitHub OAuth
 * token (falling back to the PAT when the OAuth token lacks billing access),
 * cache it, push it to the renderer, and raise budget notifications.
 */
export async function checkCopilotUsage(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  now: Date = new Date(),
): Promise<CopilotUsage> {
  const period = currentBillingMonth(now);
  const budgetCredits = getCopilotBudget(db);
  const base = {
    year: period.year,
    month: period.month,
    resetsAt: period.resetsAt,
    budgetCredits,
    fetchedAt: now.toISOString(),
  };
  const empty = {
    creditsUsed: 0,
    includedCreditsUsed: 0,
    billedCredits: 0,
    billedAmountUsd: 0,
    byModel: [],
    projectedCredits: null,
  };

  const auth = loadGitHubAuth(db);
  const pat = loadGitHubPat(db);

  let usage: CopilotUsage;
  if (!auth && !pat) {
    usage = { ...base, ...empty, configured: false };
  } else {
    let result: AiCreditFetchResult | null = null;
    let source: 'oauth' | 'pat' | undefined;
    let login: string | undefined;

    if (auth) {
      result = await fetchAiCreditUsage(auth.accessToken, auth.login, period);
      source = 'oauth';
      login = auth.login;
    }
    if (pat && (!result || (!result.ok && result.missingScope))) {
      try {
        if (patLogin?.pat !== pat) patLogin = { pat, login: (await fetchGitHubUser(pat)).login };
        const patResult = await fetchAiCreditUsage(pat, patLogin.login, period);
        // Keep the OAuth error when the PAT can't read billing data either.
        if (patResult.ok || !result) {
          result = patResult;
          source = 'pat';
          login = patLogin.login;
        }
      } catch (err) {
        logger.warn('[copilot-usage] PAT user lookup failed:', err instanceof Error ? err.message : String(err));
      }
    }

    if (result?.ok) {
      usage = {
        ...base,
        ...result.summary,
        configured: true,
        source,
        login,
        projectedCredits: projectMonthEndUsage(result.summary.creditsUsed, period, now),
      };
    } else {
      const missingScope = result?.missingScope ?? false;
      usage = {
        ...base,
        ...empty,
        configured: true,
        source,
        login,
        missingScope,
        oauthHasUserScope: auth ? hasUserScope(auth.scopes) : undefined,
        error: missingScope
          ? 'GitHub token cannot read billing data — re-authorize GitHub in Settings to grant the "user" scope.'
          : result?.error ?? 'Usage check failed',
      };
    }
  }

  lastUsage = usage;
  if (!usage.error && usage.configured) notifyBudgetThreshold(db, usage);
  broadcast(getWindow, usage);
  return usage;
}

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  safeHandle('copilot-usage:get', async () => lastUsage ?? (await checkCopilotUsage(db, getWindow)));

  safeHandle('copilot-usage:refresh', () => checkCopilotUsage(db, getWindow));

  safeHandle('copilot-usage:get-budget', () => ({ ok: true, budgetCredits: getCopilotBudget(db) }));

  safeHandle('copilot-usage:set-budget', (_event, credits: unknown) => {
    if (credits !== null && (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0)) {
      return { ok: false, error: 'Budget must be a positive number of AI credits' };
    }
    const budget = credits === null || credits === 0 ? null : Math.round(credits);
    setCopilotBudget(db, budget);
    // Re-apply the new budget to the cached usage so the badge updates immediately.
    if (lastUsage) {
      lastUsage = { ...lastUsage, budgetCredits: budget };
      if (!lastUsage.error && lastUsage.configured) notifyBudgetThreshold(db, lastUsage);
      broadcast(getWindow, lastUsage);
    }
    return { ok: true, budgetCredits: budget };
  });
}
