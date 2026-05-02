/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  searchSecrets,
  listSecretFavorites,
  addSecretFavorite,
  removeSecretFavorite,
  listSecretsForRepo,
  scanUserRepoSecrets,
} from '../../src/services/github-secrets';

// Mock saveDatabase — it talks to the filesystem
vi.mock('../../src/storage/database', () => ({
  saveDatabase: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function insertRepo(db: SqlJsDatabase, opts: { id: number; fullName: string; orgId?: number }): void {
  const name = opts.fullName.split('/').pop() ?? opts.fullName;
  db.run(
    `INSERT INTO github_repos (id, full_name, name, org_id) VALUES (?, ?, ?, ?)`,
    [opts.id, opts.fullName, name, opts.orgId ?? null],
  );
}

function insertOrg(db: SqlJsDatabase, id: number, login: string): void {
  db.run(
    `INSERT INTO github_orgs (id, login, name) VALUES (?, ?, ?)`,
    [id, login, login],
  );
}

function insertSecret(db: SqlJsDatabase, repoId: number, secretName: string): void {
  db.run(
    `INSERT INTO repo_secrets (github_repo_id, secret_name, scanned_at) VALUES (?, ?, datetime('now'))`,
    [repoId, secretName],
  );
}

// ── searchSecrets ─────────────────────────────────────────────────────────────

describe('searchSecrets', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    insertRepo(db, { id: 1, fullName: 'alice/backend' });
    insertRepo(db, { id: 2, fullName: 'alice/frontend' });
    insertSecret(db, 1, 'AWS_ACCESS_KEY');
    insertSecret(db, 1, 'AWS_SECRET_KEY');
    insertSecret(db, 2, 'GITHUB_TOKEN');
  });

  afterEach(() => db.close());

  it('finds secrets matching a substring pattern', () => {
    const rows = searchSecrets(db, 'AWS');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.secret_name)).toContain('AWS_ACCESS_KEY');
    expect(rows.map((r) => r.secret_name)).toContain('AWS_SECRET_KEY');
  });

  it('is case-insensitive', () => {
    const rows = searchSecrets(db, 'aws');
    expect(rows).toHaveLength(2);
  });

  it('returns empty array when no secrets match', () => {
    expect(searchSecrets(db, 'NONEXISTENT')).toHaveLength(0);
  });

  it('includes full_name in results', () => {
    const rows = searchSecrets(db, 'GITHUB');
    expect(rows[0].full_name).toBe('alice/frontend');
  });

  it('returns all secrets when pattern is empty string', () => {
    const rows = searchSecrets(db, '');
    expect(rows).toHaveLength(3);
  });
});

// ── listSecretsForRepo ────────────────────────────────────────────────────────

describe('listSecretsForRepo', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    insertRepo(db, { id: 1, fullName: 'alice/backend' });
    insertRepo(db, { id: 2, fullName: 'alice/frontend' });
    insertSecret(db, 1, 'BACKEND_SECRET');
    insertSecret(db, 2, 'FRONTEND_SECRET');
  });

  afterEach(() => db.close());

  it('returns secrets only for the specified repo', () => {
    const rows = listSecretsForRepo(db, 'alice/backend');
    expect(rows).toHaveLength(1);
    expect(rows[0].secret_name).toBe('BACKEND_SECRET');
  });

  it('returns empty array for repo with no secrets', () => {
    expect(listSecretsForRepo(db, 'nobody/nothing')).toHaveLength(0);
  });
});

// ── Secret Favorites CRUD ─────────────────────────────────────────────────────

describe('Secret Favorites — listSecretFavorites', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('returns empty array when no favorites exist', () => {
    expect(listSecretFavorites(db)).toHaveLength(0);
  });

  it('returns favorites sorted by type then name', () => {
    addSecretFavorite(db, 'repo', 'alice/backend');
    addSecretFavorite(db, 'org', 'myorg');
    addSecretFavorite(db, 'repo', 'alice/frontend');

    const rows = listSecretFavorites(db);
    expect(rows[0].target_type).toBe('org');
    expect(rows[0].target_name).toBe('myorg');
    expect(rows[1].target_name).toBe('alice/backend');
    expect(rows[2].target_name).toBe('alice/frontend');
  });
});

