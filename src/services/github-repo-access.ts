// ── Which account (and token) to use for a repo or owner ─────────────────────
// Combines the assignment/visibility resolution with token lookup, so callers
// that work on one repo just ask "who am I for this repo?".
import type { Database as SqlJsDatabase } from 'sql.js';
import {
  listAccounts,
  listGhCliAccountsCached,
  resolveAccountForRepo,
  resolveAccountToken,
  type AccountToken,
} from './github-accounts';
import { getGhCliToken } from './copilot-usage';
import { DEFAULT_HOST, accountId, hostKey, parseAccountId } from './github-host';
import { getPrimaryGitHubLogin } from './github-oauth';

export interface AccountAccess extends AccountToken {
  isPrimary: boolean;
}

/** Host a discovered repo lives on (github.com when it is not in the index yet). */
export function hostOfRepo(db: SqlJsDatabase, repoFullName: string): string {
  const stmt = db.prepare('SELECT host FROM github_repos WHERE full_name = ?');
  stmt.bind([repoFullName]);
  const host = stmt.step() ? (stmt.getAsObject() as { host: string | null }).host : null;
  stmt.free();
  return host || DEFAULT_HOST;
}

/** Host of an owner (org) in the index; falls back to the host of one of its repos. */
export function hostOfOwner(db: SqlJsDatabase, owner: string): string {
  const stmt = db.prepare('SELECT host FROM github_orgs WHERE login = ?');
  stmt.bind([owner]);
  let host = stmt.step() ? (stmt.getAsObject() as { host: string | null }).host : null;
  stmt.free();
  if (!host) {
    const repoStmt = db.prepare('SELECT host FROM github_repos WHERE full_name LIKE ? LIMIT 1');
    repoStmt.bind([`${owner}/%`]);
    host = repoStmt.step() ? (repoStmt.getAsObject() as { host: string | null }).host : null;
    repoStmt.free();
  }
  return host || DEFAULT_HOST;
}

/** Every tracked account that has a usable credential, primary first. */
export async function listAccountsWithAccess(db: SqlJsDatabase): Promise<AccountAccess[]> {
  const accounts = listAccounts(db, await listGhCliAccountsCached());
  const out: AccountAccess[] = [];
  for (const account of accounts) {
    const token = await resolveAccountToken(db, account.id);
    if (token) out.push({ ...token, isPrimary: account.isPrimary });
  }
  return out;
}

export async function accessForAccount(db: SqlJsDatabase, id: string): Promise<AccountAccess | null> {
  const token = await resolveAccountToken(db, id);
  if (!token) return null;
  const primary = getPrimaryGitHubLogin(db);
  return { ...token, isPrimary: primary !== null && token.id.toLowerCase() === primary.toLowerCase() };
}

/**
 * The primary account with a usable token: its Jarvis sign-in, else its PAT or
 * GitHub CLI token — so a sign-in whose token can't be decrypted any more does
 * not switch off every single-account feature. Without a Jarvis sign-in the
 * primary is the GitHub CLI's active github.com account.
 */
export async function accessForPrimary(db: SqlJsDatabase): Promise<AccountAccess | null> {
  const primary = listAccounts(db, await listGhCliAccountsCached()).find((a) => a.isPrimary);
  if (!primary) return null;
  const token = await resolveAccountToken(db, primary.id);
  return token ? { ...token, isPrimary: true } : null;
}

/**
 * The account to use for a repo: its repo/owner assignment, else an account
 * that can see it, else the primary account. Falls back to the next candidate
 * when the preferred account has no credential. On another host than github.com
 * only an account of that host qualifies.
 */
export async function accessForRepo(
  db: SqlJsDatabase,
  repoFullName: string,
  host: string = hostOfRepo(db, repoFullName),
): Promise<AccountAccess | null> {
  const primary = getPrimaryGitHubLogin(db);
  const resolved = resolveAccountForRepo(db, hostKey(host, repoFullName), primary);
  const candidates: string[] = [];
  if (resolved && parseAccountId(resolved.login).host === host) candidates.push(resolved.login);
  if (primary && host === DEFAULT_HOST) candidates.push(primary);
  for (const id of candidates) {
    const access = await accessForAccount(db, id);
    if (access) return access;
  }
  if (host !== DEFAULT_HOST) {
    const onHost = (await listAccountsWithAccess(db)).find((a) => a.host === host);
    if (onHost) return onHost;
    return null;
  }
  // No Jarvis sign-in: the primary is the GitHub CLI's active account.
  return primary ? null : accessForPrimary(db);
}

/** The account for an owner (org or user): its owner assignment, else the primary account (or any account of its host). */
export async function accessForOwner(
  db: SqlJsDatabase,
  owner: string,
  host: string = hostOfOwner(db, owner),
): Promise<AccountAccess | null> {
  // `_` stands in for a repo name; no real repo assignment is expected to match it.
  return accessForRepo(db, `${owner}/_`, host);
}

/**
 * GitHub CLI tokens to retry with when `access` can't see a repo: the same
 * account's CLI token first (it can be SSO-authorized for an org the Jarvis
 * sign-in or PAT is not), then the other CLI accounts on that host. Tokens equal
 * to `access.token` are left out.
 */
export async function ghCliFallbacks(access: AccountToken | null, host: string = DEFAULT_HOST): Promise<AccountToken[]> {
  const own = access?.login.toLowerCase();
  // Same account first, then the CLI's active account, then the rest.
  const rank = (a: { login: string; active: boolean }): number => (a.login.toLowerCase() === own ? 0 : a.active ? 1 : 2);
  const accounts = (await listGhCliAccountsCached()).filter((a) => a.host === host).sort((a, b) => rank(a) - rank(b));
  const out: AccountToken[] = [];
  const seen = new Set(access ? [access.token] : []);
  for (const account of accounts) {
    const token = await getGhCliToken(account.login, host);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({ id: accountId(host, account.login), host, login: account.login, token, source: 'gh-cli' });
  }
  return out;
}
