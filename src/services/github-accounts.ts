// ── GitHub multi-account support ─────────────────────────────────────────────
//
// Jarvis can track several GitHub accounts, on github.com and on GHE.com hosts
// (see github-host.ts). Where they come from:
//
//  - Jarvis sign-ins: OAuth device flow and/or a PAT, stored in `github_auth`
//    (github.com only — GHE.com has no Jarvis OAuth app).
//  - PATs for accounts on other hosts, stored in `github_host_accounts`.
//  - The GitHub CLI: every `gh auth login` account. These are the ones that can
//    read the Copilot quota (see copilot-usage.ts).
//  - Git configuration: `credential.https://<host>/<owner>.username` in
//    ~/.gitconfig (or a repo's .git/config) says which account git itself uses
//    for an owner/repo. Jarvis imports that as the default owner → account
//    mapping, so discovery never asks twice.
//
// Accounts are identified by an account id (github-host.ts): the bare login on
// github.com, `login@host` elsewhere. Which account serves a repo resolves as:
// repo assignment → owner assignment → an account that discovered the repo (when
// the primary cannot see it) → the primary account. Manual assignments always
// beat imported ones.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { Database as SqlJsDatabase } from 'sql.js';
import { parseGitHubRemote } from './local-discovery';
import { encrypt, decryptSecret, getEncryptionKey } from '../storage/encryption';
import { getGhCliToken } from './copilot-usage';
import { listRepoViewers, recordRepoVisibility } from './github-repo-visibility';
import { getPrimaryGitHubLogin, listGitHubAuths, loadGitHubAuth, loadGitHubPat } from './github-oauth';
import type { GitHubAccountInfo } from '../plugins/types';
import {
  DEFAULT_HOST,
  accountId,
  hostKey,
  isSupportedHost,
  normalizeHost,
  parseAccountId,
  parseHostKey,
} from './github-host';

export type AssignmentScope = 'owner' | 'repo';
export type AssignmentSource = 'manual' | 'git-config';

export interface AccountAssignment {
  scope: AssignmentScope;
  /** Lowercase owner, or lowercase owner/repo. */
  key: string;
  login: string;
  source: AssignmentSource;
}

export interface GitCredentialHint {
  /** `owner`, `repo`, or `host` (a section for the whole host). */
  scope: AssignmentScope | 'host';
  host: string;
  /** {@link hostKey} of the owner or repo (lowercase; `host/…` off github.com); the host itself for `host`. */
  key: string;
  /** Account id (`login`, or `login@host` off github.com). */
  login: string;
}

// ── Git config parsing ───────────────────────────────────────────────────────

/**
 * Extract `credential "<url>"` → `username` pairs from git config text for
 * supported hosts (github.com, GHE.com). `https://github.com/xebia` is
 * owner-scoped, `https://github.com/xebia/repo` repo-scoped, a bare host
 * section applies to the whole host.
 */
export function parseGitCredentialUsernames(configText: string): GitCredentialHint[] {
  const hints = new Map<string, GitCredentialHint>();
  let section: string | null = null;

  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[\s*credential\s+"(.+)"\s*\]/i);
    if (header) {
      section = header[1];
      continue;
    }
    if (line.startsWith('[')) {
      section = null;
      continue;
    }
    if (!section) continue;

    const username = line.match(/^username\s*=\s*(.+)$/i);
    if (!username) continue;
    const login = username[1].trim().replace(/^"(.*)"$/, '$1');
    const url = section.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)(?:\/(.*?))?\/?$/i);
    if (!login || !url || !isSupportedHost(url[1])) continue;
    const host = normalizeHost(url[1])!;

    const segments = (url[2] ?? '').split('/').filter(Boolean).slice(0, 2);
    if (segments.length === 2) segments[1] = segments[1].replace(/\.git$/i, '');
    const scope: GitCredentialHint['scope'] = segments.length === 0 ? 'host' : segments.length === 1 ? 'owner' : 'repo';
    const key = scope === 'host' ? host : hostKey(host, segments.join('/'));
    hints.set(`${scope}:${key}`, { scope, host, key, login: accountId(host, login) });
  }
  return [...hints.values()];
}

/** The git config files git reads for the current user (global scope). */
export function globalGitConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(home, '.gitconfig'), path.join(xdg, 'git', 'config')];
}

/** Read git config files plus their plain `[include] path = …` targets (max depth 3). */
function readGitConfigText(files: string[], depth = 0): string {
  let out = '';
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    out += text + '\n';
    if (depth >= 3) continue;
    let inInclude = false;
    const includes: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) inInclude = /^\[\s*include\s*\]/i.test(line);
      else if (inInclude) {
        const m = line.match(/^path\s*=\s*(.+)$/i);
        if (m) {
          const p = m[1].trim().replace(/^"(.*)"$/, '$1');
          includes.push(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(path.dirname(file), p));
        }
      }
    }
    if (includes.length > 0) out += readGitConfigText(includes, depth + 1);
  }
  return out;
}