describe('Secret Favorites — addSecretFavorite', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('adds a repo favorite', () => {
    addSecretFavorite(db, 'repo', 'alice/backend');
    const rows = listSecretFavorites(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].target_type).toBe('repo');
    expect(rows[0].target_name).toBe('alice/backend');
  });

  it('adds an org favorite', () => {
    addSecretFavorite(db, 'org', 'myorg');
    const rows = listSecretFavorites(db);
    expect(rows[0].target_type).toBe('org');
  });

  it('does not insert duplicates (INSERT OR IGNORE)', () => {
    addSecretFavorite(db, 'repo', 'alice/backend');
    addSecretFavorite(db, 'repo', 'alice/backend');
    expect(listSecretFavorites(db)).toHaveLength(1);
  });
});

describe('Secret Favorites — removeSecretFavorite', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    addSecretFavorite(db, 'repo', 'alice/backend');
    addSecretFavorite(db, 'org', 'myorg');
  });

  afterEach(() => db.close());

  it('removes the specified favorite', () => {
    removeSecretFavorite(db, 'alice/backend');
    const rows = listSecretFavorites(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].target_name).toBe('myorg');
  });

  it('does not throw when removing a non-existent favorite', () => {
    expect(() => removeSecretFavorite(db, 'nobody/nothing')).not.toThrow();
  });
});

// ── scanUserRepoSecrets ───────────────────────────────────────────────────────

describe('scanUserRepoSecrets', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    insertRepo(db, { id: 1, fullName: 'alice/myapp' });
    insertRepo(db, { id: 2, fullName: 'alice/tool' });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('stores discovered secrets for personal repos', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ secrets: [{ name: 'MY_SECRET' }] }), { status: 200 }),
    );

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice');
    expect(result.scanned).toBe(2);
    expect(result.secretsFound).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = listSecretsForRepo(db, 'alice/myapp');
    expect(rows[0].secret_name).toBe('MY_SECRET');
  });

  it('records errors for failed API calls without aborting the whole scan', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Server Error', { status: 500 }),
    );

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice');
    expect(result.errors).toHaveLength(2);
    expect(result.secretsFound).toBe(0);
  });

  it('skips repos that return 403/404 when no PAT is configured', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403 }),
    );

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice');
    expect(result.errors).toHaveLength(0);
    expect(result.secretsFound).toBe(0);
  });

  it('retries with PAT when OAuth returns 403', async () => {
    globalThis.fetch = vi.fn()
      // First call (OAuth) → 403
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      // Second call (PAT retry for repo 1) → success
      .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [{ name: 'ORG_SECRET' }] }), { status: 200 }))
      // Third call (OAuth) for repo 2 → 403
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      // Fourth call (PAT retry for repo 2) → success
      .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [{ name: 'ORG_SECRET_2' }] }), { status: 200 }));

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice', undefined, 'ghp_pat');
    expect(result.errors).toHaveLength(0);
    expect(result.secretsFound).toBe(2);
  });

  it('retries with PAT when OAuth returns 404', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [{ name: 'FOUND' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [] }), { status: 200 }));

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice', undefined, 'ghp_pat');
    expect(result.secretsFound).toBe(1);
  });

  it('does not retry with PAT when OAuth and PAT tokens are the same', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('Forbidden', { status: 403 }),
    );
    globalThis.fetch = fetchMock;

    // passing the same token as both oauth and pat should not double-fetch
    await scanUserRepoSecrets(db, 'same_token', 'alice', undefined, 'same_token');
    // Only 2 OAuth calls, no PAT retries (2 repos)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('calls onProgress callback', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ secrets: [] }), { status: 200 }),
    );

    const progressCalls: number[] = [];
    await scanUserRepoSecrets(db, 'gho_oauth', 'alice', (done) => {
      progressCalls.push(done);
    });

    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('includes secrets from favorited repos', async () => {
    insertRepo(db, { id: 3, fullName: 'other/favrepo' });
    addSecretFavorite(db, 'repo', 'other/favrepo');

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ secrets: [{ name: 'FAV_SECRET' }] }), { status: 200 }),
    );

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice');
    // alice has 2 personal repos + 1 favorited repo = 3 total
    expect(result.scanned).toBe(3);
  });

  it('includes secrets from favorited org repos', async () => {
    insertOrg(db, 10, 'mycorp');
    insertRepo(db, { id: 4, fullName: 'mycorp/service', orgId: 10 });
    addSecretFavorite(db, 'org', 'mycorp');

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ secrets: [{ name: 'ORG_SECRET' }] }), { status: 200 }),
    );

    const result = await scanUserRepoSecrets(db, 'gho_oauth', 'alice');
    // alice has 2 personal repos + 1 org repo = 3 total
    expect(result.scanned).toBe(3);
  });
});
