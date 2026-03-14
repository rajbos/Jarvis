import type { Database as SqlJsDatabase } from 'sql.js';

const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    type: string;   // Issue, PullRequest, Commit, Release, Discussion, CheckSuite
    title: string;
    url: string | null;
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
    html_url: string;
  };
}

export interface NotificationCounts {
  perOrg: Record<string, number>;   // orgLogin → unread count
  perRepo: Record<string, number>;  // repo full_name → unread count
  total: number;
  starredTotal: number;
  fetchedAt: string | null;
}

export interface StoredNotification {
  id: string;
  repo_full_name: string;
  repo_owner: string;
  subject_type: string;
  subject_title: string;
  subject_url: string | null;
  reason: string;
  unread: number;
  updated_at: string;
  fetched_at: string;
}

async function fetchPage(
  url: string,
  accessToken: string,
): Promise<{ items: GitHubNotification[]; nextUrl: string | null }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub notifications API error: ${response.status} ${response.statusText}`,
    );
  }

  const items = (await response.json()) as GitHubNotification[];

  // Parse Link header for next page
  const linkHeader = response.headers.get('Link');
  let nextUrl: string | null = null;
  if (linkHeader) {
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (match) nextUrl = match[1];
  }

  return { items, nextUrl };
}

/**
 * Fetch all unread notifications for the authenticated user via GitHub API.
 * Automatically follows pagination.
 */
export async function fetchNotifications(
  accessToken: string,
  onProgress?: (count: number) => void,
): Promise<GitHubNotification[]> {
  const all: GitHubNotification[] = [];
  let url: string | null =
    `${GITHUB_API_BASE}/notifications?all=false&per_page=50`;

  while (url) {
    const { items, nextUrl } = await fetchPage(url, accessToken);
    all.push(...items);
    onProgress?.(all.length);
    url = nextUrl;
  }

  return all;
}

/**
 * Replaces all stored notifications with the freshly fetched set.
 */
export function storeNotifications(
  db: SqlJsDatabase,
  notifications: GitHubNotification[],
): void {
  db.run('DELETE FROM github_notifications');

  for (const n of notifications) {
    db.run(
      `INSERT INTO github_notifications
        (id, repo_full_name, repo_owner, subject_type, subject_title, subject_url, reason, unread, updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        n.id,
        n.repository.full_name,
        n.repository.owner.login,
        n.subject.type,
        n.subject.title,
        n.subject.url ?? null,
        n.reason,
        n.unread ? 1 : 0,
        n.updated_at,
      ],
    );
  }
}

/**
 * Returns notification counts aggregated per org and per repo,
 * plus the timestamp of the last fetch.
 */
export function getNotificationCounts(db: SqlJsDatabase): NotificationCounts {
  const perOrg: Record<string, number> = {};
  const perRepo: Record<string, number> = {};

  const countStmt = db.prepare(`
    SELECT repo_owner, repo_full_name, COUNT(*) as cnt
    FROM github_notifications
    WHERE unread = 1
    GROUP BY repo_owner, repo_full_name
    ORDER BY cnt DESC
  `);

  let total = 0;
  while (countStmt.step()) {
    const row = countStmt.getAsObject() as {
      repo_owner: string;
      repo_full_name: string;
      cnt: number;
    };
    perRepo[row.repo_full_name] = row.cnt;
    perOrg[row.repo_owner] = (perOrg[row.repo_owner] ?? 0) + row.cnt;
    total += row.cnt;
  }
  countStmt.free();

  const fetchStmt = db.prepare(
    'SELECT MAX(fetched_at) as last_fetch FROM github_notifications',
  );
  let fetchedAt: string | null = null;
  if (fetchStmt.step()) {
    const row = fetchStmt.getAsObject() as { last_fetch: string | null };
    fetchedAt = row.last_fetch ?? null;
  }
  fetchStmt.free();

  const starredStmt = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM github_notifications n
    WHERE n.unread = 1
      AND n.repo_full_name IN (SELECT full_name FROM github_repos WHERE starred = 1)
  `);
  let starredTotal = 0;
  if (starredStmt.step()) {
    const row = starredStmt.getAsObject() as { cnt: number };
    starredTotal = row.cnt;
  }
  starredStmt.free();

  return { perOrg, perRepo, total, fetchedAt, starredTotal };
}

/**
 * Fetch all unread notifications for a specific repository via the dedicated API endpoint.
 */
export async function fetchNotificationsForRepo(
  accessToken: string,
  repoFullName: string,
): Promise<GitHubNotification[]> {
  const [owner, repo] = repoFullName.split('/');
  const all: GitHubNotification[] = [];
  let url: string | null =
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/notifications?all=false&per_page=50`;

  while (url) {
    const { items, nextUrl } = await fetchPage(url, accessToken);
    all.push(...items);
    url = nextUrl;
  }

  return all;
}

