/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  README_MAX_LINES,
  countReposNeedingReadme,
  runReadmeBatch,
  truncateReadme,
} from '../../src/services/github-repo-catalog';
import {
  approveLargeOrg,
  fetchWatchedRepos,
  listBlockedLargeOrgs,
  listOrgs,
  runDiscovery,
  upsertOrg,
  upsertRepo,
  type DiscoveryState,
} from '../../src/services/github-discovery';
import { deriveRoles, searchGitHubRepos } from '../../src/mcp-server/tools/github';

vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));
vi.mock('../../src/services/github-repo-access', () => ({
  accessForRepo: vi.fn(async () => ({ token: 'fake-token' })),
}));

function headers(extra: Record<string, string> = {}, remaining = 4900): Headers {
  return new Headers({
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    ...extra,
  });
}

function res(body: unknown, status = 200, extra: Record<string, string> = {}, remaining = 4900): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: headers(extra, remaining),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function scalar(db: SqlJsDatabase, sql: string): unknown {
  return db.exec(sql)[0].values[0][0];
}

describe('truncateReadme', () => {
  it('keeps only the first 200 lines', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\r\n');
    const out = truncateReadme(text).split('\n');
    expect(out).toHaveLength(README_MAX_LINES);
    expect(out[0]).toBe('line 1');
    expect(out[out.length - 1]).toBe('line 200');
  });

  it('caps absurdly long content', () => {
    expect(truncateReadme('x'.repeat(100_000)).length).toBeLessThanOrEqual(20_000);
  });
});

describe('README trickle', () => {
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

  it('stores a truncated README with its etag and does not refetch it while fresh', async () => {
    upsertRepo(db, { full_name: 'other/tool', name: 'tool' }, null, 'collaborator');
    const readme = Array.from({ length: 250 }, (_, i) => `row ${i}`).join('\n');
    globalThis.fetch = vi.fn(async () => res(readme, 200, { etag: '"abc"' })) as Mock;

    const first = await runReadmeBatch(db);
    expect(first).toMatchObject({ attempted: 1, fetched: 1, pending: 0 });
    expect((scalar(db, 'SELECT readme_excerpt FROM github_repos') as string).split('\n')).toHaveLength(200);
    expect(scalar(db, 'SELECT readme_etag FROM github_repos')).toBe('"abc"');
    expect(scalar(db, 'SELECT readme_status FROM github_repos')).toBe('ok');

    const second = await runReadmeBatch(db);
    expect(second.attempted).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends If-None-Match on refresh and keeps the excerpt on 304', async () => {
    upsertRepo(db, { full_name: 'other/tool', name: 'tool' }, null);
    db.run(
      `UPDATE github_repos SET readme_excerpt = 'old', readme_etag = '"abc"', readme_status = 'ok',
       readme_fetched_at = datetime('now', '-30 day')`,
    );
    const fetchMock = vi.fn(async () => res('', 304));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runReadmeBatch(db);

    expect(result.notModified).toBe(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"abc"');
    expect(scalar(db, 'SELECT readme_excerpt FROM github_repos')).toBe('old');
    expect(countReposNeedingReadme(db)).toBe(0);
  });

  it('records repos without a README and retries failures only after a day', async () => {
    upsertRepo(db, { full_name: 'a/none', name: 'none' }, null);
    upsertRepo(db, { full_name: 'a/boom', name: 'boom' }, null);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('a/none') ? res({}, 404) : res({}, 500),
    ) as Mock;

    const result = await runReadmeBatch(db);

    expect(result).toMatchObject({ missing: 1, failed: 1 });
    expect(scalar(db, "SELECT readme_status FROM github_repos WHERE full_name = 'a/none'")).toBe('none');
    expect(scalar(db, "SELECT readme_status FROM github_repos WHERE full_name = 'a/boom'")).toBe('error');
    expect(countReposNeedingReadme(db)).toBe(0);

    db.run("UPDATE github_repos SET readme_fetched_at = datetime('now', '-2 day')");
    // The error is due again after a day; "none" waits for the longer TTL.
    expect(countReposNeedingReadme(db)).toBe(1);
  });

  it('skips repos of unapproved large orgs until approved', async () => {
    const orgId = upsertOrg(db, { login: 'huge' });
    upsertRepo(db, { full_name: 'huge/one', name: 'one' }, orgId);
    db.run("UPDATE github_orgs SET large_org = 1 WHERE login = 'huge'");
    globalThis.fetch = vi.fn(async () => res('# hi')) as Mock;

    expect(countReposNeedingReadme(db)).toBe(0);
    expect((await runReadmeBatch(db)).attempted).toBe(0);

    approveLargeOrg(db, 'huge', true);
    expect(countReposNeedingReadme(db)).toBe(1);
  });

  it('loads collaborator repos before starred before the rest', async () => {
    upsertRepo(db, { full_name: 'me/own', name: 'own', pushed_at: '2026-09-01T00:00:00Z' }, null, 'owner');
    upsertRepo(db, { full_name: 'x/starred', name: 'starred', pushed_at: '2020-01-01T00:00:00Z' }, null);
    db.run("UPDATE github_repos SET starred = 1 WHERE full_name = 'x/starred'");
    upsertRepo(db, { full_name: 'y/collab', name: 'collab', pushed_at: '2019-01-01T00:00:00Z' }, null, 'pr');
    const order: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      order.push(String(input).replace(/.*repos\//, '').replace('/readme', ''));
      return res('# hi');
    }) as Mock;

    await runReadmeBatch(db);

    expect(order).toEqual(['y/collab', 'x/starred', 'me/own']);
  });

  it('stops the batch when the rate limit runs low', async () => {
    upsertRepo(db, { full_name: 'a/one', name: 'one' }, null);
    upsertRepo(db, { full_name: 'a/two', name: 'two' }, null);
    globalThis.fetch = vi.fn(async () => res('# hi', 200, {}, 10)) as Mock;

    const result = await runReadmeBatch(db);

    expect(result.stoppedReason).toBe('rate-limit');
    expect(result.attempted).toBe(1);
    expect(result.pending).toBe(1);
  });
});

