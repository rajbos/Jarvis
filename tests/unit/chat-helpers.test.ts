/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { saveGitHubAuth } from '../../src/services/github-oauth';
import { searchReposForChat, buildSystemContext, searchOneNoteForChat, searchSecretsForChat } from '../../src/plugins/chat/db-helpers';

// Helpers for seeding test data
function insertOrg(db: SqlJsDatabase, login: string, enabled = true): number {
  db.run(
    `INSERT INTO github_orgs (login, name, discovery_enabled) VALUES (?, ?, ?)`,
    [login, login, enabled ? 1 : 0],
  );
  const res = db.exec('SELECT last_insert_rowid() AS id');
  return res[0].values[0][0] as number;
}

function insertRepo(db: SqlJsDatabase, opts: {
  full_name: string;
  org_id?: number | null;
  language?: string;
  description?: string;
  archived?: boolean;
  fork?: boolean;
  starred?: boolean;
  is_private?: boolean;
  last_pushed_at?: string;
}): void {
  const name = opts.full_name.split('/').pop() ?? opts.full_name;
  db.run(
    `INSERT INTO github_repos
       (full_name, name, org_id, language, description, archived, fork, starred, private, last_pushed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.full_name,
      name,
      opts.org_id ?? null,
      opts.language ?? null,
      opts.description ?? null,
      opts.archived ? 1 : 0,
      opts.fork ? 1 : 0,
      opts.starred ? 1 : 0,
      opts.is_private ? 1 : 0,
      opts.last_pushed_at ?? new Date().toISOString(),
    ],
  );
}

describe('searchReposForChat', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-key-for-chat-helpers';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    // Seed: one enabled org, one disabled org, some personal repos
    const enabledOrgId = insertOrg(db, 'myorg', true);
    const disabledOrgId = insertOrg(db, 'secretorg', false);

    insertRepo(db, { full_name: 'myorg/api-gateway', org_id: enabledOrgId, language: 'TypeScript', description: 'API gateway service' });
    insertRepo(db, { full_name: 'myorg/frontend', org_id: enabledOrgId, language: 'JavaScript', description: 'React frontend' });
    insertRepo(db, { full_name: 'myorg/archived-lib', org_id: enabledOrgId, language: 'Python', archived: true });
    insertRepo(db, { full_name: 'secretorg/hidden-repo', org_id: disabledOrgId, language: 'Rust', description: 'Should not appear' });
    insertRepo(db, { full_name: 'user/personal-project', org_id: null, language: 'Go', description: 'My personal project', starred: true });
    insertRepo(db, { full_name: 'user/private-tool', org_id: null, language: 'Python', is_private: true, fork: true });
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('finds repos matching a single term in full_name', () => {
    const result = searchReposForChat(db, 'gateway');
    expect(result).toContain('myorg/api-gateway');
    expect(result).toContain('1 repository');
  });

  it('finds repos matching a term in description', () => {
    const result = searchReposForChat(db, 'frontend');
    expect(result).toContain('myorg/frontend');
  });

  it('finds repos matching by language', () => {
    const result = searchReposForChat(db, 'typescript');
    expect(result).toContain('myorg/api-gateway');
  });

  it('requires all words to match (AND logic)', () => {
    const result = searchReposForChat(db, 'myorg typescript');
    expect(result).toContain('myorg/api-gateway');
    // JavaScript frontend does not match typescript
    expect(result).not.toContain('myorg/frontend');
  });

  it('excludes repos from disabled orgs', () => {
    const result = searchReposForChat(db, 'hidden');
    expect(result).toContain('No repositories found matching');
    expect(result).not.toContain('secretorg/hidden-repo');
  });

  it('includes personal repos (org_id IS NULL)', () => {
    const result = searchReposForChat(db, 'personal');
    expect(result).toContain('user/personal-project');
  });

  it('includes metadata tags in output (archived, fork, private, starred)', () => {
    const archived = searchReposForChat(db, 'archived-lib');
    expect(archived).toContain('[Python, archived]');

    const privateRepo = searchReposForChat(db, 'private-tool');
    expect(privateRepo).toContain('[Python, private, fork]');

    const starred = searchReposForChat(db, 'personal-project');
    expect(starred).toContain('[Go, starred]');
  });

  it('returns "No repositories found" for a query with no matches', () => {
    const result = searchReposForChat(db, 'zzznomatch999');
    expect(result).toContain('No repositories found matching');
  });

  it('returns "No search terms provided" for an empty query', () => {
    expect(searchReposForChat(db, '')).toBe('No search terms provided.');
    expect(searchReposForChat(db, '   ')).toBe('No search terms provided.');
  });

  it('is case-insensitive', () => {
    expect(searchReposForChat(db, 'TYPESCRIPT')).toContain('myorg/api-gateway');
    expect(searchReposForChat(db, 'TypeScript')).toContain('myorg/api-gateway');
  });

  it('uses plural "repositories" for multiple results', () => {
    const result = searchReposForChat(db, 'myorg');
    expect(result).toContain('repositories');
  });

  it('uses singular "repository" for a single result', () => {
    const result = searchReposForChat(db, 'gateway');
    expect(result).toContain('1 repository');
  });
});

// ── buildSystemContext ────────────────────────────────────────────────────────
describe('buildSystemContext', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-key-for-chat-helpers';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('includes the Jarvis identity line', () => {
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('You are Jarvis');
  });

  it('includes a GitHub user line when auth is present', () => {
    saveGitHubAuth(db, 'octocat', 'ghp_faketoken123', 'repo');
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('GitHub user: octocat');
  });

  it('does not include GitHub user line when no auth', () => {
    const ctx = buildSystemContext(db);
    expect(ctx).not.toContain('GitHub user:');
  });

  it('reports total repos indexed', () => {
    const orgId = insertOrg(db, 'acme', true);
    insertRepo(db, { full_name: 'acme/backend', org_id: orgId });
    insertRepo(db, { full_name: 'acme/frontend', org_id: orgId });
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('Total repositories indexed: 2');
  });

  it('lists enabled organizations', () => {
    const orgId = insertOrg(db, 'acme', true);
    insertRepo(db, { full_name: 'acme/repo1', org_id: orgId });
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('Organizations (1):');
    expect(ctx).toContain('acme (1 repos)');
  });

  it('lists disabled organizations separately', () => {
    insertOrg(db, 'secret-corp', false);
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('Excluded organizations');
    expect(ctx).toContain('secret-corp');
  });

  it('reports starred repo count when present', () => {
    insertRepo(db, { full_name: 'user/starred-thing', org_id: null, starred: true });
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('Starred repositories: 1');
  });

  it('reports personal/collaborator repos when present', () => {
    insertRepo(db, { full_name: 'user/my-tool', org_id: null });
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('Personal/collaborator repositories: 1');
  });

  it('lists recent repos in context', () => {
    const orgId = insertOrg(db, 'corp', true);
    insertRepo(db, { full_name: 'corp/api', org_id: orgId, language: 'TypeScript', description: 'Main API' });
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('corp/api');
    expect(ctx).toContain('[TypeScript]');
    expect(ctx).toContain(': Main API');
  });

  it('includes instruction text about limitations', () => {
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('IMPORTANT');
    expect(ctx).toContain('Do NOT fabricate');
  });

  it('includes OneNote cache summary when pages exist', () => {
    // Seed a group, folder, and cached page
    db.run(`INSERT INTO groups (name) VALUES ('ACME')`);
    const gid = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
    db.run(`INSERT INTO onedrive_roots (path, label) VALUES ('C:\\onedrive', 'Main')`);
    const rid = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
    db.run(`INSERT INTO onedrive_customer_folders (group_id, root_id, status) VALUES (?, ?, 'found')`, [gid, rid]);
    const fid = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Notes.one', 'Notes', 1, 1, 'Hello', 'World content', NULL, 'binary')`,
      [fid],
    );
    const ctx = buildSystemContext(db);
    expect(ctx).toContain('OneNote pages cached');
    expect(ctx).toContain('search_onenote');
  });

  it('omits OneNote section when no pages cached', () => {
    const ctx = buildSystemContext(db);
    expect(ctx).not.toContain('OneNote pages cached');
  });
});

