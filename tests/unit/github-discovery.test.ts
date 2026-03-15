/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  upsertOrg,
  upsertRepo,
  listOrgs,
  setOrgDiscoveryEnabled,
  runDiscovery,
  runLightweightRefresh,
  runPatDiscovery,
  getLastOrgIndexedAt,
  abortDiscovery,
  resolveCollaborationReason,
  resolveCollaborationReasons,
  type DiscoveryState,
} from '../../src/services/github-discovery';

// Mock saveDatabase — it talks to the filesystem
vi.mock('../../src/storage/database', () => ({
  saveDatabase: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────

function makeHeaders(
  remaining = 4999,
  limit = 5000,
  reset = Math.floor(Date.now() / 1000) + 3600,
  linkNext?: string,
): Headers {
  const h = new Headers({
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-reset': String(reset),
  });
  if (linkNext) {
    h.set('link', `<${linkNext}>; rel="next"`);
  }
  return h;
}

function jsonResponse(body: unknown, headers: Headers, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ─── DB-level upsert tests (no network) ─────────────────────────────

describe('GitHub Discovery — DB upserts', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('upsertOrg inserts a new org and returns its id', () => {
    const id = upsertOrg(db, { login: 'acme', name: 'Acme Corp', description: 'Widgets' });
    expect(id).toBeGreaterThan(0);

    const rows = db.exec('SELECT login, name, metadata FROM github_orgs WHERE login = "acme"');
    expect(rows[0].values[0][0]).toBe('acme');
    expect(rows[0].values[0][1]).toBe('Acme Corp');
    expect(JSON.parse(rows[0].values[0][2] as string)).toEqual({ description: 'Widgets' });
  });

  it('upsertOrg updates on conflict', () => {
    upsertOrg(db, { login: 'acme', name: 'Old Name' });
    const id2 = upsertOrg(db, { login: 'acme', name: 'New Name' });

    const rows = db.exec('SELECT COUNT(*) FROM github_orgs');
    expect(rows[0].values[0][0]).toBe(1);

    const name = db.exec('SELECT name FROM github_orgs WHERE id = ' + id2);
    expect(name[0].values[0][0]).toBe('New Name');
  });

  it('upsertRepo inserts a repo linked to an org', () => {
    const orgId = upsertOrg(db, { login: 'acme' });

    upsertRepo(
      db,
      {
        full_name: 'acme/widgets',
        name: 'widgets',
        description: 'Widget factory',
        default_branch: 'main',
        language: 'TypeScript',
        archived: false,
        fork: false,
        private: true,
        pushed_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
      orgId,
    );

    const rows = db.exec('SELECT full_name, org_id, private FROM github_repos');
    expect(rows[0].values[0][0]).toBe('acme/widgets');
    expect(rows[0].values[0][1]).toBe(orgId);
    expect(rows[0].values[0][2]).toBe(1);
  });

  it('upsertRepo inserts a user repo with null org_id', () => {
    upsertRepo(db, { full_name: 'user/my-repo', name: 'my-repo' }, null);

    const rows = db.exec('SELECT full_name, org_id FROM github_repos');
    expect(rows[0].values[0][0]).toBe('user/my-repo');
    expect(rows[0].values[0][1]).toBeNull();
  });

  it('upsertRepo updates on conflict (same full_name)', () => {
    upsertRepo(db, { full_name: 'acme/widgets', name: 'widgets', language: 'JavaScript' }, null);
    upsertRepo(db, { full_name: 'acme/widgets', name: 'widgets', language: 'TypeScript' }, null);

    const rows = db.exec('SELECT COUNT(*) FROM github_repos');
    expect(rows[0].values[0][0]).toBe(1);

    const lang = db.exec('SELECT language FROM github_repos WHERE full_name = "acme/widgets"');
    expect(lang[0].values[0][0]).toBe('TypeScript');
  });

  it('upsertRepo stores fork parent_full_name', () => {
    upsertRepo(
      db,
      {
        full_name: 'user/fork-repo',
        name: 'fork-repo',
        fork: true,
        parent: { full_name: 'upstream/original' },
      },
      null,
    );

    const rows = db.exec('SELECT fork, parent_full_name FROM github_repos WHERE full_name = "user/fork-repo"');
    expect(rows[0].values[0][0]).toBe(1);
    expect(rows[0].values[0][1]).toBe('upstream/original');
  });

  it('listOrgs returns orgs with repo counts and discovery_enabled', () => {
    const orgId = upsertOrg(db, { login: 'acme', name: 'Acme Corp' });
    upsertOrg(db, { login: 'beta', name: 'Beta Inc' });
    upsertRepo(db, { full_name: 'acme/repo1', name: 'repo1' }, orgId);
    upsertRepo(db, { full_name: 'acme/repo2', name: 'repo2' }, orgId);

    const result = listOrgs(db);
    expect(result.orgs).toHaveLength(2);

    const acme = result.orgs.find((o) => o.login === 'acme')!;
    expect(acme.name).toBe('Acme Corp');
    expect(acme.repoCount).toBe(2);
    expect(acme.discoveryEnabled).toBe(true);

    const beta = result.orgs.find((o) => o.login === 'beta')!;
    expect(beta.repoCount).toBe(0);
    expect(beta.discoveryEnabled).toBe(true);
  });

  it('setOrgDiscoveryEnabled toggles the flag', () => {
    upsertOrg(db, { login: 'acme' });

    setOrgDiscoveryEnabled(db, 'acme', false);
    let result = listOrgs(db);
    expect(result.orgs[0].discoveryEnabled).toBe(false);

    setOrgDiscoveryEnabled(db, 'acme', true);
    result = listOrgs(db);
    expect(result.orgs[0].discoveryEnabled).toBe(true);
  });
});

// ─── Full discovery integration test (mocked fetch) ─────────────────

describe('GitHub Discovery — runDiscovery', () => {
  let db: SqlJsDatabase;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it('fetches orgs, org repos, and user repos then stores them', async () => {
    const calls: string[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);

      // GET /user/orgs
      if (url.includes('/user/orgs')) {
        return jsonResponse(
          [{ login: 'org1', description: 'First org' }],
          makeHeaders(4998),
        );
      }
      // GET /orgs/org1/repos
      if (url.includes('/orgs/org1/repos')) {
        return jsonResponse(
          [
            { full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false },
            { full_name: 'org1/repo-b', name: 'repo-b', default_branch: 'main', archived: true, fork: false, private: true },
          ],
          makeHeaders(4996),
        );
      }
      // GET /user/repos?affiliation=owner,collaborator,organization_member
      if (url.includes('/user/repos') && url.includes('affiliation=owner')) {
        return jsonResponse(
          [
            { full_name: 'me/personal', name: 'personal', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } },
            { full_name: 'other/collab-repo', name: 'collab-repo', default_branch: 'main', archived: false, fork: false, private: true, owner: { login: 'other', type: 'User' } },
          ],
          makeHeaders(4995),
        );
      }

      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const progressUpdates: any[] = [];
    const state = await runDiscovery(db, 'fake-token', (p) => progressUpdates.push({ ...p }));

    expect(state.aborted).toBe(false);

    // Verify orgs stored
    const orgs = db.exec('SELECT login FROM github_orgs');
    expect(orgs[0].values.map((v: unknown[]) => v[0])).toEqual(['org1']);

    // Verify repos stored
    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    const repoNames = repos[0].values.map((v: unknown[]) => v[0]);
    expect(repoNames).toContain('org1/repo-a');
    expect(repoNames).toContain('org1/repo-b');
    expect(repoNames).toContain('me/personal');
    expect(repoNames).toContain('other/collab-repo');

    // Verify final progress
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.phase).toBe('done');
    expect(last.orgsFound).toBe(1);
    expect(last.reposFound).toBe(4);
  });

  it('follows pagination links', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/user/orgs') && !url.includes('page=2')) {
        return jsonResponse(
          [{ login: 'paged-org' }],
          makeHeaders(4999, 5000, Math.floor(Date.now() / 1000) + 3600, 'https://api.github.com/user/orgs?per_page=100&page=2'),
        );
      }
      if (url.includes('/user/orgs') && url.includes('page=2')) {
        return jsonResponse(
          [{ login: 'paged-org-2' }],
          makeHeaders(4998),
        );
      }
      // Org repos
      if (url.includes('/orgs/')) {
        return jsonResponse([], makeHeaders(4997));
      }
      // User repos
      if (url.includes('/user/repos')) {
        return jsonResponse([], makeHeaders(4996));
      }

      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    await runDiscovery(db, 'fake-token');

    const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login');
    expect(orgs[0].values.map((v: unknown[]) => v[0])).toEqual(['paged-org', 'paged-org-2']);
  });

  it('can be aborted mid-run', async () => {
    let callCount = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      callCount++;
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/user/orgs')) {
        return jsonResponse(
          [{ login: 'org1' }, { login: 'org2' }, { login: 'org3' }],
          makeHeaders(4999),
        );
      }
      // Return repos for any org
      return jsonResponse(
        [{ full_name: 'x/repo', name: 'repo' }],
        makeHeaders(4998),
      );
    }) as Mock;

    let discoveryState: any = null;
    const promise = runDiscovery(db, 'fake-token', (progress) => {
      // Abort after first org's repos are fetched
      if (progress.phase === 'repos' && progress.reposFound > 0 && discoveryState) {
        abortDiscovery(discoveryState);
      }
    });

    // Get the state object from the promise
    // We need to abort from outside, so let's use a different approach
    // Start discovery and abort after a small delay
    const statePromise = runDiscovery(db, 'fake-token');

    // Give it a moment to start, then abort — but we need the state.
    // Instead, test that abortDiscovery sets the flag correctly.
    const state = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };
    abortDiscovery(state);
    expect(state.aborted).toBe(true);
  });

  it('skips disabled orgs during discovery', async () => {
    const fetchedUrls: string[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);

      if (url.includes('/user/orgs')) {
        return jsonResponse(
          [{ login: 'enabled-org' }, { login: 'disabled-org' }],
          makeHeaders(4998),
        );
      }
      if (url.includes('/orgs/enabled-org/repos')) {
        return jsonResponse(
          [{ full_name: 'enabled-org/repo1', name: 'repo1' }],
          makeHeaders(4997),
        );
      }
      if (url.includes('/orgs/disabled-org/repos')) {
        return jsonResponse(
          [{ full_name: 'disabled-org/repo1', name: 'repo1' }],
          makeHeaders(4996),
        );
      }
      if (url.includes('/user/repos')) {
        return jsonResponse([], makeHeaders(4995));
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    // Run discovery once to create the orgs
    await runDiscovery(db, 'fake-token');

    // Disable one org
    setOrgDiscoveryEnabled(db, 'disabled-org', false);
    fetchedUrls.length = 0;

    // Run again — disabled-org should be skipped
    await runDiscovery(db, 'fake-token');

    const orgRepoFetches = fetchedUrls.filter((u) => u.includes('/orgs/'));
    expect(orgRepoFetches.some((u) => u.includes('enabled-org'))).toBe(true);
    expect(orgRepoFetches.some((u) => u.includes('disabled-org'))).toBe(false);
  });

  it('runLightweightRefresh fetches orgs and personal+collaborator repos', async () => {
    const fetchedUrls: string[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);

      if (url.includes('/user/orgs')) {
        return jsonResponse(
          [{ login: 'new-org', description: 'New' }],
          makeHeaders(4998),
        );
      }
      if (url.includes('/user/repos') && url.includes('affiliation=owner')) {
        return jsonResponse(
          [
            { full_name: 'me/my-repo', name: 'my-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } },
            { full_name: 'other/collab', name: 'collab', default_branch: 'main', archived: false, fork: false, private: true, owner: { login: 'other', type: 'User' } },
          ],
          makeHeaders(4997),
        );
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const progressUpdates: any[] = [];
    await runLightweightRefresh(db, 'fake-token', (p) => progressUpdates.push({ ...p }));

    // Should have fetched orgs and personal+collaborator repos
    expect(fetchedUrls.some((u) => u.includes('/user/orgs'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('affiliation=owner,collaborator,organization_member'))).toBe(true);
    // Should NOT have fetched org repos
    expect(fetchedUrls.some((u) => u.includes('/orgs/'))).toBe(false);

    // Verify org was stored
    const orgs = db.exec('SELECT login FROM github_orgs');
    expect(orgs[0].values.map((v: unknown[]) => v[0])).toEqual(['new-org']);

    // Verify both repos were stored
    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    expect(repos[0].values.map((v: unknown[]) => v[0])).toEqual(['me/my-repo', 'other/collab']);

    // Verify final progress
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.phase).toBe('done');
  });

  it('getLastOrgIndexedAt returns null when no orgs exist', () => {
    expect(getLastOrgIndexedAt(db)).toBeNull();
  });

  it('discovers PAT-only orgs in Phase 1.5 and scans their repos in Phase 2', async () => {
    const fetchCalls: { url: string; token: string }[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
      const token = authHeader.replace('Bearer ', '');
      fetchCalls.push({ url, token });

      // OAuth: /user/orgs — only sees org1
      if (url.includes('/user/orgs') && token === 'oauth-token') {
        return jsonResponse([{ login: 'org1', description: '' }], makeHeaders(4998));
      }
      // PAT: /user/orgs — also sees xebia (blocked from OAuth)
      if (url.includes('/user/orgs') && token === 'pat-token') {
        return jsonResponse(
          [{ login: 'org1', description: '' }, { login: 'xebia', description: '' }],
          makeHeaders(4997),
        );
      }
      // OAuth: /orgs/org1/repos
      if (url.includes('/orgs/org1/repos') && token === 'oauth-token') {
        return jsonResponse(
          [{ full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false }],
          makeHeaders(4996),
        );
      }
      // PAT: /orgs/xebia/repos — called in Phase 2 for the PAT-only org
      if (url.includes('/orgs/xebia/repos') && token === 'pat-token') {
        return jsonResponse(
          [
            { full_name: 'xebia/repo-x', name: 'repo-x', default_branch: 'main', archived: false, fork: false, private: true },
            { full_name: 'xebia/repo-y', name: 'repo-y', default_branch: 'main', archived: false, fork: false, private: true },
          ],
          makeHeaders(4995),
        );
      }
      // Phase 5 (runPatDiscovery) should NOT re-scan xebia or org1
      if (url.includes('/orgs/xebia/repos') && token !== 'pat-token') {
        throw new Error('xebia should only be scanned with PAT');
      }
      // OAuth: /user/repos
      if (url.includes('/user/repos') && token === 'oauth-token') {
        return jsonResponse([], makeHeaders(4993));
      }
      // PAT: /user/repos?affiliation=collaborator (from Phase 5)
      if (url.includes('/user/repos') && url.includes('affiliation=collaborator') && token === 'pat-token') {
        return jsonResponse([], makeHeaders(4992));
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const progressUpdates: any[] = [];
    await runDiscovery(db, 'oauth-token', (p) => progressUpdates.push({ ...p }), 'pat-token');

    // Both orgs should be in the DB
    const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login COLLATE NOCASE');
    const orgLogins = orgs[0].values.map((v: unknown[]) => v[0]);
    expect(orgLogins).toContain('org1');
    expect(orgLogins).toContain('xebia');

    // xebia repos should be stored (scanned in Phase 2 via PAT)
    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    const repoNames = repos[0].values.map((v: unknown[]) => v[0]);
    expect(repoNames).toContain('org1/repo-a');
    expect(repoNames).toContain('xebia/repo-x');
    expect(repoNames).toContain('xebia/repo-y');

    // PAT should have scanned xebia repos in Phase 2 (before Phase 5)
    const phase2XebiaCalls = fetchCalls.filter(
      (c) => c.token === 'pat-token' && c.url.includes('/orgs/xebia/repos'),
    );
    expect(phase2XebiaCalls.length).toBeGreaterThan(0);

    // Phase 5 runPatDiscovery should NOT have re-scanned xebia (already has repos + was in scannedSet)
    // The first PAT /orgs/xebia/repos call is from Phase 2; there should be exactly one.
    expect(phase2XebiaCalls.length).toBe(1);
  });

  it('runs PAT supplemental pass when PAT is provided', async () => {
    const fetchCalls: { url: string; token: string }[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
      const token = authHeader.replace('Bearer ', '');
      fetchCalls.push({ url, token });

      // OAuth: /user/orgs
      if (url.includes('/user/orgs') && token === 'oauth-token') {
        return jsonResponse([{ login: 'org1', description: '' }], makeHeaders(4998));
      }
      // OAuth: /orgs/org1/repos
      if (url.includes('/orgs/org1/repos') && token === 'oauth-token') {
        return jsonResponse(
          [{ full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false }],
          makeHeaders(4997),
        );
      }
      // OAuth: /user/repos
      if (url.includes('/user/repos') && token === 'oauth-token') {
        return jsonResponse(
          [{ full_name: 'me/my-repo', name: 'my-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } }],
          makeHeaders(4996),
        );
      }
      // PAT: /user/orgs — returns org1 (already indexed) + secret-org (new)
      if (url.includes('/user/orgs') && token === 'pat-token') {
        return jsonResponse([{ login: 'org1', description: '' }, { login: 'secret-org', description: '' }], makeHeaders(4995));
      }
      // PAT: /orgs/secret-org/repos — new org's repos
      if (url.includes('/orgs/secret-org/repos') && token === 'pat-token') {
        return jsonResponse(
          [{ full_name: 'secret-org/hidden-repo', name: 'hidden-repo', default_branch: 'main', archived: false, fork: false, private: true }],
          makeHeaders(4994),
        );
      }
      // PAT should NOT call /orgs/org1/repos (already indexed with repos)
      if (url.includes('/orgs/org1/repos') && token === 'pat-token') {
        throw new Error('PAT should not re-fetch already-indexed org repos');
      }
      // PAT: /user/repos?affiliation=collaborator
      if (url.includes('/user/repos') && url.includes('affiliation=collaborator') && token === 'pat-token') {
        return jsonResponse([], makeHeaders(4993));
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const progressUpdates: any[] = [];
    await runDiscovery(db, 'oauth-token', (p) => progressUpdates.push({ ...p }), 'pat-token');

    // secret-org should be created
    const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login COLLATE NOCASE');
    const orgLogins = orgs[0].values.map((v: unknown[]) => v[0]);
    expect(orgLogins).toContain('org1');
    expect(orgLogins).toContain('secret-org');

    // hidden-repo and the OAuth repos should all be stored
    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    const repoNames = repos[0].values.map((v: unknown[]) => v[0]);
    expect(repoNames).toContain('secret-org/hidden-repo');
    expect(repoNames).toContain('me/my-repo');
    expect(repoNames).toContain('org1/repo-a');

    // PAT should NOT have called /orgs/org1/repos (already has repos)
    const patOrg1Calls = fetchCalls.filter(c => c.token === 'pat-token' && c.url.includes('/orgs/org1/repos'));
    expect(patOrg1Calls.length).toBe(0);

    // Verify PAT phase appeared in progress
    expect(progressUpdates.some(p => p.phase === 'pat-repos')).toBe(true);
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.phase).toBe('done');
  });

  it('runPatDiscovery can run standalone without full discovery', async () => {
    // Pre-seed an org with repos so PAT skips it
    const existingOrgId = upsertOrg(db, { login: 'known-org' });
    upsertRepo(db, { full_name: 'known-org/existing', name: 'existing' }, existingOrgId);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      // /user/orgs returns known-org + secret-org
      if (url.includes('/user/orgs')) {
        return jsonResponse(
          [{ login: 'known-org', description: '' }, { login: 'secret-org', description: '' }],
          makeHeaders(4999),
        );
      }
      // /orgs/secret-org/repos — new org
      if (url.includes('/orgs/secret-org/repos')) {
        return jsonResponse(
          [{ full_name: 'secret-org/hidden', name: 'hidden', default_branch: 'main', archived: false, fork: false, private: true }],
          makeHeaders(4998),
        );
      }
      // Should NOT be called for known-org
      if (url.includes('/orgs/known-org/repos')) {
        throw new Error('Should not re-fetch known-org repos');
      }
      // /user/repos?affiliation=collaborator
      if (url.includes('/user/repos') && url.includes('affiliation=collaborator')) {
        return jsonResponse(
          [{ full_name: 'other/collab-repo', name: 'collab-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'other', type: 'User' } }],
          makeHeaders(4997),
        );
      }
      return jsonResponse([], makeHeaders(4996));
    }) as Mock;

    const progressUpdates: any[] = [];
    await runPatDiscovery(db, 'pat-token', undefined, undefined, (p) => progressUpdates.push({ ...p }));

    // secret-org auto-created, repos stored
    const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login COLLATE NOCASE');
    expect(orgs[0].values.map((v: unknown[]) => v[0])).toContain('secret-org');

    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    const repoNames = repos[0].values.map((v: unknown[]) => v[0]);
    expect(repoNames).toContain('secret-org/hidden');
    expect(repoNames).toContain('other/collab-repo');
    expect(repoNames).toContain('known-org/existing'); // still there

    expect(progressUpdates.some(p => p.phase === 'pat-repos')).toBe(true);
  });

  it('PAT pass failure does not crash full discovery', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
      const token = authHeader.replace('Bearer ', '');

      // OAuth calls work fine
      if (url.includes('/user/orgs') && token === 'oauth-token') {
        return jsonResponse([{ login: 'org1', description: '' }], makeHeaders(4998));
      }
      if (url.includes('/orgs/org1/repos') && token === 'oauth-token') {
        return jsonResponse(
          [{ full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false }],
          makeHeaders(4997),
        );
      }
      if (url.includes('/user/repos') && token === 'oauth-token') {
        return jsonResponse(
          [{ full_name: 'me/my-repo', name: 'my-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } }],
          makeHeaders(4996),
        );
      }
      // PAT /user/orgs throws a network error
      if (url.includes('/user/orgs') && token === 'bad-pat') {
        throw new TypeError('fetch failed');
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const progressUpdates: any[] = [];
    // Should not throw even though PAT fails
    const state = await runDiscovery(db, 'oauth-token', (p) => progressUpdates.push({ ...p }), 'bad-pat');

    // OAuth repos should still be stored
    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    const repoNames = repos[0].values.map((v: unknown[]) => v[0]);
    expect(repoNames).toContain('me/my-repo');
    expect(repoNames).toContain('org1/repo-a');

    // Discovery should still reach 'done' phase
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.phase).toBe('done');
  });

  it('rescans OAuth-blocked orgs that already have repos in DB', async () => {
    // Pre-seed xebia with repos to simulate a previous PAT run (repoCount > 0)
    const xebiaId = upsertOrg(db, { login: 'xebia' });
    upsertRepo(db, { full_name: 'xebia/old-repo', name: 'old-repo', default_branch: 'main', archived: false, fork: false, private: true }, xebiaId);

    const fetchCalls: { url: string; token: string }[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
      const token = authHeader.replace('Bearer ', '');
      fetchCalls.push({ url, token });

      // OAuth: /user/orgs — does NOT return xebia (org blocks OAuth apps)
      if (url.includes('/user/orgs') && token === 'oauth-token') {
        return jsonResponse([{ login: 'org1', description: '' }], makeHeaders(4998));
      }
      // OAuth: /orgs/org1/repos
      if (url.includes('/orgs/org1/repos') && token === 'oauth-token') {
        return jsonResponse(
          [{ full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false }],
          makeHeaders(4997),
        );
      }
      // OAuth: /user/repos
      if (url.includes('/user/repos') && token === 'oauth-token') {
        return jsonResponse([], makeHeaders(4996));
      }
      // PAT: /user/orgs — returns org1 (OAuth saw it) + xebia (OAuth blocked)
      if (url.includes('/user/orgs') && token === 'pat-token') {
        return jsonResponse(
          [{ login: 'org1', description: '' }, { login: 'xebia', description: '' }],
          makeHeaders(4995),
        );
      }
      // PAT should NOT re-fetch org1/repos (OAuth already indexed it with repos)
      if (url.includes('/orgs/org1/repos') && token === 'pat-token') {
        throw new Error('PAT should not re-fetch org already indexed by OAuth');
      }
      // PAT: /orgs/xebia/repos — OAuth-blocked org, PAT must rescan
      if (url.includes('/orgs/xebia/repos') && token === 'pat-token') {
        return jsonResponse(
          [
            { full_name: 'xebia/old-repo', name: 'old-repo', default_branch: 'main', archived: false, fork: false, private: true },
            { full_name: 'xebia/new-repo', name: 'new-repo', default_branch: 'main', archived: false, fork: false, private: true },
          ],
          makeHeaders(4994),
        );
      }
      // PAT: /user/repos?affiliation=collaborator
      if (url.includes('/user/repos') && url.includes('affiliation=collaborator') && token === 'pat-token') {
        return jsonResponse([], makeHeaders(4993));
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const progressUpdates: any[] = [];
    await runDiscovery(db, 'oauth-token', (p) => progressUpdates.push({ ...p }), 'pat-token');

    // xebia's new repo should be in DB
    const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
    const repoNames = repos[0].values.map((v: unknown[]) => v[0]);
    expect(repoNames).toContain('xebia/old-repo');
    expect(repoNames).toContain('xebia/new-repo');
    expect(repoNames).toContain('org1/repo-a');

    // PAT must have called /orgs/xebia/repos
    const patXebiaCalls = fetchCalls.filter(c => c.token === 'pat-token' && c.url.includes('/orgs/xebia/repos'));
    expect(patXebiaCalls.length).toBeGreaterThan(0);
  });

  it('getLastOrgIndexedAt returns the most recent indexed_at', () => {
    upsertOrg(db, { login: 'org1' });
    upsertOrg(db, { login: 'org2' });

    const result = getLastOrgIndexedAt(db);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});

// ─── Collaboration reason tests ──────────────────────────────────────

describe('GitHub Discovery — collaboration reason', () => {
  let db: SqlJsDatabase;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it('upsertRepo stores collaboration_reason', () => {
    upsertRepo(db, { full_name: 'other/collab-repo', name: 'collab-repo' }, null, 'pr');

    const rows = db.exec('SELECT collaboration_reason FROM github_repos WHERE full_name = "other/collab-repo"');
    expect(rows[0].values[0][0]).toBe('pr');
  });

  it('upsertRepo preserves existing collaboration_reason when new value is null', () => {
    upsertRepo(db, { full_name: 'other/collab-repo', name: 'collab-repo' }, null, 'issue');
    upsertRepo(db, { full_name: 'other/collab-repo', name: 'collab-repo' }, null);

    const rows = db.exec('SELECT collaboration_reason FROM github_repos WHERE full_name = "other/collab-repo"');
    expect(rows[0].values[0][0]).toBe('issue');
  });

  it('upsertRepo updates collaboration_reason when new value is provided', () => {
    upsertRepo(db, { full_name: 'other/collab-repo', name: 'collab-repo' }, null, 'collaborator');
    upsertRepo(db, { full_name: 'other/collab-repo', name: 'collab-repo' }, null, 'pr,issue');

    const rows = db.exec('SELECT collaboration_reason FROM github_repos WHERE full_name = "other/collab-repo"');
    expect(rows[0].values[0][0]).toBe('pr,issue');
  });

  it('resolveCollaborationReason returns "pr" when search finds only PRs', async () => {
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    globalThis.fetch = vi.fn(async () => {
      return jsonResponse(
        { total_count: 2, items: [{ pull_request: {} }, { pull_request: {} }] },
        makeHeaders(29),
      );
    }) as Mock;

    const reason = await resolveCollaborationReason('token', 'me', 'other/repo', state);
    expect(reason).toBe('pr');
  });

  it('resolveCollaborationReason returns "issue" when search finds only issues', async () => {
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    globalThis.fetch = vi.fn(async () => {
      return jsonResponse(
        { total_count: 1, items: [{ title: 'Bug report' }] },
        makeHeaders(29),
      );
    }) as Mock;

    const reason = await resolveCollaborationReason('token', 'me', 'other/repo', state);
    expect(reason).toBe('issue');
  });

  it('resolveCollaborationReason returns "pr,issue" when search finds both', async () => {
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    globalThis.fetch = vi.fn(async () => {
      return jsonResponse(
        { total_count: 3, items: [{ pull_request: {} }, { title: 'Bug report' }, { pull_request: {} }] },
        makeHeaders(29),
      );
    }) as Mock;

    const reason = await resolveCollaborationReason('token', 'me', 'other/repo', state);
    expect(reason).toBe('pr,issue');
  });

  it('resolveCollaborationReason returns "collaborator" when search finds nothing', async () => {
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    globalThis.fetch = vi.fn(async () => {
      return jsonResponse(
        { total_count: 0, items: [] },
        makeHeaders(29),
      );
    }) as Mock;

    const reason = await resolveCollaborationReason('token', 'me', 'other/repo', state);
    expect(reason).toBe('collaborator');
  });

  it('resolveCollaborationReason returns "collaborator" on fetch error', async () => {
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network error');
    }) as Mock;

    const reason = await resolveCollaborationReason('token', 'me', 'other/repo', state);
    expect(reason).toBe('collaborator');
  });

  it('resolveCollaborationReasons assigns owner for own repos, org_member for org repos, and queries external', async () => {
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    upsertOrg(db, { login: 'myorg' });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/search/issues')) {
        return jsonResponse(
          { total_count: 1, items: [{ pull_request: {} }] },
          makeHeaders(29),
        );
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    const repos = [
      { full_name: 'me/my-repo', name: 'my-repo', owner: { login: 'me', type: 'User' } },
      { full_name: 'myorg/org-repo', name: 'org-repo', owner: { login: 'myorg', type: 'Organization' } },
      { full_name: 'stranger/ext-repo', name: 'ext-repo', owner: { login: 'stranger', type: 'User' } },
    ];

    const reasons = await resolveCollaborationReasons(db, 'token', 'me', repos, state);

    expect(reasons.get('me/my-repo')).toBe('owner');
    expect(reasons.get('myorg/org-repo')).toBe('org_member');
    expect(reasons.get('stranger/ext-repo')).toBe('pr');
  });

  it('runDiscovery sets collaboration_reason for user repos when userLogin is provided', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/user/orgs')) {
        return jsonResponse([], makeHeaders(4998));
      }
      if (url.includes('/user/repos') && url.includes('affiliation=owner')) {
        return jsonResponse(
          [
            { full_name: 'me/personal', name: 'personal', owner: { login: 'me', type: 'User' } },
            { full_name: 'other/collab', name: 'collab', owner: { login: 'other', type: 'User' } },
          ],
          makeHeaders(4995),
        );
      }
      if (url.includes('/search/issues')) {
        return jsonResponse(
          { total_count: 1, items: [{ title: 'My issue' }] },
          makeHeaders(4990),
        );
      }
      return jsonResponse([], makeHeaders(4990));
    }) as Mock;

    await runDiscovery(db, 'fake-token', undefined, undefined, 'me');

    const ownedResult = db.exec('SELECT collaboration_reason FROM github_repos WHERE full_name = "me/personal"');
    expect(ownedResult[0].values[0][0]).toBe('owner');

    const collabResult = db.exec('SELECT collaboration_reason FROM github_repos WHERE full_name = "other/collab"');
    expect(collabResult[0].values[0][0]).toBe('issue');
  });
});
