// ── Claude IPC handlers ───────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import {
  loadClaudeCodeCredentials,
  refreshClaudeToken,
  checkClaudeRateLimit,
  isTokenExpired,
  type ClaudeCredentials,
} from '../../services/claude';
import { getConfigValue, setConfigValue, saveDatabase } from '../../storage/database';
import { encrypt, decrypt, getEncryptionKey } from '../../storage/encryption';

// Config keys for the cached (encrypted) copy of refreshed OAuth tokens.
// We never write back to Claude Code's credentials file; refreshed tokens
// are kept here instead.
const KEY_ACCESS = 'claude_access_token_enc';
const KEY_REFRESH = 'claude_refresh_token_enc';
const KEY_EXPIRES = 'claude_expires_at';
const KEY_SUBSCRIPTION = 'claude_subscription_type';

function loadStoredCredentials(db: SqlJsDatabase): ClaudeCredentials | null {
  const encAccess = getConfigValue(db, KEY_ACCESS);
  if (!encAccess) return null;
  const key = getEncryptionKey();
  try {
    const encRefresh = getConfigValue(db, KEY_REFRESH);
    const expiresRaw = getConfigValue(db, KEY_EXPIRES);
    return {
      accessToken: decrypt(encAccess, key),
      refreshToken: encRefresh ? decrypt(encRefresh, key) : undefined,
      expiresAt: expiresRaw !== null ? Number(expiresRaw) : undefined,
      subscriptionType: getConfigValue(db, KEY_SUBSCRIPTION) ?? undefined,
    };
  } catch {
    console.warn('[Claude] Failed to decrypt stored token — clearing it');
    clearStoredCredentials(db);
    return null;
  }
}

function storeCredentials(db: SqlJsDatabase, creds: ClaudeCredentials): void {
  const key = getEncryptionKey();
  setConfigValue(db, KEY_ACCESS, encrypt(creds.accessToken, key));
  if (creds.refreshToken) setConfigValue(db, KEY_REFRESH, encrypt(creds.refreshToken, key));
  if (creds.expiresAt !== undefined) setConfigValue(db, KEY_EXPIRES, String(creds.expiresAt));
  if (creds.subscriptionType) setConfigValue(db, KEY_SUBSCRIPTION, creds.subscriptionType);
  saveDatabase();
}

function clearStoredCredentials(db: SqlJsDatabase): void {
  db.run(`DELETE FROM config WHERE key IN (?, ?, ?, ?)`, [KEY_ACCESS, KEY_REFRESH, KEY_EXPIRES, KEY_SUBSCRIPTION]);
  saveDatabase();
}

/**
 * Resolve a usable access token. Order:
 *   1. cached refreshed token (still valid)
 *   2. Claude Code credentials file (still valid)
 *   3. refresh via cached refresh token
 *   4. refresh via the file's refresh token (persisted on success)
 */
async function resolveAccessToken(
  db: SqlJsDatabase,
): Promise<{ token: string; source: 'stored' | 'claude-code'; subscriptionType?: string; expiresAt?: number } | null> {
  const stored = loadStoredCredentials(db);
  if (stored && !isTokenExpired(stored.expiresAt)) {
    return { token: stored.accessToken, source: 'stored', subscriptionType: stored.subscriptionType, expiresAt: stored.expiresAt };
  }

  const fromFile = loadClaudeCodeCredentials();
  if (fromFile && !isTokenExpired(fromFile.expiresAt)) {
    return { token: fromFile.accessToken, source: 'claude-code', subscriptionType: fromFile.subscriptionType, expiresAt: fromFile.expiresAt };
  }

  const refreshToken = stored?.refreshToken ?? fromFile?.refreshToken;
  if (refreshToken) {
    const refreshed = await refreshClaudeToken(refreshToken);
    if (refreshed) {
      const creds: ClaudeCredentials = { ...refreshed, subscriptionType: fromFile?.subscriptionType ?? stored?.subscriptionType };
      storeCredentials(db, creds);
      return { token: creds.accessToken, source: 'stored', subscriptionType: creds.subscriptionType, expiresAt: creds.expiresAt };
    }
  }

  return null;
}

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('claude:status', async () => {
    try {
      const resolved = await resolveAccessToken(db);
      if (!resolved) {
        const fileExists = loadClaudeCodeCredentials() !== null;
        return {
          connected: false,
          error: fileExists
            ? 'Claude Code credentials found but expired — open Claude Code once to refresh them.'
            : 'No Claude Code credentials found (~/.claude/.credentials.json). Sign in with Claude Code first.',
        };
      }
      return {
        connected: true,
        subscriptionType: resolved.subscriptionType,
        expiresAt: resolved.expiresAt,
        source: resolved.source,
      };
    } catch (err) {
      console.error('[claude] claude:status error:', err);
      return { connected: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('claude:rate-limit', async () => {
    const fetchedAt = new Date().toISOString();
    try {
      const resolved = await resolveAccessToken(db);
      if (!resolved) {
        return {
          configured: false,
          limited: false,
          resetAt: null,
          retryAfterSec: null,
          fiveHour: null,
          sevenDay: null,
          fetchedAt,
        };
      }

      let probe = await checkClaudeRateLimit(resolved.token);

      // An expired token can slip past the skew check (clock drift); refresh once and retry.
      if (probe.status === 401) {
        clearStoredCredentials(db);
        const retried = await resolveAccessToken(db);
        if (retried && retried.token !== resolved.token) {
          probe = await checkClaudeRateLimit(retried.token);
        }
      }

      return {
        configured: true,
        limited: probe.limited,
        resetAt: probe.resetAt,
        retryAfterSec: probe.retryAfterSec,
        fiveHour: probe.fiveHour,
        sevenDay: probe.sevenDay,
        error: probe.error,
        fetchedAt,
      };
    } catch (err) {
      console.error('[claude] claude:rate-limit error:', err);
      return {
        configured: true,
        limited: false,
        resetAt: null,
        retryAfterSec: null,
        fiveHour: null,
        sevenDay: null,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt,
      };
    }
  });

  ipcMain.handle('claude:disconnect', () => {
    clearStoredCredentials(db);
    return { ok: true };
  });
}
