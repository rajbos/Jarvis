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
  runSecretsBatch,
  setOrgSecretScan,
  countReposNeedingSecretsScan,
  SECRET_SCAN_MAX_AUTO_ORG_REPOS,
} from '../../src/services/github-secrets';
import { listOrgs } from '../../src/services/github-discovery';

// Mock saveDatabase — it talks to the filesystem
vi.mock('../../src/storage/database', () => ({
  saveDatabase: vi.fn(),
}));

// Every repo resolves to the OAuth account's token
vi.mock('../../src/services/github-repo-access', () => ({
  accessForRepo: vi.fn(async () => ({ token: 'gho_oauth' })),
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

// ── runSecretsBatch ───────────────────────────────────────────────────────────

function secretsResponse(names: string[], remaining = 4900): Response {
  return new Response(JSON.stringify({ secrets: names.map((name) => ({ name })) }), {
    status: 200,
    headers: { 'x-ratelimit-remaining': String(remaining) },
  });
}

function scannedRepos(db: SqlJsDatabase): string[] {
  const res = db.exec('SELECT full_name FROM github_repos WHERE secrets_scanned_at IS NOT NULL ORDER BY full_name');
  return res.length ? res[0].values.map((r) => r[0] as string) : [];
}

function insertOrgRepos(db: SqlJsDatabase, orgId: number, login: string, count: number, firstId: number): void {
  for (let i = 0; i < count; i++) insertRepo(db, { id: firstId + i, fullName: `${login}/repo-${i}`, orgId });
}

describe('runSecretsBatch', () => {
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

  it('stores discovered secrets for personal repos and marks them scanned', async () => {
    globalThis.fetch = vi.fn(async () => secretsResponse(['MY_SECRET']));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.scanned).toBe(2);
    expect(result.secretsFound).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(result.eligible).toBe(2);
    expect(result.pending).toBe(0);
    expect(result.stoppedReason).toBe('done');

    expect(listSecretsForRepo(db, 'alice/myapp')[0].secret_name).toBe('MY_SECRET');
    expect(scannedRepos(db)).toEqual(['alice/myapp', 'alice/tool']);
  });

  it('does not rescan repos that did not change since the last scan', async () => {
    globalThis.fetch = vi.fn(async () => secretsResponse([]));
    await runSecretsBatch(db, { ownerLogin: 'alice' });

    const fetchMock = vi.fn(async () => secretsResponse([]));
    globalThis.fetch = fetchMock;
    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.scanned).toBe(0);
  });

  it('rescans a repo that was pushed to after its last scan', async () => {
    globalThis.fetch = vi.fn(async () => secretsResponse([]));
    await runSecretsBatch(db, { ownerLogin: 'alice' });
    db.run(`UPDATE github_repos SET last_pushed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 hour') WHERE id = 1`);

    const fetchMock = vi.fn(async () => secretsResponse(['NEW_SECRET']));
    globalThis.fetch = fetchMock;
    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
    expect(listSecretsForRepo(db, 'alice/myapp')[0].secret_name).toBe('NEW_SECRET');
  });

  it('rescans unchanged repos once the last scan is 30 days old', async () => {
    globalThis.fetch = vi.fn(async () => secretsResponse([]));
    await runSecretsBatch(db, { ownerLogin: 'alice' });
    db.run(`UPDATE github_repos SET secrets_scanned_at = datetime('now', '-31 day') WHERE id = 2`);

    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(1);
  });

  it('does not retry repos without access on every push', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    await runSecretsBatch(db, { ownerLogin: 'alice' });
    db.run(`UPDATE github_repos SET last_pushed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 hour')`);

    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(0);
  });

  it('records errors without aborting, and retries failed repos after a day', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Server Error', { status: 500 }));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.errors).toHaveLength(2);
    expect(result.secretsFound).toBe(0);
    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(0);

    db.run(`UPDATE github_repos SET secrets_scanned_at = datetime('now', '-2 day')`);
    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(2);
  });

  it('skips repos that return 403/404 when no PAT is configured', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.errors).toHaveLength(0);
    expect(result.secretsFound).toBe(0);
  });

  it('retries with PAT when OAuth returns 403', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(secretsResponse(['ORG_SECRET']))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(secretsResponse(['ORG_SECRET_2']));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice', patToken: 'ghp_pat' });
    expect(result.errors).toHaveLength(0);
    expect(result.secretsFound).toBe(2);
  });

  it('retries with PAT when OAuth returns 404', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(secretsResponse(['FOUND']))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(secretsResponse([]));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice', patToken: 'ghp_pat' });
    expect(result.secretsFound).toBe(1);
  });

  it('does not retry with PAT when OAuth and PAT tokens are the same', async () => {
    const fetchMock = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    globalThis.fetch = fetchMock;

    await runSecretsBatch(db, { ownerLogin: 'alice', patToken: 'gho_oauth' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('calls onProgress callback', async () => {
    globalThis.fetch = vi.fn(async () => secretsResponse([]));

    const progressCalls: number[] = [];
    await runSecretsBatch(db, { ownerLogin: 'alice', onProgress: (done) => progressCalls.push(done) });
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('includes favorited repos', async () => {
    insertRepo(db, { id: 3, fullName: 'other/favrepo' });
    addSecretFavorite(db, 'repo', 'other/favrepo');
    globalThis.fetch = vi.fn(async () => secretsResponse(['FAV_SECRET']));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.scanned).toBe(3);
  });

  it('includes repos of small orgs automatically', async () => {
    insertOrg(db, 10, 'mycorp');
    insertRepo(db, { id: 4, fullName: 'mycorp/service', orgId: 10 });
    globalThis.fetch = vi.fn(async () => secretsResponse(['ORG_SECRET']));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.scanned).toBe(3);
    expect(listSecretsForRepo(db, 'mycorp/service')[0].secret_name).toBe('ORG_SECRET');
  });

  it('leaves out orgs above the size limit unless switched on', async () => {
    insertOrg(db, 10, 'hugecorp');
    insertOrgRepos(db, 10, 'hugecorp', SECRET_SCAN_MAX_AUTO_ORG_REPOS + 1, 100);
    globalThis.fetch = vi.fn(async () => secretsResponse([]));

    expect((await runSecretsBatch(db, { ownerLogin: 'alice' })).eligible).toBe(2);

    setOrgSecretScan(db, 'hugecorp', true);
    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(SECRET_SCAN_MAX_AUTO_ORG_REPOS + 1);
  });

  it('leaves out a small org that was switched off', async () => {
    insertOrg(db, 10, 'mycorp');
    insertRepo(db, { id: 4, fullName: 'mycorp/service', orgId: 10 });
    setOrgSecretScan(db, 'mycorp', false);

    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(2);
  });

  it('honours legacy org favorites, until the org setting replaces them', async () => {
    insertOrg(db, 10, 'hugecorp');
    insertOrgRepos(db, 10, 'hugecorp', SECRET_SCAN_MAX_AUTO_ORG_REPOS + 1, 100);
    addSecretFavorite(db, 'org', 'hugecorp');
    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(SECRET_SCAN_MAX_AUTO_ORG_REPOS + 3);

    setOrgSecretScan(db, 'hugecorp', false);
    expect(listSecretFavorites(db)).toHaveLength(0);
    expect(countReposNeedingSecretsScan(db, 'alice')).toBe(2);
  });

  it('scans at most one batch, personal repos first, and reports what is pending', async () => {
    insertOrg(db, 10, 'mycorp');
    insertOrgRepos(db, 10, 'mycorp', 5, 100);
    globalThis.fetch = vi.fn(async () => secretsResponse([]));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice', batchSize: 3 });
    expect(result.scanned).toBe(3);
    expect(result.eligible).toBe(7);
    expect(result.pending).toBe(4);
    expect(result.stoppedReason).toBeUndefined();
    expect(scannedRepos(db).filter((n) => n.startsWith('alice/'))).toHaveLength(2);
  });

  it('stops when the rate limit runs low', async () => {
    globalThis.fetch = vi.fn(async () => secretsResponse([], 10));

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.scanned).toBe(1);
    expect(result.stoppedReason).toBe('rate-limit');
  });

  it('stops without marking the repo when the rate limit is exhausted', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );

    const result = await runSecretsBatch(db, { ownerLogin: 'alice' });
    expect(result.scanned).toBe(0);
    expect(result.stoppedReason).toBe('rate-limit');
    expect(scannedRepos(db)).toEqual([]);
  });
});

describe('listOrgs — secrets scan state', () => {
  it('reports the effective secrets scan state per org', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(getSchema());
    insertOrg(db, 10, 'small');
    insertRepo(db, { id: 1, fullName: 'small/a', orgId: 10 });
    insertOrg(db, 11, 'huge');
    insertOrgRepos(db, 11, 'huge', SECRET_SCAN_MAX_AUTO_ORG_REPOS + 1, 100);
    insertOrg(db, 12, 'off');
    setOrgSecretScan(db, 'off', false);

    const byLogin = new Map(listOrgs(db).orgs.map((o) => [o.login, o]));
    expect(byLogin.get('small')).toMatchObject({ secretScanSetting: null, secretScanEnabled: true });
    expect(byLogin.get('huge')).toMatchObject({ secretScanSetting: null, secretScanEnabled: false });
    expect(byLogin.get('off')).toMatchObject({ secretScanSetting: false, secretScanEnabled: false });
    db.close();
  });
});