// ── searchOneNoteForChat ──────────────────────────────────────────────────────
describe('searchOneNoteForChat', () => {
  let db: SqlJsDatabase;
  let folderId: number;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-key-for-chat-helpers';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    // group A with one folder and two section files
    db.run(`INSERT INTO groups (name) VALUES ('Acme Corp')`);
    const gid = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
    db.run(`INSERT INTO onedrive_roots (path, label) VALUES ('C:\\od', 'Root')`);
    const rid = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
    db.run(`INSERT INTO onedrive_customer_folders (group_id, root_id, status) VALUES (?, ?, 'found')`, [gid, rid]);
    folderId = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;

    // group B
    db.run(`INSERT INTO groups (name) VALUES ('Beta LLC')`);
    const gid2 = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
    db.run(`INSERT INTO onedrive_customer_folders (group_id, root_id, status) VALUES (?, ?, 'found')`, [gid2, rid]);
    const fid2 = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;

    // Seed pages
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'General.one', 'General', 1, 1, 'Project kickoff', 'We decided to use TypeScript for all services.', '2026-05-01T09:00:00.000Z', 'binary')`,
      [folderId],
    );
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'General.one', 'General', 2, 2, 'Sub-page note', 'Additional details on the architecture decision.', '2026-05-02T09:00:00.000Z', 'binary')`,
      [folderId],
    );
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Finance.one', 'Finance', 1, 1, 'Budget Q1', 'The total budget for Q1 is 50000 EUR.', '2026-04-15T09:00:00.000Z', 'binary')`,
      [folderId],
    );
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Beta.one', 'Beta', 1, 1, 'Beta planning', 'We plan to launch the beta in Q2.', '2026-05-20T09:00:00.000Z', 'binary')`,
      [fid2],
    );
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('finds pages matching a single term in content', () => {
    const result = searchOneNoteForChat(db, 'TypeScript');
    expect(result).toContain('Project kickoff');
    expect(result).toContain('Acme Corp');
  });

  it('finds pages matching a term in page title', () => {
    const result = searchOneNoteForChat(db, 'Budget');
    expect(result).toContain('Budget Q1');
    expect(result).toContain('Finance');
  });

  it('requires all words to match (AND logic)', () => {
    const result = searchOneNoteForChat(db, 'budget Q1');
    expect(result).toContain('Budget Q1');
    expect(result).not.toContain('Project kickoff');
  });

  it('includes sub-page indentation indicator for page_level > 1', () => {
    const result = searchOneNoteForChat(db, 'architecture');
    expect(result).toContain('↳');
  });

  it('filters by group name when provided', () => {
    const result = searchOneNoteForChat(db, 'Q2', 'Beta');
    expect(result).toContain('Beta LLC');
    expect(result).not.toContain('Acme Corp');
  });

  it('returns no-match message when nothing found', () => {
    const result = searchOneNoteForChat(db, 'zzznomatch999');
    expect(result).toContain('No OneNote pages found matching');
    expect(result).toContain('zzznomatch999');
  });

  it('returns no-search-terms message for empty query', () => {
    expect(searchOneNoteForChat(db, '')).toBe('No search terms provided.');
    expect(searchOneNoteForChat(db, '   ')).toBe('No search terms provided.');
  });

  it('is case-insensitive', () => {
    expect(searchOneNoteForChat(db, 'TYPESCRIPT')).toContain('Project kickoff');
    expect(searchOneNoteForChat(db, 'typescript')).toContain('Project kickoff');
  });

  it('includes section name in output', () => {
    const result = searchOneNoteForChat(db, 'TypeScript');
    expect(result).toContain('General');
  });

  it('includes a content snippet', () => {
    const result = searchOneNoteForChat(db, 'TypeScript');
    expect(result).toContain('TypeScript');
  });

  it('filters by since date — excludes older pages', () => {
    // Budget Q1 was last modified 2026-04-15, kickoff 2026-05-01
    const result = searchOneNoteForChat(db, 'budget', undefined, '2026-05-01');
    expect(result).toContain('No OneNote pages found matching');
  });

  it('filters by since date — includes pages on or after the date', () => {
    const result = searchOneNoteForChat(db, 'TypeScript', undefined, '2026-05-01');
    expect(result).toContain('Project kickoff');
  });

  it('shows modified date in output', () => {
    const result = searchOneNoteForChat(db, 'TypeScript');
    expect(result).toContain('modified:');
  });

  it('includes today\'s date in buildSystemContext', () => {
    const ctx = buildSystemContext(db);
    const today = new Date().toISOString().slice(0, 10);
    expect(ctx).toContain(`Today's date: ${today}`);
  });

  it('shows "no match" hint when groupName is provided but nothing found', () => {
    // group filter + no results → hint includes group name
    const result = searchOneNoteForChat(db, 'zzznomatch999', 'Acme Corp');
    expect(result).toContain('in group "Acme Corp"');
  });

  it('shows date hint when since is provided but nothing found', () => {
    const result = searchOneNoteForChat(db, 'zzznomatch999', undefined, '2099-01-01');
    expect(result).toContain('since 2099-01-01');
  });

  it('handles pages with null section_name gracefully', () => {
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Null.one', NULL, 3, 1, 'No section page', 'Content without section.', '2026-05-10T09:00:00.000Z', 'binary')`,
      [folderId],
    );
    const result = searchOneNoteForChat(db, 'section');
    expect(result).toContain('No section page');
  });

  it('handles pages with null page_last_modified in output', () => {
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Notes.one', 'Notes', 4, 1, 'Undated page', 'Some undated content here.', NULL, 'binary')`,
      [folderId],
    );
    const result = searchOneNoteForChat(db, 'undated');
    // Should not crash, and should NOT include "[modified:" for this page
    expect(result).toContain('Undated page');
    expect(result).not.toContain('[modified: null]');
  });

  it('handles pages with null page_date in output', () => {
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Notes.one', 'Notes', 5, 1, 'No date page', 'Content with no date at all.', '2026-05-11T09:00:00.000Z', 'binary')`,
      [folderId],
    );
    const result = searchOneNoteForChat(db, 'no date');
    expect(result).toContain('No date page');
  });

  it('shows ellipsis prefix when snippet does not start at beginning', () => {
    // Create content long enough that the matching word is deep in the text
    const padding = 'x '.repeat(200);
    const content = `${padding}special-term-xyz found here`;
    db.run(
      `INSERT INTO onedrive_onenote_cache (folder_id, relative_path, section_name, page_index, page_level, page_title, page_content, page_last_modified, read_source)
       VALUES (?, 'Long.one', 'Long', 6, 1, 'Long content page', ?, '2026-05-12T09:00:00.000Z', 'binary')`,
      [folderId, content],
    );
    const result = searchOneNoteForChat(db, 'special-term-xyz');
    expect(result).toContain('…');
  });
});