/** Owner/repo → account hints from the user's global git config. */
export function readGlobalGitCredentialHints(files: string[] = globalGitConfigPaths()): GitCredentialHint[] {
  return parseGitCredentialUsernames(readGitConfigText(files));
}

/** Repo-level hints from `<repoPath>/.git/config` (a bare `github.com` section applies to the repo itself). */
export function readRepoGitCredentialHints(repoPath: string): GitCredentialHint[] {
  return parseGitCredentialUsernames(readGitConfigText([path.join(repoPath, '.git', 'config')]));
}

// ── GitHub CLI accounts ──────────────────────────────────────────────────────

export interface GhCliAccount {
  host: string;
  login: string;
  /** The account `gh` uses on its host when no `--user` is given. */
  active: boolean;
}

/** Parse `gh auth status` output: accounts on supported hosts (github.com, GHE.com). */
export function parseGhAuthStatus(output: string): GhCliAccount[] {
  const accounts: GhCliAccount[] = [];
  let current: GhCliAccount | null = null;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const account = line.match(/Logged in to (\S+) account (\S+)/);
    if (account) {
      const host = normalizeHost(account[1]);
      current = host && isSupportedHost(host) ? { host, login: account[2], active: false } : null;
      if (current) accounts.push(current);
      continue;
    }
    if (current && /Active account:\s*true/i.test(line)) current.active = true;
  }
  return accounts;
}

/** Every supported-host account logged in to the GitHub CLI; empty when `gh` is missing or logged out. */
export function listGhCliAccounts(): Promise<GhCliAccount[]> {
  return new Promise((resolve) => {
    try {
      // `gh auth status` exits non-zero when any account has a problem, but still
      // prints every account — so parse stdout + stderr regardless of the error.
      execFile('gh', ['auth', 'status'], { timeout: 10_000, windowsHide: true }, (_err, stdout, stderr) => {
        resolve(parseGhAuthStatus(`${stdout ?? ''}
${stderr ?? ''}`));
      });
    } catch {
      resolve([]);
    }
  });
}

let ghCache: { at: number; accounts: GhCliAccount[] } | null = null;

/** {@link listGhCliAccounts} with a short cache — it spawns `gh`, and background tasks ask often. */
export async function listGhCliAccountsCached(ttlMs = 60_000): Promise<GhCliAccount[]> {
  if (ghCache && Date.now() - ghCache.at < ttlMs) return ghCache.accounts;
  const accounts = await listGhCliAccounts();
  ghCache = { at: Date.now(), accounts };
  return accounts;
}

// ── Assignments (owner / repo → account) ─────────────────────────────────────

function norm(value: string): string {
  return value.trim().toLowerCase();
}

export function listAssignments(db: SqlJsDatabase): AccountAssignment[] {
  const stmt = db.prepare('SELECT scope, key, login, source FROM github_account_assignments ORDER BY scope, key');
  const rows: AccountAssignment[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as AccountAssignment);
  stmt.free();
  return rows;
}

/**
 * Set (or, with `login` null, clear) the account for an owner or `owner/repo`.
 * `key` is a {@link hostKey}; `login` an account id.
 */
export function setAssignment(
  db: SqlJsDatabase,
  scope: AssignmentScope,
  key: string,
  login: string | null,
  source: AssignmentSource = 'manual',
): void {
  const k = norm(key);
  if (login === null) {
    db.run('DELETE FROM github_account_assignments WHERE scope = ? AND key = ?', [scope, k]);
    return;
  }
  db.run(
    `INSERT INTO github_account_assignments (scope, key, login, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET login = excluded.login, source = excluded.source, updated_at = CURRENT_TIMESTAMP`,
    [scope, k, login.trim(), source],
  );
}

export { recordRepoVisibility, listRepoViewers };

export interface ResolvedAccount {
  /** Account id. */
  login: string;
  via: 'repo' | 'owner' | 'discovered' | 'default';
  source: AssignmentSource | null;
}

/**
 * Which account should be used for a repo. `repoRef` is a {@link hostKey} of
 * `owner/repo` (bare on github.com). Null when nothing applies and there is no
 * default.
 */
