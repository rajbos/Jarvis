import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { saveGitHubAuth, loadGitHubAuth, saveGitHubPat, loadGitHubPat, deleteGitHubPat } from '../../src/services/github-oauth';

describe('GitHub OAuth — Token Storage', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    // Set a deterministic encryption key for tests
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('should save and load an encrypted token', () => {
    const login = 'testuser';
    const token = 'ghp_real_access_token_12345';
    const scopes = 'repo,read:org';

    saveGitHubAuth(db, login, token, scopes);

    // Verify the token is stored encrypted (not plaintext)
    const stmt = db.prepare('SELECT access_token FROM github_auth WHERE login = ?');
    stmt.bind([login]);
    stmt.step();
    const rawRow = stmt.getAsObject() as { access_token: string };
    stmt.free();
    expect(rawRow.access_token).not.toBe(token);

    // Load and decrypt
    const loaded = loadGitHubAuth(db);
    expect(loaded).not.toBeNull();
    expect(loaded!.login).toBe(login);
    expect(loaded!.accessToken).toBe(token);
    expect(loaded!.scopes).toBe(scopes);
  });

  it('should return null when no auth exists', () => {
    const loaded = loadGitHubAuth(db);
    expect(loaded).toBeNull();
  });

  it('should upsert on conflict (same login)', () => {
    saveGitHubAuth(db, 'user1', 'token_v1', 'repo');
    saveGitHubAuth(db, 'user1', 'token_v2', 'repo,read:org');

    const loaded = loadGitHubAuth(db);
    expect(loaded!.accessToken).toBe('token_v2');
    expect(loaded!.scopes).toBe('repo,read:org');

    // Should only have one row
    const result = db.exec('SELECT COUNT(*) as cnt FROM github_auth');
    expect(result[0].values[0][0]).toBe(1);
  });

  it('should save, load, and delete a PAT', () => {
    saveGitHubAuth(db, 'user1', 'token1', 'repo');
    expect(loadGitHubPat(db)).toBeNull();

    saveGitHubPat(db, 'user1', 'ghp_mypat123');
    expect(loadGitHubPat(db)).toBe('ghp_mypat123');

    // Verify stored encrypted
    const stmt = db.prepare('SELECT pat FROM github_auth WHERE login = ?');
    stmt.bind(['user1']);
    stmt.step();
    const row = stmt.getAsObject() as { pat: string };
    stmt.free();
    expect(row.pat).not.toBe('ghp_mypat123');

    deleteGitHubPat(db, 'user1');
    expect(loadGitHubPat(db)).toBeNull();
  });
});

// ── OAuth Device Flow — fetch-based functions ─────────────────────────────────
import { vi } from 'vitest';
import {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  deleteGitHubAuth,
} from '../../src/services/github-oauth';

describe('requestDeviceCode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns device code response on success', async () => {
    const mockResponse = { device_code: 'abc', user_code: 'XYZ-123', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const result = await requestDeviceCode('client-id', ['repo']);
    expect(result.device_code).toBe('abc');
    expect(result.user_code).toBe('XYZ-123');
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Bad Request', { status: 400, statusText: 'Bad Request' }),
    );
    await expect(requestDeviceCode('client-id', ['repo'])).rejects.toThrow('Failed to request device code: 400');
  });
});

describe('pollForToken', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null when authorization is pending', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 }),
    );
    const result = await pollForToken('client-id', 'device-code');
    expect(result).toBeNull();
  });

  it('returns null and adjusts interval on slow_down', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'slow_down', interval: '10' }), { status: 200 }),
    );
    const flow = { intervalMs: 5000 };
    const result = await pollForToken('client-id', 'device-code', flow);
    expect(result).toBeNull();
    expect(flow.intervalMs).toBeGreaterThan(5000);
  });

  it('returns the token on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'gho_abc', token_type: 'bearer', scope: 'repo' }), { status: 200 }),
    );
    const result = await pollForToken('client-id', 'device-code');
    expect(result?.access_token).toBe('gho_abc');
  });

  it('throws on OAuth error response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'expired_token', error_description: 'The device code has expired' }), { status: 200 }),
    );
    await expect(pollForToken('client-id', 'device-code')).rejects.toThrow('OAuth error: expired_token');
  });

  it('throws on non-OK HTTP status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Server Error', { status: 500 }),
    );
    await expect(pollForToken('client-id', 'device-code')).rejects.toThrow('Token poll failed: 500');
  });
});

describe('fetchGitHubUser', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns user data on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ login: 'octocat', name: 'Octocat', avatar_url: 'https://avatars.example.com/octocat' }), { status: 200 }),
    );
    const user = await fetchGitHubUser('gho_token');
    expect(user.login).toBe('octocat');
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401 }),
    );
    await expect(fetchGitHubUser('bad-token')).rejects.toThrow('Failed to fetch user: 401');
  });
});

describe('deleteGitHubAuth', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-key-for-delete';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('removes all github_auth rows', () => {
    saveGitHubAuth(db, 'octocat', 'token123', 'repo');
    deleteGitHubAuth(db);
    const result = loadGitHubAuth(db);
    expect(result).toBeNull();
  });

  it('does not throw when no auth exists', () => {
    expect(() => deleteGitHubAuth(db)).not.toThrow();
  });
});
