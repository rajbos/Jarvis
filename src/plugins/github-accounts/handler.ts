// ── Multiple GitHub accounts: listing, Copilot usage/budget, repo mapping ────
import type { Database as SqlJsDatabase } from 'sql.js';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import {
  deleteGitHubAuthFor,
  getPrimaryGitHubLogin,
  loadGitHubAuth,
  loadGitHubPat,
  setPrimaryGitHubLogin,
} from '../../services/github-oauth';
import {
  deleteHostAccount,
  listAccounts,
  listAssignments,
  listGhCliAccounts,
  listHostAccounts,
  listLocalReposForSync,
  loadHostAccountPat,
  resolveAccountForRepo,
  saveHostAccountPat,
  setAssignment,
  syncGitConfigAssignments,
  type AssignmentScope,
} from '../../services/github-accounts';
import {
  DEFAULT_HOST,
  apiBaseForHost,
  hostKey,
  isSupportedHost,
  normalizeHost,
  parseHostKey,
} from '../../services/github-host';
import { getGhCliToken } from '../../services/copilot-usage';
import { getConfigValue, saveDatabase, setConfigValue } from '../../storage/database';
import { fetchAccountCopilotUsage } from '../copilot-usage/account-usage';
import { getCopilotBudget } from '../copilot-usage/handler';
import type { GitHubAccountUsage } from '../types';

const BUDGET_KEY_PREFIX = 'copilot_aic_monthly_budget:';
const LEGACY_BUDGET_KEY = 'copilot_aic_monthly_budget';

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The account's budget: its own setting, else (primary only) the single-account budget. */
export function getAccountBudget(db: SqlJsDatabase, accountId: string, isPrimary: boolean): number | null {
  const raw = getConfigValue(db, BUDGET_KEY_PREFIX + accountId.toLowerCase());
  if (raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return isPrimary ? getCopilotBudget(db) : null;
}

function setAccountBudget(db: SqlJsDatabase, accountId: string, isPrimary: boolean, credits: number | null): void {
  const key = BUDGET_KEY_PREFIX + accountId.toLowerCase();
  if (credits === null) db.run('DELETE FROM config WHERE key = ?', [key]);
  else setConfigValue(db, key, String(credits));
  // The status-bar badge and alerts read the single-account budget — keep it in step for the primary account.
  if (isPrimary) {
    if (credits === null) db.run('DELETE FROM config WHERE key = ?', [LEGACY_BUDGET_KEY]);
    else setConfigValue(db, LEGACY_BUDGET_KEY, String(credits));
  }
  saveDatabase();
}

/** Month-to-date Copilot usage and budget for every tracked account. */
export async function checkAllAccountsUsage(
  db: SqlJsDatabase,
  now: Date = new Date(),
): Promise<GitHubAccountUsage[]> {
  const ghAccounts = await listGhCliAccounts();
  const accounts = listAccounts(db, ghAccounts);
  return Promise.all(
    accounts.map(async (account) => {
      const viaGh = ghAccounts.some((g) => g.host === account.host && sameId(g.login, account.login));
      const oauth = account.host === DEFAULT_HOST ? loadGitHubAuth(db, account.login) : null;
      const pat = account.host === DEFAULT_HOST ? loadGitHubPat(db, account.login) : loadHostAccountPat(db, account.id);
      const budget = getAccountBudget(db, account.id, account.isPrimary);
      const usage = await fetchAccountCopilotUsage(
        {
          login: account.login,
          apiBase: apiBaseForHost(account.host),
          ghToken: viaGh ? await getGhCliToken(account.login, account.host) : null,
          oauth: oauth ? { accessToken: oauth.accessToken, scopes: oauth.scopes } : null,
          pat,
        },
        budget,
        now,
      );
      return { account, usage };
    }),
  );
}

/** Check a PAT against a GHE.com host and return the login and avatar it belongs to. */
async function lookupHostUser(host: string, pat: string): Promise<{ login: string; avatarUrl: string | null }> {
  const res = await fetch(`${apiBaseForHost(host)}/user`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Jarvis-Agent/0.1.0' },
  });
  if (res.status === 401) throw new Error(`${host} rejected this token (HTTP 401)`);
  if (!res.ok) throw new Error(`Could not read the user on ${host} (HTTP ${res.status})`);
  const user = (await res.json()) as { login?: string; avatar_url?: string };
  if (!user.login) throw new Error(`Unexpected answer from ${host}`);
  return { login: user.login, avatarUrl: user.avatar_url ?? null };
}