export function resolveAccountForRepo(
  db: SqlJsDatabase,
  repoRef: string,
  defaultLogin: string | null,
): ResolvedAccount | null {
  const full = norm(repoRef);
  const { host, rest } = parseHostKey(full);
  const ownerKey = hostKey(host, rest.split('/')[0]);
  const stmt = db.prepare(
    `SELECT scope, login, source FROM github_account_assignments
     WHERE (scope = 'repo' AND key = ?) OR (scope = 'owner' AND key = ?)`,
  );
  stmt.bind([full, ownerKey]);
  let repoRow: { login: string; source: AssignmentSource } | null = null;
  let ownerRow: { login: string; source: AssignmentSource } | null = null;
  while (stmt.step()) {
    const r = stmt.getAsObject() as { scope: string; login: string; source: AssignmentSource };
    if (r.scope === 'repo') repoRow = r;
    else ownerRow = r;
  }
  stmt.free();

  if (repoRow) return { login: repoRow.login, via: 'repo', source: repoRow.source };
  if (ownerRow) return { login: ownerRow.login, via: 'owner', source: ownerRow.source };

  // Nothing assigned: keep the default when it can see the repo (or nobody knows
  // yet); otherwise use an account that actually can.
  const viewers = listRepoViewers(db, full);
  const defaultSees = defaultLogin !== null && viewers.some((v) => v.toLowerCase() === defaultLogin.toLowerCase());
  if (viewers.length > 0 && !defaultSees) return { login: viewers[0], via: 'discovered', source: null };
  return defaultLogin ? { login: defaultLogin, via: 'default', source: null } : null;
}

export interface GitConfigSyncResult {
  /** Assignments written or refreshed from git config. */
  imported: number;
  /** Hints skipped because the user already set that key manually. */
  keptManual: number;
}

/**
 * Import git-config account hints as assignments: the global config's owner/repo
 * sections, plus each discovered local repo's own `.git/config` (a host-wide
 * section there pins the repo's remotes on that host to that account). Manual
 * assignments are never overwritten.
 */
export function syncGitConfigAssignments(
  db: SqlJsDatabase,
  opts: { globalFiles?: string[]; localRepos?: Array<{ localPath: string; remoteUrls: string[] }> } = {},
): GitConfigSyncResult {
  const wanted = new Map<string, { scope: AssignmentScope; key: string; login: string }>();
  const add = (scope: AssignmentScope, key: string, login: string) => wanted.set(`${scope}:${key}`, { scope, key, login });

  for (const hint of readGlobalGitCredentialHints(opts.globalFiles)) {
    if (hint.scope !== 'host') add(hint.scope, hint.key, hint.login);
  }
  for (const repo of opts.localRepos ?? []) {
    const remotes = repo.remoteUrls
      .map(parseGitHubRemote)
      .filter((r): r is { host: string; fullName: string } => r !== null)
      .map((r) => ({ host: r.host, ref: hostKey(r.host, r.fullName) }));
    for (const hint of readRepoGitCredentialHints(repo.localPath)) {
      if (hint.scope === 'host') {
        for (const r of remotes.filter((x) => x.host === hint.host)) add('repo', r.ref, hint.login);
      } else if (hint.scope === 'owner') {
        const { rest } = parseHostKey(hint.key);
        for (const r of remotes.filter((x) => x.host === hint.host && parseHostKey(x.ref).rest.startsWith(`${rest}/`))) {
          add('repo', r.ref, hint.login);
        }
      } else {
        add('repo', hint.key, hint.login);
      }
    }
  }

  const existing = new Map(listAssignments(db).map((a) => [`${a.scope}:${a.key}`, a]));
  const result: GitConfigSyncResult = { imported: 0, keptManual: 0 };
  for (const [id, hint] of wanted) {
    if (existing.get(id)?.source === 'manual') {
      result.keptManual++;
      continue;
    }
    setAssignment(db, hint.scope, hint.key, hint.login, 'git-config');
    result.imported++;
  }
  return result;
}

/** Local repos (path + remote URLs) known to the database, for {@link syncGitConfigAssignments}. */
export function listLocalReposForSync(db: SqlJsDatabase): Array<{ localPath: string; remoteUrls: string[] }> {
  const stmt = db.prepare(
    `SELECT r.local_path AS local_path, COALESCE(GROUP_CONCAT(m.url, char(10)), r.remote_url, '') AS urls
     FROM local_repos r LEFT JOIN local_repo_remotes m ON m.local_repo_id = r.id
     GROUP BY r.id`,
  );
  const rows: Array<{ localPath: string; remoteUrls: string[] }> = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as { local_path: string; urls: string };
    rows.push({ localPath: r.local_path, remoteUrls: r.urls.split('\n').filter(Boolean) });
  }
  stmt.free();
  return rows;
}

// ── PAT accounts on other hosts ──────────────────────────────────────────────

export interface HostAccount {
  id: string;
  host: string;
  login: string;
  avatarUrl: string | null;
}

