import type { Database as SqlJsDatabase } from 'sql.js';
import { encrypt, decrypt, getEncryptionKey } from '../storage/encryption';
import { getConfigValue, setConfigValue } from '../storage/database';
import { logger } from './logger';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_API_URL = 'https://api.github.com/user';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface OAuthToken {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

/**
 * Step 1: Request a device code from GitHub.
 */
export async function requestDeviceCode(clientId: string, scopes: string[]): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(' '),
  });

  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to request device code: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

/**
 * Step 2: Poll GitHub for the access token until the user authorizes.
 * Returns null if still pending (caller should retry after intervalMs).
 * Mutates `flow.intervalMs` when GitHub requests slow_down.
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  flow?: { intervalMs: number },
): Promise<OAuthToken | null> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token poll failed: ${response.status}`);
  }

  const data = await response.json() as Record<string, string>;
  // Never log the raw response: on success it contains the plaintext access_token.
  logger.debug('[OAuth] pollForToken response:', data.error ?? (data.access_token ? 'token received' : 'no token'));

  if (data.error === 'authorization_pending') {
    return null;
  }

  if (data.error === 'slow_down') {
    // GitHub wants us to back off; it sends the new required interval in seconds
    if (flow && data.interval) {
      flow.intervalMs = (Number(data.interval) + 5) * 1000;
      logger.debug('[OAuth] slow_down — new interval:', flow.intervalMs, 'ms');
    }
    return null;
  }

  if (data.error) {
    throw new Error(`OAuth error: ${data.error} — ${data.error_description}`);
  }

  return {
    access_token: data.access_token,
    token_type: data.token_type,
    scope: data.scope,
  };
}

/**
 * Step 3: Fetch the authenticated user's profile.
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {  const response = await fetch(GITHUB_USER_API_URL, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'Jarvis-Agent/0.1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

/**
 * Result of validating a PAT against the GitHub API.
 * - 'valid': the token works and the user profile was returned.
 * - 'expired': GitHub answered 401 — the token has expired or been revoked.
 * - 'unknown': we could not determine validity (network failure, 5xx, …), so
 *   callers should not alarm the user about a token that may still be fine.
 */
export type PatValidation =
  | { status: 'valid'; user: GitHubUser }
  | { status: 'expired' }
  | { status: 'unknown'; error: string };

/**
 * Validate a Personal Access Token against the GitHub API.
 */
