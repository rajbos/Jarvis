/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  storeNotifications,
  getNotificationCounts,
  listNotificationsForRepo,
  listNotificationsForOwner,
  storeNotificationsForRepo,
  storeNotificationsForOwner,
  deleteNotification,
  listNotificationsForStarred,
  type GitHubNotification,
} from '../../src/services/github-notifications';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeNotif(
  id: string,
  opts: {
    owner?: string;
    repoName?: string;
    type?: string;
    reason?: string;
    unread?: boolean;
    subjectUrl?: string | null;
  } = {},
): GitHubNotification {
  const owner = opts.owner ?? 'myorg';
  const repoName = opts.repoName ?? 'myrepo';
  const defaultUrl = `https://api.github.com/repos/${owner}/${repoName}/issues/1`;
  return {
    id,
    unread: opts.unread ?? true,
    reason: opts.reason ?? 'mention',
    updated_at: new Date().toISOString(),
    subject: {
      type: opts.type ?? 'Issue',
      title: `Notification ${id}`,
      url: 'subjectUrl' in opts ? opts.subjectUrl! : defaultUrl,
    },
    repository: {
      full_name: `${owner}/${repoName}`,
      name: repoName,
      owner: { login: owner },
      html_url: `https://github.com/${owner}/${repoName}`,
    },
  };
}

function insertStarredRepo(db: SqlJsDatabase, fullName: string): void {
  const name = fullName.split('/').pop() ?? fullName;
  db.run(
    `INSERT INTO github_repos (full_name, name, starred) VALUES (?, ?, 1)`,
    [fullName, name],
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GitHub Notifications — storeNotifications', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('inserts notifications into the database', () => {
    storeNotifications(db, [makeNotif('1'), makeNotif('2')]);
    const res = db.exec('SELECT COUNT(*) FROM github_notifications');
    expect(res[0].values[0][0]).toBe(2);
  });

  it('replaces all existing notifications on re-call', () => {
    storeNotifications(db, [makeNotif('1'), makeNotif('2')]);
    storeNotifications(db, [makeNotif('3')]);
    const res = db.exec('SELECT COUNT(*) FROM github_notifications');
    expect(res[0].values[0][0]).toBe(1);
  });

  it('stores null subjectUrl correctly', () => {
    storeNotifications(db, [makeNotif('1', { subjectUrl: null })]);
    const res = db.exec(`SELECT subject_url FROM github_notifications WHERE id = '1'`);
    expect(res[0].values[0][0]).toBeNull();
  });

  it('stores subject actor metadata when present', () => {
    storeNotifications(db, [{
      ...makeNotif('1'),
      subject_actor_login: 'dependabot[bot]',
      subject_actor_type: 'Bot',
    }]);
    const res = db.exec(`SELECT subject_actor_login, subject_actor_type FROM github_notifications WHERE id = '1'`);
    expect(res[0].values[0]).toEqual(['dependabot[bot]', 'Bot']);
  });

  it('stores read (unread=false) notifications with unread=0', () => {
    storeNotifications(db, [makeNotif('1', { unread: false })]);
    const res = db.exec(`SELECT unread FROM github_notifications WHERE id = '1'`);
    expect(res[0].values[0][0]).toBe(0);
  });

  it('handles an empty notifications array', () => {
    storeNotifications(db, [makeNotif('1')]);
    storeNotifications(db, []);
    const res = db.exec('SELECT COUNT(*) FROM github_notifications');
    expect(res[0].values[0][0]).toBe(0);
  });
});