/** Save (or replace) the encrypted PAT of `login` on a non-github.com `host`. Returns the account id. */
export function saveHostAccountPat(
  db: SqlJsDatabase,
  host: string,
  login: string,
  pat: string,
  avatarUrl?: string | null,
): string {
  const h = normalizeHost(host);
  if (!h || h === DEFAULT_HOST || !isSupportedHost(h)) throw new Error(`Unsupported GitHub host: ${host}`);
  const id = accountId(h, login);
  db.run(
    `INSERT INTO github_host_accounts (id, host, login, pat, avatar_url) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET pat = excluded.pat, avatar_url = COALESCE(excluded.avatar_url, github_host_accounts.avatar_url)`,
    [id, h, login, encrypt(pat, getEncryptionKey()), avatarUrl ?? null],
  );
  return id;
}

export function listHostAccounts(db: SqlJsDatabase): HostAccount[] {
  const stmt = db.prepare('SELECT id, host, login, avatar_url FROM github_host_accounts ORDER BY created_at, id');
  const rows: HostAccount[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as { id: string; host: string; login: string; avatar_url: string | null };
    rows.push({ id: r.id, host: r.host, login: r.login, avatarUrl: r.avatar_url });
  }
  stmt.free();
  return rows;
}

export function loadHostAccountPat(db: SqlJsDatabase, id: string): string | null {
  const stmt = db.prepare('SELECT pat FROM github_host_accounts WHERE id = ? COLLATE NOCASE');
  stmt.bind([id]);
  const row = stmt.step() ? (stmt.getAsObject() as { pat: string | null }) : null;
  stmt.free();
  if (!row?.pat) return null;
  try {
    const { value, stale } = decryptSecret(row.pat);
    // Recovered with an archived key — move it to the current one
    if (stale) db.run('UPDATE github_host_accounts SET pat = ? WHERE id = ? COLLATE NOCASE', [encrypt(value, getEncryptionKey()), id]);
    return value;
  } catch {
    return null;
  }
}

export function deleteHostAccount(db: SqlJsDatabase, id: string): void {
  db.run('DELETE FROM github_host_accounts WHERE id = ? COLLATE NOCASE', [id]);
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export interface AccountToken {
  /** Account id. */
  id: string;
  host: string;
  login: string;
  token: string;
  source: 'oauth' | 'pat' | 'gh-cli';
}

/**
 * A usable token for an account: Jarvis' own sign-in first, then its PAT, then
 * the GitHub CLI's. Null when the account has no credential at all.
 */
export async function resolveAccountToken(db: SqlJsDatabase, id: string): Promise<AccountToken | null> {
  const { host, login } = parseAccountId(id);
  if (host === DEFAULT_HOST) {
    const oauth = loadGitHubAuth(db, login);
    if (oauth) return { id, host, login, token: oauth.accessToken, source: 'oauth' };
  }
  const pat = host === DEFAULT_HOST ? loadGitHubPat(db, login) : loadHostAccountPat(db, id);
  if (pat) return { id, host, login, token: pat, source: 'pat' };
  const gh = await getGhCliToken(login, host);
  return gh ? { id, host, login, token: gh, source: 'gh-cli' } : null;
}

// ── Account list ─────────────────────────────────────────────────────────────

/** Every account Jarvis can act as: Jarvis sign-ins, host PATs and GitHub CLI logins, merged by account id. */
export function listAccounts(db: SqlJsDatabase, ghAccounts: GhCliAccount[]): GitHubAccountInfo[] {
  const byId = new Map<string, GitHubAccountInfo>();
  const entry = (host: string, login: string): GitHubAccountInfo => {
    const id = accountId(host, login);
    let info = byId.get(id.toLowerCase());
    if (!info) {
      info = { id, host, login, avatarUrl: null, isPrimary: false, sources: [], ghActive: false };
      byId.set(id.toLowerCase(), info);
    }
    return info;
  };

  for (const auth of listGitHubAuths(db)) {
    const info = entry(DEFAULT_HOST, auth.login);
    info.avatarUrl = auth.avatarUrl;
    info.sources.push('oauth');
    if (auth.hasPat) info.sources.push('pat');
    if (!auth.tokenReadable) info.signInUnreadable = true;
  }
  for (const acct of listHostAccounts(db)) {
    const info = entry(acct.host, acct.login);
    info.avatarUrl = acct.avatarUrl;
    info.sources.push('pat');
  }
  for (const gh of ghAccounts) {
    const info = entry(gh.host, gh.login);
    info.sources.push('gh-cli');
    info.ghActive = gh.active;
  }

  // Single-account features talk to github.com, so only a github.com account can be primary.
  const primary = getPrimaryGitHubLogin(db) ?? ghAccounts.find((a) => a.host === DEFAULT_HOST && a.active)?.login ?? null;
  if (primary) entry(DEFAULT_HOST, primary).isPrimary = true;
  return [...byId.values()].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.id.localeCompare(b.id));
}

/** The primary account's id (github.com), or null. */
export function primaryAccountId(db: SqlJsDatabase, ghAccounts: GhCliAccount[]): string | null {
  return listAccounts(db, ghAccounts).find((a) => a.isPrimary)?.id ?? null;
}
