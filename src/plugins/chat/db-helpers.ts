// ── Chat DB helpers ────────────────────────────────────────────────────────────
// Pure DB-query functions extracted from handler.ts so they can be unit-tested
// without requiring an electron mock.
import type { Database as SqlJsDatabase } from 'sql.js';
import { loadGitHubAuth } from '../../services/github-oauth';
import { listOrgs } from '../../services/github-discovery';

// ── System context builder ────────────────────────────────────────────────────

export function buildSystemContext(db: SqlJsDatabase): string {
  const lines: string[] = [
    'You are Jarvis, a personal GitHub repository assistant.',
    'You have access to the user\'s GitHub data that has been indexed into a local database (snapshot shown below).',
    'Help the user find repos, understand their codebase, and answer questions about their repositories.',
    'Be concise and helpful. When listing repos, use the full_name format (org/repo).',
    '',
    'IMPORTANT — when the indexed data is insufficient to answer a question fully:',
    '1. Tell the user clearly what you do and do not know based on the current snapshot.',
    '2. Specify exactly which additional data would be needed, choosing from this list of fields',
    '   not yet stored in the database:',
    '   - Repository topics / tags',
    '   - README content',
    '   - Open issue count and recent issue titles',
    '   - Open pull-request count',
    '   - Contributor list',
    '   - CI/CD workflow names and last-run status',
    '   - Release tags and latest release date',
    '   - Primary programming language breakdown (beyond the single "language" field)',
    '   - Repository size (disk / LOC estimate)',
    '   - Branch protection rules',
    '3. Suggest the user enables discovery for any organisation that is currently excluded,',
    '   if the missing repos are likely there.',
    'Do NOT fabricate data that is not present in the snapshot below.',
    '',
  ];

  const auth = loadGitHubAuth(db);
  if (auth?.login) lines.push(`GitHub user: ${auth.login}`);

  const { orgs, directRepoCount, starredRepoCount } = listOrgs(db);
  const enabledOrgs = orgs.filter(o => o.discoveryEnabled);
  const disabledOrgs = orgs.filter(o => !o.discoveryEnabled);
  const totalRepos = enabledOrgs.reduce((s, o) => s + o.repoCount, 0) + directRepoCount;
  if (enabledOrgs.length > 0) {
    lines.push(`Organizations (${enabledOrgs.length}): ${enabledOrgs.slice(0, 20).map(o => `${o.login} (${o.repoCount} repos)`).join(', ')}`);
  }
  if (disabledOrgs.length > 0) {
    lines.push(`Excluded organizations (discovery disabled): ${disabledOrgs.map(o => o.login).join(', ')}`);
  }
  lines.push(`Total repositories indexed: ${totalRepos}`);
  if (starredRepoCount > 0) lines.push(`Starred repositories: ${starredRepoCount}`);
  if (directRepoCount > 0) lines.push(`Personal/collaborator repositories: ${directRepoCount}`);
  lines.push('');

  const stmt = db.prepare(
    `SELECT r.full_name, r.language, r.description, r.archived, r.fork, r.starred
     FROM github_repos r
     WHERE r.org_id IS NULL
        OR r.org_id IN (SELECT id FROM github_orgs WHERE discovery_enabled = 1)
     ORDER BY r.last_pushed_at DESC LIMIT 40`,
  );
  type RepoRow = { full_name: string; language: string | null; description: string | null; archived: number; fork: number; starred: number };
  const recent: RepoRow[] = [];
  while (stmt.step()) recent.push(stmt.getAsObject() as RepoRow);
  stmt.free();

  if (recent.length > 0) {
    lines.push(`Recently active repositories (${recent.length} shown of ${totalRepos} total):`);
    for (const r of recent) {
      const meta: string[] = [];
      if (r.language) meta.push(r.language);
      if (r.fork) meta.push('fork');
      if (r.archived) meta.push('archived');
      if (r.starred) meta.push('starred');
      const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
      const desc = r.description ? `: ${r.description.slice(0, 80)}` : '';
      lines.push(`- ${r.full_name}${metaStr}${desc}`);
    }
  }

  return lines.join('\n');
}

// ── Repo search ───────────────────────────────────────────────────────────────

interface RepoSearchRow {
  full_name: string;
  language: string | null;
  description: string | null;
  archived: number;
  fork: number;
  starred: number;
  private: number;
}

export function searchReposForChat(db: SqlJsDatabase, query: string): string {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'No search terms provided.';

  const conditions = words.map(() =>
    `(LOWER(r.full_name) LIKE ? OR LOWER(COALESCE(r.description,'')) LIKE ? OR LOWER(COALESCE(r.language,'')) LIKE ?)`,
  ).join(' AND ');
  const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);

  const sql = `
    SELECT r.full_name, r.language, r.description, r.archived, r.fork, r.starred, r.private
    FROM github_repos r
    WHERE (r.org_id IS NULL OR r.org_id IN (SELECT id FROM github_orgs WHERE discovery_enabled = 1))
      AND ${conditions}
    ORDER BY r.last_pushed_at DESC
    LIMIT 20`;

  const stmt = db.prepare(sql);
  const rows: RepoSearchRow[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as RepoSearchRow);
  } finally {
    stmt.free();
  }

  if (rows.length === 0) return `No repositories found matching: ${query}`;

  const lines = [`Found ${rows.length} repositor${rows.length === 1 ? 'y' : 'ies'} matching "${query}":`];
  for (const r of rows) {
    const meta: string[] = [];
    if (r.language) meta.push(r.language);
    if (r.private) meta.push('private');
    if (r.fork) meta.push('fork');
    if (r.archived) meta.push('archived');
    if (r.starred) meta.push('starred');
    const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
    const desc = r.description ? `: ${r.description.slice(0, 100)}` : '';
    lines.push(`- ${r.full_name}${metaStr}${desc}`);
  }
  return lines.join('\n');
}