// ── searchSecretsForChat ──────────────────────────────────────────────────────
describe('searchSecretsForChat', () => {
  let db: SqlJsDatabase;

  function insertRepo(d: SqlJsDatabase, fullName: string): number {
    const name = fullName.split('/').pop() ?? fullName;
    d.run(
      `INSERT INTO github_repos (full_name, name, language, description, archived, fork, starred, private, last_pushed_at)
       VALUES (?, ?, NULL, NULL, 0, 0, 0, 0, datetime('now'))`,
      [fullName, name],
    );
    const res = d.exec('SELECT last_insert_rowid() AS id');
    return res[0].values[0][0] as number;
  }

  function insertSecret(d: SqlJsDatabase, repoId: number, secretName: string): void {
    d.run(
      `INSERT INTO repo_secrets (github_repo_id, secret_name) VALUES (?, ?)`,
      [repoId, secretName],
    );
  }

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-key-for-chat-helpers';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('returns "No pattern provided" for empty query', () => {
    expect(searchSecretsForChat(db, '')).toBe('No pattern provided.');
    expect(searchSecretsForChat(db, '   ')).toBe('No pattern provided.');
  });

  it('returns "no secrets scanned" when table is empty', () => {
    const result = searchSecretsForChat(db, 'TOKEN');
    expect(result).toContain('No secrets have been scanned yet');
  });

  it('returns "no matching secrets" when table has secrets but none match', () => {
    const repoId = insertRepo(db, 'org/repo-a');
    insertSecret(db, repoId, 'NPM_TOKEN');
    const result = searchSecretsForChat(db, 'GITHUB_SECRET');
    expect(result).toContain('No secrets matching');
    expect(result).toContain('1 scanned secret');
  });

  it('returns matching secrets grouped by repo', () => {
    const repo1 = insertRepo(db, 'org/repo-a');
    const repo2 = insertRepo(db, 'org/repo-b');
    insertSecret(db, repo1, 'NPM_TOKEN');
    insertSecret(db, repo1, 'DOCKER_TOKEN');
    insertSecret(db, repo2, 'NPM_TOKEN');

    const result = searchSecretsForChat(db, 'TOKEN');
    expect(result).toContain('org/repo-a');
    expect(result).toContain('org/repo-b');
    expect(result).toContain('NPM_TOKEN');
    expect(result).toContain('DOCKER_TOKEN');
    expect(result).toContain('3 secret(s)');
  });

  it('is case-insensitive', () => {
    const repoId = insertRepo(db, 'org/repo');
    insertSecret(db, repoId, 'DEPLOY_KEY');
    expect(searchSecretsForChat(db, 'deploy_key')).toContain('DEPLOY_KEY');
    expect(searchSecretsForChat(db, 'DEPLOY_KEY')).toContain('DEPLOY_KEY');
  });
});

