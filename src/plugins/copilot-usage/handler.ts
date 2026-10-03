// ── GitHub Copilot AI credit usage IPC handlers ──────────────────────────────
import { Notification, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import { fetchGitHubUser, getPrimaryGitHubLogin, loadGitHubAuth, loadGitHubPat } from '../../services/github-oauth';
import {
  currentBillingMonth,
  fetchAiCreditUsage,
  fetchCopilotQuota,
  getGhCliToken,
  projectMonthEndUsage,
  type AiCreditFetchResult,
} from '../../services/copilot-usage';
import { quotaToUsage } from './account-usage';
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

/** Push usage to every open window — the status-bar badge and the Settings window both show it. */
function broadcast(getWindow: () => BrowserWindow | null, usage: CopilotUsage): void {
  const windows = new Set(BrowserWindow.getAllWindows());
  const main = getWindow();
  if (main) windows.add(main);
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('copilot-usage:updated', usage);
  }
}

/**
 * Fetch this month's Copilot AI credit usage, cache it, push it to the
 * renderer, and raise budget notifications.
 *
 * Sources, in order: the GitHub CLI's token against the internal quota
 * endpoint VS Code uses (works for org/enterprise-billed seats), then the
 * linked OAuth token against the public billing report, then the PAT when the
 * OAuth token lacks billing access.
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

  let usage: CopilotUsage | null = null;

  // The primary account's CLI token — not whichever account `gh` has active, or the
  // flyout would show that account twice and miss the primary. Without a Jarvis
  // sign-in there is no primary, so the active CLI account is used.
  const primaryLogin = getPrimaryGitHubLogin(db);
  const ghToken = await getGhCliToken(primaryLogin ?? undefined);
  if (ghToken) {
    const quotaResult = await fetchCopilotQuota(ghToken);
    if (quotaResult.ok) {
      usage = quotaToUsage(base, quotaResult.quota, period, now, auth?.login ?? primaryLogin ?? undefined);
    } else {
      logger.debug(`[copilot-usage] GitHub CLI quota lookup failed (${quotaResult.error}); falling back to billing report`);
    }
  }

  if (!usage && !auth && !pat) {
    usage = { ...base, ...empty, configured: false };
  } else if (!usage) {
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
      const oauthHasUserScope = auth ? hasUserScope(auth.scopes) : undefined;
      usage = {
        ...base,
        ...empty,
        configured: true,
        source,
        login,
        missingScope,
        oauthHasUserScope,
        error: !missingScope
          ? result?.error ?? 'Usage check failed'
          : source === 'oauth' && oauthHasUserScope
            // The token already carries `user`, so re-authorizing won't help:
            // GitHub has no personal billing data for this account.
            ? `GitHub denied access to billing usage (${result?.error ?? 'no details'}) even though the sign-in has the "user" scope — Copilot is likely billed through an organization, which isn't reported here.`
            : 'Your GitHub sign-in cannot read billing data — re-authorize GitHub and approve "Personal user data" access.',
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