describe('large org guard and watched repos', () => {
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

  function discoveryFetch(lastPage: number): Mock {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/user/orgs')) return res([{ login: 'small' }, { login: 'huge' }]);
      if (url.includes('/orgs/huge/repos')) {
        return res(
          [{ full_name: 'huge/r0', name: 'r0' }],
          200,
          {
            link: `<https://api.github.com/orgs/huge/repos?per_page=100&page=2>; rel="next", <https://api.github.com/orgs/huge/repos?per_page=100&page=${lastPage}>; rel="last"`,
          },
        );
      }
      if (url.includes('/orgs/small/repos')) return res([{ full_name: 'small/r1', name: 'r1' }]);
      if (url.includes('/user/repos')) {
        return res([
          { full_name: 'huge/member-repo', name: 'member-repo', owner: { login: 'huge', type: 'Organization' } },
        ]);
      }
      return res([]);
    }) as Mock;
  }

  it('skips and flags an org with more than 500 repos, including its repos from other listings', async () => {
    globalThis.fetch = discoveryFetch(6);

    await runDiscovery(db, 'tok', undefined, null, 'me');

    const names = db.exec('SELECT full_name FROM github_repos')[0].values.map((v) => v[0]);
    expect(names).toEqual(['small/r1']);
    expect(listBlockedLargeOrgs(db)).toEqual(['huge']);
    const huge = listOrgs(db).orgs.find((o) => o.login === 'huge');
    expect(huge).toMatchObject({ largeOrg: true, largeOrgApproved: false });
    // Only page 1 of the huge org was requested.
    const hugeCalls = (globalThis.fetch as Mock).mock.calls.filter((c) => String(c[0]).includes('/orgs/huge/repos'));
    expect(hugeCalls).toHaveLength(1);
  });

  it('allows an org of exactly 500 repos (5 pages)', async () => {
    globalThis.fetch = discoveryFetch(5);

    await runDiscovery(db, 'tok', undefined, null, 'me');

    expect(listBlockedLargeOrgs(db)).toEqual([]);
  });

  it('remembers the block on the next run without calling the org again, until approved', async () => {
    globalThis.fetch = discoveryFetch(6);
    await runDiscovery(db, 'tok', undefined, null, 'me');

    globalThis.fetch = discoveryFetch(6);
    await runDiscovery(db, 'tok', undefined, null, 'me');
    expect((globalThis.fetch as Mock).mock.calls.some((c) => String(c[0]).includes('/orgs/huge/repos'))).toBe(false);

    approveLargeOrg(db, 'huge', true);
    expect(listBlockedLargeOrgs(db)).toEqual([]);
  });

  it('marks watched repos and clears stale ones', async () => {
    upsertRepo(db, { full_name: 'a/old', name: 'old' }, null);
    db.run("UPDATE github_repos SET watching = 1 WHERE full_name = 'a/old'");
    globalThis.fetch = vi.fn(async () => res([{ full_name: 'b/new', name: 'new', owner: { login: 'b', type: 'User' } }])) as Mock;
    const state: DiscoveryState = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };

    await fetchWatchedRepos(db, 'tok', state);

    expect(db.exec('SELECT full_name FROM github_repos WHERE watching = 1')[0].values).toEqual([['b/new']]);
  });
});

