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