function isScope(value: unknown): value is AssignmentScope {
  return value === 'owner' || value === 'repo';
}

export function registerHandlers(db: SqlJsDatabase): void {
  safeHandle('github-accounts:list', async () => {
    const accounts = listAccounts(db, await listGhCliAccounts());
    return { ok: true, accounts, assignments: listAssignments(db) };
  });

  safeHandle('github-accounts:usage', async () => ({ ok: true, usage: await checkAllAccountsUsage(db) }));

  safeHandle('github-accounts:set-budget', async (_event, accountId: unknown, credits: unknown) => {
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: 'Account is required' };
    if (credits !== null && (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0)) {
      return { ok: false, error: 'Budget must be a positive number of AI credits' };
    }
    const account = listAccounts(db, await listGhCliAccounts()).find((a) => sameId(a.id, accountId));
    if (!account) return { ok: false, error: `Unknown account ${accountId}` };
    const budget = credits === null || credits === 0 ? null : Math.round(credits);
    setAccountBudget(db, account.id, account.isPrimary, budget);
    return { ok: true, budgetCredits: budget };
  });

  safeHandle('github-accounts:add-host-account', async (_event, host: unknown, pat: unknown) => {
    const h = typeof host === 'string' ? normalizeHost(host) : null;
    if (!h || h === DEFAULT_HOST || !isSupportedHost(h)) {
      return { ok: false, error: 'Enter a GHE.com host such as your-company.ghe.com' };
    }
    if (typeof pat !== 'string' || !pat.trim()) return { ok: false, error: 'A personal access token is required' };
    const user = await lookupHostUser(h, pat.trim());
    const id = saveHostAccountPat(db, h, user.login, pat.trim(), user.avatarUrl);
    saveDatabase();
    logger.info(`[accounts] Added ${id}`);
    return { ok: true, account: id, login: user.login };
  });

  safeHandle('github-accounts:set-primary', (_event, login: unknown) => {
    if (typeof login !== 'string' || !setPrimaryGitHubLogin(db, login)) {
      return { ok: false, error: 'Only github.com accounts signed in through Jarvis can be the primary account' };
    }
    saveDatabase();
    return { ok: true };
  });

  safeHandle('github-accounts:remove', (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: 'Account is required' };
    if (listHostAccounts(db).some((a) => sameId(a.id, accountId))) deleteHostAccount(db, accountId);
    else deleteGitHubAuthFor(db, accountId);
    saveDatabase();
    return { ok: true };
  });

  safeHandle('github-accounts:set-assignment', (_event, scope: unknown, key: unknown, login: unknown) => {
    if (!isScope(scope) || typeof key !== 'string' || !key.trim()) return { ok: false, error: 'Invalid assignment' };
    if (login !== null && (typeof login !== 'string' || !login.trim())) return { ok: false, error: 'Invalid account' };
    const { host, rest } = parseHostKey(key.trim().toLowerCase());
    if (!isSupportedHost(host)) return { ok: false, error: 'Unsupported host' };
    const parts = rest.split('/').filter(Boolean);
    if (scope === 'repo' && parts.length !== 2) return { ok: false, error: 'Repository must be owner/repo' };
    if (scope === 'owner' && parts.length !== 1) return { ok: false, error: 'Owner must be a single name' };
    setAssignment(db, scope, hostKey(host, parts.join('/')), login as string | null);
    saveDatabase();
    return { ok: true, assignments: listAssignments(db) };
  });

  safeHandle('github-accounts:sync-git-config', () => {
    const result = syncGitConfigAssignments(db, { localRepos: listLocalReposForSync(db) });
    saveDatabase();
    logger.info(`[accounts] Imported ${result.imported} account assignment(s) from git config`);
    return { ok: true, ...result, assignments: listAssignments(db) };
  });

  safeHandle('github-accounts:resolve-repo', (_event, repoFullName: unknown, host: unknown) => {
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) return { ok: false, error: 'Repository must be owner/repo' };
    const h = typeof host === 'string' ? normalizeHost(host) ?? DEFAULT_HOST : DEFAULT_HOST;
    if (!isSupportedHost(h)) return { ok: false, error: 'Unsupported host' };
    return { ok: true, resolved: resolveAccountForRepo(db, hostKey(h, repoFullName), getPrimaryGitHubLogin(db)) };
  });
}