// ── buildSystemContext with secrets ───────────────────────────────────────────
describe('buildSystemContext — secrets section', () => {
  let db: SqlJsDatabase;

  function insertRepo(d: SqlJsDatabase, fullName: string): number {
    const name = fullName.split('/').pop() ?? fullName;
    d.run(
      `INSERT INTO github_repos (full_name, name, language, description, archived, fork, starred, private, last_pushed_at)
       VALUES (?, ?, NULL, NULL, 0, 0, 0, 0, datetime('now'))`,
      [fullName, name],
    );
    const res = d.exec('SELECT last_insert_rowid() AS id');
    return res[0].values[0][0] as number;
  }

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-key-for-chat-helpers';
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    delete process.env.JARVIS_ENCRYPTION_KEY;
  });

  it('includes secrets summary in context when secrets are scanned', () => {
    const repoId = insertRepo(db, 'org/my-service');
    db.run(`INSERT INTO repo_secrets (github_repo_id, secret_name) VALUES (?, ?)`, [repoId, 'NPM_TOKEN']);
    db.run(`INSERT INTO repo_secrets (github_repo_id, secret_name) VALUES (?, ?)`, [repoId, 'DOCKER_TOKEN']);

    const ctx = buildSystemContext(db);
    expect(ctx).toContain('GitHub Actions secrets');
    expect(ctx).toContain('org/my-service');
    expect(ctx).toContain('NPM_TOKEN');
  });
});