describe('GitHub Notifications — getNotificationCounts', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('returns zero counts when there are no notifications', () => {
    const counts = getNotificationCounts(db);
    expect(counts.total).toBe(0);
    expect(counts.starredTotal).toBe(0);
    expect(counts.perOrg).toEqual({});
    expect(counts.perRepo).toEqual({});
    expect(counts.fetchedAt).toBeNull();
  });

  it('aggregates counts per org and per repo', () => {
    storeNotifications(db, [
      makeNotif('1', { owner: 'orgA', repoName: 'repo1' }),
      makeNotif('2', { owner: 'orgA', repoName: 'repo1' }),
      makeNotif('3', { owner: 'orgB', repoName: 'repo2' }),
    ]);

    const counts = getNotificationCounts(db);
    expect(counts.total).toBe(3);
    expect(counts.perOrg['orgA']).toBe(2);
    expect(counts.perOrg['orgB']).toBe(1);
    expect(counts.perRepo['orgA/repo1']).toBe(2);
    expect(counts.perRepo['orgB/repo2']).toBe(1);
  });

  it('excludes read notifications from counts', () => {
    storeNotifications(db, [
      makeNotif('1', { unread: true }),
      makeNotif('2', { unread: false }),
    ]);

    const counts = getNotificationCounts(db);
    expect(counts.total).toBe(1);
  });

  it('counts notifications for starred repos separately', () => {
    insertStarredRepo(db, 'myorg/myrepo');
    storeNotifications(db, [
      makeNotif('1', { owner: 'myorg', repoName: 'myrepo' }),
      makeNotif('2', { owner: 'otherorg', repoName: 'other' }),
    ]);

    const counts = getNotificationCounts(db);
    expect(counts.starredTotal).toBe(1);
  });

  it('sets fetchedAt to a non-null value after storing notifications', () => {
    storeNotifications(db, [makeNotif('1')]);
    const counts = getNotificationCounts(db);
    expect(counts.fetchedAt).not.toBeNull();
  });
});

describe('GitHub Notifications — listNotificationsForRepo', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    storeNotifications(db, [
      makeNotif('1', { owner: 'myorg', repoName: 'repo1' }),
      makeNotif('2', { owner: 'myorg', repoName: 'repo2' }),
      makeNotif('3', { owner: 'myorg', repoName: 'repo1', unread: false }),
    ]);
  });

  afterEach(() => db.close());

  it('returns only unread notifications for the given repo', () => {
    const rows = listNotificationsForRepo(db, 'myorg/repo1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('1');
  });

  it('returns empty array for a repo with no unread notifications', () => {
    const rows = listNotificationsForRepo(db, 'nobody/nothing');
    expect(rows).toHaveLength(0);
  });
});

describe('GitHub Notifications — listNotificationsForOwner', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    storeNotifications(db, [
      makeNotif('1', { owner: 'orgA', repoName: 'repoX' }),
      makeNotif('2', { owner: 'orgA', repoName: 'repoY' }),
      makeNotif('3', { owner: 'orgB', repoName: 'repoZ' }),
    ]);
  });

  afterEach(() => db.close());

  it('returns all unread notifications for the given owner', () => {
    const rows = listNotificationsForOwner(db, 'orgA');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.repo_owner === 'orgA')).toBe(true);
  });

  it('returns empty array for an unknown owner', () => {
    expect(listNotificationsForOwner(db, 'nobody')).toHaveLength(0);
  });
});

describe('GitHub Notifications — storeNotificationsForRepo', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    storeNotifications(db, [
      makeNotif('1', { owner: 'myorg', repoName: 'repo1' }),
      makeNotif('2', { owner: 'myorg', repoName: 'repo2' }),
    ]);
  });

  afterEach(() => db.close());

  it('replaces only notifications for the given repo', () => {
    storeNotificationsForRepo(db, 'myorg/repo1', [
      makeNotif('1-new', { owner: 'myorg', repoName: 'repo1' }),
    ]);

    const repo1Rows = listNotificationsForRepo(db, 'myorg/repo1');
    expect(repo1Rows).toHaveLength(1);
    expect(repo1Rows[0].id).toBe('1-new');

    // repo2 should be untouched
    const repo2Rows = listNotificationsForRepo(db, 'myorg/repo2');
    expect(repo2Rows).toHaveLength(1);
    expect(repo2Rows[0].id).toBe('2');
  });
});

