import type { Database as SqlJsDatabase } from 'sql.js';
import { encrypt, decrypt, getEncryptionKey } from '../storage/encryption';

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
  console.log('[OAuth] pollForToken raw response:', JSON.stringify(data));

  if (data.error === 'authorization_pending') {
    return null;
  }

  if (data.error === 'slow_down') {
    // GitHub wants us to back off; it sends the new required interval in seconds
    if (flow && data.interval) {
      flow.intervalMs = (Number(data.interval) + 5) * 1000;
      console.log('[OAuth] slow_down — new interval:', flow.intervalMs, 'ms');
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
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER_API_URL, {
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

/**
 * Load the GitHub OAuth token from the database (decrypted).
 */
export function loadGitHubAuth(db: SqlJsDatabase): { login: string; accessToken: string; scopes: string; avatarUrl: string | null } | null {
  const stmt = db.prepare('SELECT login, access_token, scopes, avatar_url FROM github_auth ORDER BY created_at DESC LIMIT 1');

  if (!stmt.step()) {
    stmt.free();
    return null;
  }

  const row = stmt.getAsObject() as { login: string; access_token: string; scopes: string; avatar_url: string | null };
  stmt.free();

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
    console.warn('[OAuth] Failed to decrypt stored token — re-authentication required');
    return null;
  }
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
 * Load the decrypted Personal Access Token (if any).
 */
export function loadGitHubPat(db: SqlJsDatabase): string | null {
  const stmt = db.prepare('SELECT pat FROM github_auth ORDER BY created_at DESC LIMIT 1');
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject() as { pat: string | null };
  stmt.free();
  if (!row.pat) return null;
  const key = getEncryptionKey();
  try {
    return decrypt(row.pat, key);
  } catch {
    // Clear the undecryptable PAT so the warning does not repeat on every startup
    try { db.run('UPDATE github_auth SET pat = NULL WHERE rowid IN (SELECT rowid FROM github_auth ORDER BY created_at DESC LIMIT 1)'); } catch { /* best-effort */ }
    console.warn('[OAuth] Failed to decrypt stored PAT — it has been cleared and will need to be re-entered');
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
}