export async function validateGitHubPat(pat: string): Promise<PatValidation> {
  let response: Response;
  try {
    response = await fetch(GITHUB_USER_API_URL, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/json',
        'User-Agent': 'Jarvis-Agent/0.1.0',
      },
    });
  } catch (err) {
    return { status: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }

  if (response.status === 401) {
    return { status: 'expired' };
  }
  if (!response.ok) {
    return { status: 'unknown', error: `HTTP ${response.status}` };
  }

  try {
    const user = (await response.json()) as GitHubUser;
    return { status: 'valid', user };
  } catch (err) {
    return { status: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Save the GitHub OAuth token to the database (encrypted).
 */
export function saveGitHubAuth(
  db: SqlJsDatabase,
  login: string,
  accessToken: string,
  scopes: string,
  avatarUrl?: string,
): void {
  const key = getEncryptionKey();
  const encryptedToken = encrypt(accessToken, key);

  db.run(
    `INSERT INTO github_auth (login, access_token, scopes, avatar_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(login) DO UPDATE SET
       access_token = excluded.access_token,
       scopes = excluded.scopes,
       avatar_url = excluded.avatar_url,
       created_at = CURRENT_TIMESTAMP`,
    [login, encryptedToken, scopes, avatarUrl || null],
  );
}

const KEY_PRIMARY_LOGIN = 'github_primary_login';

interface AuthRow {
  login: string;
  access_token: string;
  scopes: string;
  avatar_url: string | null;
  pat: string | null;
}

/**
 * Pick the stored sign-in a caller means: the named `login`, else the primary
 * account (see {@link setPrimaryGitHubLogin}), else the most recent sign-in.
 */
function selectAuthRow(db: SqlJsDatabase, login?: string): AuthRow | null {
  const wanted = login ?? getConfigValue(db, KEY_PRIMARY_LOGIN) ?? undefined;
  const run = (sql: string, params: string[]): AuthRow | null => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? (stmt.getAsObject() as unknown as AuthRow) : null;
    stmt.free();
    return row;
  };
  const columns = 'SELECT login, access_token, scopes, avatar_url, pat FROM github_auth';
  if (wanted) {
    const row = run(`${columns} WHERE login = ? COLLATE NOCASE`, [wanted]);
    if (row || login) return row;
  }
  return run(`${columns} ORDER BY created_at DESC, id DESC LIMIT 1`, []);
}

export interface StoredGitHubAuth {
  login: string;
  accessToken: string;
  scopes: string;
  avatarUrl: string | null;
}

function decryptAuthRow(row: AuthRow): StoredGitHubAuth | null {
  const key = getEncryptionKey();
  try {
    return {
      login: row.login,
      accessToken: decrypt(row.access_token, key),
      scopes: row.scopes,
      avatarUrl: row.avatar_url,
    };
  } catch {
    // Decryption failed — the key changed (e.g. first run after upgrading to
    // safeStorage). Return null so the caller prompts re-authentication.
    logger.warn('[OAuth] Failed to decrypt stored token — re-authentication required');
    return null;
  }
}

/**
 * Load the GitHub OAuth token from the database (decrypted): the named
 * `login`'s, or the primary account's when omitted.
 */
export function loadGitHubAuth(db: SqlJsDatabase, login?: string): StoredGitHubAuth | null {
  const row = selectAuthRow(db, login);
  return row ? decryptAuthRow(row) : null;
}

/** Login of the primary account — the one every single-account feature uses. */
export function getPrimaryGitHubLogin(db: SqlJsDatabase): string | null {
  return selectAuthRow(db)?.login ?? null;
}

/** Make `login` (must already be signed in) the primary account. */
export function setPrimaryGitHubLogin(db: SqlJsDatabase, login: string): boolean {
  const row = selectAuthRow(db, login);
  if (!row) return false;
  setConfigValue(db, KEY_PRIMARY_LOGIN, row.login);
  return true;
}

/** Every account signed in through Jarvis (OAuth and/or PAT), without tokens. */
export function listGitHubAuths(db: SqlJsDatabase): Array<{ login: string; scopes: string; avatarUrl: string | null; hasPat: boolean }> {
  const stmt = db.prepare('SELECT login, scopes, avatar_url, pat FROM github_auth ORDER BY id ASC');
  const rows: Array<{ login: string; scopes: string; avatarUrl: string | null; hasPat: boolean }> = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as AuthRow;
    rows.push({ login: r.login, scopes: r.scopes ?? '', avatarUrl: r.avatar_url, hasPat: !!r.pat });
  }
  stmt.free();
  return rows;
}

/**
 * Save an encrypted Personal Access Token for the authenticated user.
 */
export function saveGitHubPat(db: SqlJsDatabase, login: string, pat: string): void {
  const key = getEncryptionKey();
  const encryptedPat = encrypt(pat, key);
  db.run('UPDATE github_auth SET pat = ? WHERE login = ?', [encryptedPat, login]);
}

/**
 * Load the decrypted Personal Access Token (if any): the named `login`'s, or
 * the primary account's when omitted.
 */
export function loadGitHubPat(db: SqlJsDatabase, login?: string): string | null {
  const row = selectAuthRow(db, login);
  if (!row?.pat) return null;
  const key = getEncryptionKey();
  try {
    return decrypt(row.pat, key);
  } catch {
    // Clear the undecryptable PAT so the warning does not repeat on every startup
    try { db.run('UPDATE github_auth SET pat = NULL WHERE login = ?', [row.login]); } catch { /* best-effort */ }
    logger.warn('[OAuth] Failed to decrypt stored PAT — it has been cleared and will need to be re-entered');
    return null;
  }
}

/**
 * Remove the stored PAT for the authenticated user.
 */
export function deleteGitHubPat(db: SqlJsDatabase, login: string): void {
  db.run('UPDATE github_auth SET pat = NULL WHERE login = ?', [login]);
}

/**
 * Remove all GitHub OAuth session data (logout).
 */
export function deleteGitHubAuth(db: SqlJsDatabase): void {
  db.run('DELETE FROM github_auth');
  db.run('DELETE FROM config WHERE key = ?', [KEY_PRIMARY_LOGIN]);
}

/**
 * Remove one account's sign-in (and PAT). When it was the primary account the
 * primary setting is cleared, so the most recent remaining sign-in takes over.
 */
export function deleteGitHubAuthFor(db: SqlJsDatabase, login: string): void {
  db.run('DELETE FROM github_auth WHERE login = ? COLLATE NOCASE', [login]);
  db.run('DELETE FROM config WHERE key = ? AND value = ? COLLATE NOCASE', [KEY_PRIMARY_LOGIN, login]);
}