describe('GitHub Notifications — storeNotificationsForOwner', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    storeNotifications(db, [
      makeNotif('1', { owner: 'orgA', repoName: 'repoX' }),
      makeNotif('2', { owner: 'orgB', repoName: 'repoY' }),
    ]);
  });

  afterEach(() => db.close());

  it('replaces only notifications for the given owner', () => {
    storeNotificationsForOwner(db, 'orgA', [
      makeNotif('1-updated', { owner: 'orgA', repoName: 'repoX' }),
    ]);

    const orgARows = listNotificationsForOwner(db, 'orgA');
    expect(orgARows).toHaveLength(1);
    expect(orgARows[0].id).toBe('1-updated');

    // orgB should be untouched
    const orgBRows = listNotificationsForOwner(db, 'orgB');
    expect(orgBRows).toHaveLength(1);
  });

  it('filters out notifications that do not belong to the owner', () => {
    // Provide a mix; only orgA notifications should be stored
    storeNotificationsForOwner(db, 'orgA', [
      makeNotif('a1', { owner: 'orgA', repoName: 'r1' }),
      makeNotif('b1', { owner: 'orgB', repoName: 'r2' }), // belongs to orgB, should be ignored
    ]);

    const orgARows = listNotificationsForOwner(db, 'orgA');
    expect(orgARows.map((r) => r.id)).toEqual(['a1']);
  });
});

describe('GitHub Notifications — deleteNotification', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    storeNotifications(db, [makeNotif('1'), makeNotif('2')]);
  });

  afterEach(() => db.close());

  it('removes the specified notification', () => {
    deleteNotification(db, '1');
    const res = db.exec('SELECT id FROM github_notifications');
    const ids = res[0].values.map((r) => r[0] as string);
    expect(ids).not.toContain('1');
    expect(ids).toContain('2');
  });

  it('does not throw when deleting a non-existent id', () => {
    expect(() => deleteNotification(db, 'nonexistent')).not.toThrow();
  });
});

describe('GitHub Notifications — listNotificationsForStarred', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('returns notifications only for starred repos', () => {
    insertStarredRepo(db, 'myorg/starred-repo');
    storeNotifications(db, [
      makeNotif('1', { owner: 'myorg', repoName: 'starred-repo' }),
      makeNotif('2', { owner: 'myorg', repoName: 'normal-repo' }),
    ]);

    const rows = listNotificationsForStarred(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo_full_name).toBe('myorg/starred-repo');
  });

  it('returns empty array when no starred repos have notifications', () => {
    storeNotifications(db, [makeNotif('1')]);
    expect(listNotificationsForStarred(db)).toHaveLength(0);
  });
});

// ── fetchNotificationsForRepo ─────────────────────────────────────────────────
import { fetchNotificationsForRepo, markNotificationRead, listMergedDependabotPRNotifications } from '../../src/services/github-notifications';

describe('fetchNotificationsForRepo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches notifications for a specific repo', async () => {
    const notif = makeNotif('1', { owner: 'myorg', repoName: 'myrepo' });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([notif]), {
        status: 200,
        headers: {},
      }),
    );

    const result = await fetchNotificationsForRepo('token', 'myorg/myrepo');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('fetches notification subject actor metadata', async () => {
    const notif = makeNotif('1', {
      owner: 'myorg',
      repoName: 'myrepo',
      type: 'PullRequest',
      subjectUrl: 'https://api.github.com/repos/myorg/myrepo/pulls/42',
    });
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const requestedUrl = String(url);
      if (requestedUrl.endsWith('/notifications?all=false&per_page=50')) {
        return new Response(JSON.stringify([notif]), { status: 200 });
      }
      return new Response(JSON.stringify({ user: { login: 'dependabot[bot]', type: 'Bot' } }), { status: 200 });
    });

    const result = await fetchNotificationsForRepo('token', 'myorg/myrepo');
    expect(result[0].subject_actor_login).toBe('dependabot[bot]');
    expect(result[0].subject_actor_type).toBe('Bot');
  });

  it('throws when the API returns a non-OK status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );
    await expect(fetchNotificationsForRepo('token', 'myorg/myrepo')).rejects.toThrow(
      'GitHub notifications API error: 500',
    );
  });

  it('follows pagination via Link header', async () => {
    const notif1 = makeNotif('1', { owner: 'myorg', repoName: 'myrepo' });
    const notif2 = makeNotif('2', { owner: 'myorg', repoName: 'myrepo' });

    let notificationPageCalls = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const requestedUrl = String(url);
      if (!requestedUrl.includes('/notifications')) {
        return new Response(JSON.stringify({ user: { login: 'octocat', type: 'User' } }), { status: 200 });
      }
      notificationPageCalls++;
      if (notificationPageCalls === 1) {
        return new Response(JSON.stringify([notif1]), {
          status: 200,
          headers: { Link: `<https://api.github.com/repos/myorg/myrepo/notifications?page=2>; rel="next"` },
        });
      }
      return new Response(JSON.stringify([notif2]), { status: 200 });
    });

    const result = await fetchNotificationsForRepo('token', 'myorg/myrepo');
    expect(result).toHaveLength(2);
    expect(notificationPageCalls).toBe(2);
  });
});