describe('repo catalog search', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    const insert = `INSERT INTO github_repos
      (id, full_name, name, description, collaboration_reason, starred, watching, readme_excerpt, last_pushed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(insert, [1, 'me/notes', 'notes', 'Personal notes', 'owner', 0, 1, 'Nothing about widgets here', '2026-01-01']);
    db.run(insert, [2, 'friend/gizmo', 'gizmo', 'A tool', 'pr', 0, 0, '# Gizmo\nConverts flux capacitor dumps into CSV', '2025-01-01']);
    db.run(insert, [3, 'star/flux-viewer', 'flux-viewer', 'Browse flux data', null, 1, 0, null, '2024-01-01']);
  });

  afterEach(() => db.close());

  it('finds a repo by words that only appear in its README', () => {
    const hits = searchGitHubRepos(db, 'capacitor csv');
    expect(hits.map((h) => h.fullName)).toEqual(['friend/gizmo']);
    expect(hits[0].readmeSnippet).toContain('flux capacitor');
    expect(hits[0].roles).toEqual(['collaborator', 'contributor']);
  });

  it('ranks name matches above README matches', () => {
    expect(searchGitHubRepos(db, 'flux').map((h) => h.fullName)).toEqual(['star/flux-viewer', 'friend/gizmo']);
  });

  it('filters by role', () => {
    expect(searchGitHubRepos(db, 'flux', { roles: ['collaborator'] }).map((h) => h.fullName)).toEqual(['friend/gizmo']);
    expect(searchGitHubRepos(db, 'flux', { roles: ['starred'] }).map((h) => h.fullName)).toEqual(['star/flux-viewer']);
    expect(searchGitHubRepos(db, 'notes', { roles: ['watcher'] }).map((h) => h.fullName)).toEqual(['me/notes']);
  });

  it('still works on a database from before the README columns existed', async () => {
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(
      `CREATE TABLE github_repos (id INTEGER PRIMARY KEY, full_name TEXT, description TEXT, language TEXT, default_branch TEXT,
        archived INTEGER, fork INTEGER, private INTEGER, starred INTEGER, last_pushed_at TEXT)`,
    );
    old.run("INSERT INTO github_repos VALUES (1, 'a/b', 'hello world', NULL, 'main', 0, 0, 0, 1, NULL)");
    old.run('CREATE TABLE local_repos (id INTEGER, local_path TEXT, github_repo_id INTEGER)');
    old.run('CREATE TABLE local_repo_remotes (local_repo_id INTEGER, github_repo_id INTEGER)');

    const hits = searchGitHubRepos(old, 'hello');

    expect(hits).toHaveLength(1);
    expect(hits[0].roles).toEqual(['starred']);
    expect(hits[0].readmeSnippet).toBeNull();
    old.close();
  });

  it('derives roles from collaboration reasons', () => {
    expect(deriveRoles('owner', false, false)).toEqual(['owner']);
    expect(deriveRoles('org_member', true, true)).toEqual(['org_member', 'starred', 'watcher']);
    expect(deriveRoles('issue,pr', false, false)).toEqual(['collaborator', 'contributor']);
    expect(deriveRoles(null, false, false)).toEqual([]);
  });
});