/**
 * Replace stored notifications for a specific repository only (leaves other repos untouched).
 */
export function storeNotificationsForRepo(
  db: SqlJsDatabase,
  repoFullName: string,
  notifications: GitHubNotification[],
): void {
  db.run('DELETE FROM github_notifications WHERE repo_full_name = ?', [repoFullName]);

  for (const n of notifications) {
    db.run(
      `INSERT INTO github_notifications
        (id, repo_full_name, repo_owner, subject_type, subject_title, subject_url, reason, unread, updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        n.id,
        n.repository.full_name,
        n.repository.owner.login,
        n.subject.type,
        n.subject.title,
        n.subject.url ?? null,
        n.reason,
        n.unread ? 1 : 0,
        n.updated_at,
      ],
    );
  }
}

/**
 * Replace stored notifications for all repos belonging to a specific owner only.
 * Pass the full set of all-notifications already fetched from GitHub; this function
 * filters to the given owner and updates only those rows in the DB.
 */
export function storeNotificationsForOwner(
  db: SqlJsDatabase,
  owner: string,
  notifications: GitHubNotification[],
): void {
  db.run('DELETE FROM github_notifications WHERE repo_owner = ?', [owner]);

  for (const n of notifications.filter((n) => n.repository.owner.login === owner)) {
    db.run(
      `INSERT INTO github_notifications
        (id, repo_full_name, repo_owner, subject_type, subject_title, subject_url, reason, unread, updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        n.id,
        n.repository.full_name,
        n.repository.owner.login,
        n.subject.type,
        n.subject.title,
        n.subject.url ?? null,
        n.reason,
        n.unread ? 1 : 0,
        n.updated_at,
      ],
    );
  }
}

/**
 * Returns all unread notifications for a specific repository, newest first.
 */
export function listNotificationsForRepo(
  db: SqlJsDatabase,
  repoFullName: string,
): StoredNotification[] {
  const stmt = db.prepare(`
    SELECT id, repo_full_name, repo_owner, subject_type, subject_title, subject_url, reason, unread, updated_at, fetched_at
    FROM github_notifications
    WHERE repo_full_name = ? AND unread = 1
    ORDER BY updated_at DESC
  `);
  stmt.bind([repoFullName]);
  const rows: StoredNotification[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as StoredNotification);
  stmt.free();
  return rows;
}

/**
 * Returns all unread notifications for a given owner (org login or user login),
 * ordered by repo then date.
 */
export function listNotificationsForOwner(
  db: SqlJsDatabase,
  owner: string,
): StoredNotification[] {
  const stmt = db.prepare(`
    SELECT id, repo_full_name, repo_owner, subject_type, subject_title, subject_url, reason, unread, updated_at, fetched_at
    FROM github_notifications
    WHERE repo_owner = ? AND unread = 1
    ORDER BY repo_full_name, updated_at DESC
  `);
  stmt.bind([owner]);
  const rows: StoredNotification[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as StoredNotification);
  stmt.free();
  return rows;
}

/**
 * Returns all unread notifications for starred repositories, ordered by repo then date.
 */
export function listNotificationsForStarred(
  db: SqlJsDatabase,
): StoredNotification[] {
  const stmt = db.prepare(`
    SELECT n.id, n.repo_full_name, n.repo_owner, n.subject_type, n.subject_title, n.subject_url, n.reason, n.unread, n.updated_at, n.fetched_at
    FROM github_notifications n
    WHERE n.unread = 1
      AND n.repo_full_name IN (SELECT full_name FROM github_repos WHERE starred = 1)
    ORDER BY n.repo_full_name, n.updated_at DESC
  `);
  const rows: StoredNotification[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as StoredNotification);
  stmt.free();
  return rows;
}

/**
 * Deletes a single notification from the local database by its ID.
 */
export function deleteNotification(db: SqlJsDatabase, id: string): void {
  db.run('DELETE FROM github_notifications WHERE id = ?', [id]);
}

/**
 * Calls the GitHub API to mark a notification thread as done (removes it from GitHub inbox).
 * DELETE /notifications/threads/{thread_id} — returns 204 No Content.
 */
export async function markNotificationRead(
  accessToken: string,
  threadId: string,
): Promise<void> {
  const response = await fetch(
    `${GITHUB_API_BASE}/notifications/threads/${encodeURIComponent(threadId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok && response.status !== 204) {
    throw new Error(
      `GitHub mark-done API error: ${response.status} ${response.statusText}`,
    );
  }
}