describe('markNotificationRead', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls DELETE on the correct thread URL', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(markNotificationRead('token', 'thread-123')).resolves.not.toThrow();
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('thread-123');
  });

  it('does not throw for 204 No Content response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(markNotificationRead('token', '123')).resolves.toBeUndefined();
  });

  it('throws for non-OK, non-204 responses', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    );
    await expect(markNotificationRead('token', '123')).rejects.toThrow(
      'GitHub mark-done API error: 403',
    );
  });
});

// ── listMergedDependabotPRNotifications ───────────────────────────────────────

function makePRNotif(
  id: string,
  opts: {
    owner?: string;
    repoName?: string;
    actorLogin?: string | null;
    actorType?: string | null;
    title?: string;
    prNumber?: number;
  } = {},
): GitHubNotification {
  const owner = opts.owner ?? 'myorg';
  const repoName = opts.repoName ?? 'myrepo';
  const prNumber = opts.prNumber ?? 1;
  return {
    id,
    unread: true,
    reason: 'subscribed',
    updated_at: new Date().toISOString(),
    subject_actor_login: opts.actorLogin !== undefined ? opts.actorLogin : 'dependabot[bot]',
    subject_actor_type: opts.actorType !== undefined ? opts.actorType : 'Bot',
    subject: {
      type: 'PullRequest',
      title: opts.title ?? `Bump some-action from 1.0.0 to 2.0.0`,
      url: `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
    },
    repository: {
      full_name: `${owner}/${repoName}`,
      name: repoName,
      owner: { login: owner },
      html_url: `https://github.com/${owner}/${repoName}`,
    },
  };
}

describe('listMergedDependabotPRNotifications', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns merged dependabot PR notifications', async () => {
    storeNotifications(db, [makePRNotif('10', { actorLogin: 'dependabot[bot]' })]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('10');
  });

  it('excludes closed-but-not-merged PRs', async () => {
    storeNotifications(db, [makePRNotif('11')]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'closed', merged_at: null }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(0);
  });

  it('excludes open PRs', async () => {
    storeNotifications(db, [makePRNotif('12')]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'open', merged_at: null }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(0);
  });

  it('excludes non-PR notifications', async () => {
    storeNotifications(db, [makeNotif('13', { type: 'CheckSuite' })]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(0);
  });

  it('excludes PR notifications not authored by dependabot', async () => {
    storeNotifications(db, [makePRNotif('14', { actorLogin: 'octocat', actorType: 'User' })]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(0);
  });

  it('detects dependabot via title pattern when actor login is null', async () => {
    storeNotifications(db, [makePRNotif('15', {
      actorLogin: null,
      actorType: 'Bot',
      title: 'Bump actions/checkout from 3.0.0 to 4.0.0',
    })]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(1);
  });

  it('does not false-positive on renovate-style bot with generic title', async () => {
    storeNotifications(db, [makePRNotif('16', {
      actorLogin: 'renovate[bot]',
      actorType: 'Bot',
      title: 'Update dependency some-package to v3',
    })]);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), { status: 200 }),
    );

    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(0);
  });

  it('returns partial results when one PR check fails', async () => {
    storeNotifications(db, [
      makePRNotif('17', { prNumber: 1 }),
      makePRNotif('18', { prNumber: 2 }),
    ]);
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Network error');
      return new Response(JSON.stringify({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), { status: 200 });
    });

    const result = await listMergedDependabotPRNotifications(db, 'token');
    // One fails (treated as not-merged), one succeeds
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no notifications are stored', async () => {
    globalThis.fetch = vi.fn();
    const result = await listMergedDependabotPRNotifications(db, 'token');
    expect(result).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
