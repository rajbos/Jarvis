/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  parseGitRemotes,
  normalizeGitHubUrl,
  isGitRepo,
  findGitRepos,
  getScanFolders,
  addScanFolder,
  removeScanFolder,
  upsertLocalRepo,
  autoLinkLocalRepos,
  linkLocalRepo,
  listLocalRepos,
  listLocalReposForFolder,
  runLocalDiscovery,
} from '../../src/services/local-discovery';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createFakeRepo(
  repoPath: string,
  remotes: { name: string; url: string }[] = [],
): void {
  fs.mkdirSync(repoPath, { recursive: true });
  const gitDir = path.join(repoPath, '.git');
  fs.mkdirSync(gitDir);

  let configContent = '[core]\n\trepositoryformatversion = 0\n';
  for (const remote of remotes) {
    configContent += `[remote "${remote.name}"]\n\turl = ${remote.url}\n\tfetch = +refs/heads/*:refs/remotes/${remote.name}/*\n`;
  }
  fs.writeFileSync(path.join(gitDir, 'config'), configContent, 'utf-8');
}

// ── parseGitRemotes ───────────────────────────────────────────────────────────

describe('parseGitRemotes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it('parses a single remote', () => {
    createFakeRepo(tmpDir, [{ name: 'origin', url: 'https://github.com/org/repo.git' }]);
    const remotes = parseGitRemotes(tmpDir);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toEqual({ name: 'origin', url: 'https://github.com/org/repo.git' });
  });

  it('parses multiple remotes', () => {
    createFakeRepo(tmpDir, [
      { name: 'origin', url: 'git@github.com:org/repo.git' },
      { name: 'upstream', url: 'https://github.com/upstream/repo.git' },
    ]);
    const remotes = parseGitRemotes(tmpDir);
    expect(remotes).toHaveLength(2);
    expect(remotes.map((r) => r.name)).toContain('origin');
    expect(remotes.map((r) => r.name)).toContain('upstream');
  });

  it('returns empty array when .git/config does not exist', () => {
    const remotes = parseGitRemotes(tmpDir);
    expect(remotes).toEqual([]);
  });

  it('returns empty array when readFileSync throws', () => {
    // Create .git dir but make config unreadable by making it a directory
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'config')); // config as directory causes readFileSync to throw
    const remotes = parseGitRemotes(tmpDir);
    expect(remotes).toEqual([]);
  });

  it('resets currentRemote when a non-remote section is encountered', () => {
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    // A config where a [branch] section appears after a remote without url line finishing first
    const configContent = [
      '[remote "origin"]',
      '\turl = https://github.com/org/repo.git',
      '[branch "main"]',
      '\turl = should-not-be-captured',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(gitDir, 'config'), configContent, 'utf-8');

    const remotes = parseGitRemotes(tmpDir);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toEqual({ name: 'origin', url: 'https://github.com/org/repo.git' });
  });

  it('handles config with no remotes', () => {
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\tbare = false\n', 'utf-8');
    const remotes = parseGitRemotes(tmpDir);
    expect(remotes).toEqual([]);
  });
});

// ── normalizeGitHubUrl ────────────────────────────────────────────────────────

describe('normalizeGitHubUrl', () => {
  it('returns null for empty string', () => {
    expect(normalizeGitHubUrl('')).toBeNull();
  });

  it('parses HTTPS URL with .git suffix', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses HTTPS URL without .git suffix', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses HTTPS URL with trailing slash', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo/')).toBe('owner/repo');
  });

  it('parses HTTPS URL with credentials', () => {
    expect(normalizeGitHubUrl('https://user@github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses SSH URL with .git suffix', () => {
    expect(normalizeGitHubUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('parses SSH URL without .git suffix', () => {
    expect(normalizeGitHubUrl('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('parses SSH URL with trailing slash', () => {
    expect(normalizeGitHubUrl('git@github.com:owner/repo/')).toBe('owner/repo');
  });

  it('returns null for non-GitHub HTTPS URLs', () => {
    expect(normalizeGitHubUrl('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  it('returns null for non-GitHub SSH URLs', () => {
    expect(normalizeGitHubUrl('git@gitlab.com:owner/repo.git')).toBeNull();
  });

  it('returns null for arbitrary strings', () => {
    expect(normalizeGitHubUrl('/local/path/to/repo')).toBeNull();
  });
});

// ── isGitRepo ─────────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it('returns true for a directory with a .git folder', () => {
    createFakeRepo(tmpDir);
    expect(isGitRepo(tmpDir)).toBe(true);
  });

  it('returns false for a directory without .git', () => {
    expect(isGitRepo(tmpDir)).toBe(false);
  });

  it('returns false for a non-existent path', () => {
    expect(isGitRepo(path.join(tmpDir, 'nonexistent'))).toBe(false);
  });

  it('returns false when .git exists but is a file (not a directory)', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: ../other.git\n', 'utf-8');
    expect(isGitRepo(tmpDir)).toBe(false);
  });
});

// ── findGitRepos ──────────────────────────────────────────────────────────────

describe('findGitRepos', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it('finds git repos in a flat directory', () => {
    const repoA = path.join(tmpDir, 'repo-a');
    const repoB = path.join(tmpDir, 'repo-b');
    createFakeRepo(repoA, [{ name: 'origin', url: 'https://github.com/org/repo-a.git' }]);
    createFakeRepo(repoB);

    const found = findGitRepos(tmpDir);
    const paths = found.map((r) => r.localPath);
    expect(paths).toContain(repoA);
    expect(paths).toContain(repoB);
  });

  it('does not recurse into a found git repo', () => {
    const outer = path.join(tmpDir, 'outer');
    const inner = path.join(outer, 'inner');
    createFakeRepo(outer);
    createFakeRepo(inner);

    const found = findGitRepos(tmpDir);
    const paths = found.map((r) => r.localPath);
    expect(paths).toContain(outer);
    expect(paths).not.toContain(inner);
  });

  it('respects maxDepth', () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'd', 'deep-repo');
    createFakeRepo(deep);

    const found = findGitRepos(tmpDir, 2);
    expect(found.map((r) => r.localPath)).not.toContain(deep);
  });

  it('populates remotes correctly', () => {
    const repoPath = path.join(tmpDir, 'my-repo');
    createFakeRepo(repoPath, [{ name: 'origin', url: 'git@github.com:user/my-repo.git' }]);

    const found = findGitRepos(tmpDir);
    expect(found).toHaveLength(1);
    expect(found[0].remotes).toHaveLength(1);
    expect(found[0].remotes[0].url).toBe('git@github.com:user/my-repo.git');
  });

  it('skips node_modules', () => {
    const nm = path.join(tmpDir, 'node_modules', 'some-pkg');
    createFakeRepo(nm);

    const found = findGitRepos(tmpDir);
    expect(found.map((r) => r.localPath)).not.toContain(nm);
  });

  it('skips hidden directories', () => {
    const hidden = path.join(tmpDir, '.hidden-dir', 'repo');
    createFakeRepo(hidden);

    const found = findGitRepos(tmpDir);
    expect(found.map((r) => r.localPath)).not.toContain(hidden);
  });

  it('calls onProgress callback with current directory', () => {
    const repoPath = path.join(tmpDir, 'my-repo');
    createFakeRepo(repoPath);

    const progressDirs: string[] = [];
    findGitRepos(tmpDir, 3, (dir) => progressDirs.push(dir));

    expect(progressDirs.length).toBeGreaterThan(0);
    expect(progressDirs).toContain(tmpDir);
  });

  it('handles unreadable directories gracefully', () => {
    // Create a directory structure but one subdir is unreadable
    const readableRepo = path.join(tmpDir, 'readable');
    createFakeRepo(readableRepo);

    // findGitRepos should not throw even if a dir is unreadable
    const found = findGitRepos(tmpDir);
    expect(found.map((r) => r.localPath)).toContain(readableRepo);
  });
});

// ── DB operations ─────────────────────────────────────────────────────────────

describe('Local discovery DB operations', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
  });

  it('addScanFolder / getScanFolders / removeScanFolder round-trip', () => {
    addScanFolder(db, '/home/user/repos');
    addScanFolder(db, '/home/user/work');

    const folders = getScanFolders(db);
    expect(folders.map((f) => f.path)).toContain(path.normalize('/home/user/repos'));
    expect(folders.map((f) => f.path)).toContain(path.normalize('/home/user/work'));

    removeScanFolder(db, path.normalize('/home/user/repos'));
    const after = getScanFolders(db);
    expect(after.map((f) => f.path)).not.toContain(path.normalize('/home/user/repos'));
  });

  it('addScanFolder ignores duplicates', () => {
    addScanFolder(db, '/home/user/repos');
    addScanFolder(db, '/home/user/repos');
    expect(getScanFolders(db)).toHaveLength(1);
  });

  it('getScanFolders returns repoCount for folders', () => {
    const folderPath = path.normalize('/home/user/repos');
    addScanFolder(db, folderPath);
    upsertLocalRepo(db, folderPath + path.sep + 'myrepo', 'myrepo', []);

    const folders = getScanFolders(db);
    expect(folders[0].repoCount).toBe(1);
  });

  it('upsertLocalRepo creates a repo and its remotes', () => {
    const id = upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);

    expect(id).toBeGreaterThan(0);

    const repos = listLocalRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('myrepo');
    expect(repos[0].remotes).toHaveLength(1);
    expect(repos[0].remotes[0].url).toBe('https://github.com/org/myrepo.git');
  });

  it('upsertLocalRepo updates an existing repo on conflict', () => {
    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);
    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo-renamed', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
      { name: 'fork', url: 'https://github.com/user/myrepo.git' },
    ]);

    const repos = listLocalRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('myrepo-renamed');
    expect(repos[0].remotes).toHaveLength(2);
  });

  it('upsertLocalRepo removes stale remotes', () => {
    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
      { name: 'old', url: 'https://github.com/org/old.git' },
    ]);

    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);

    const repos = listLocalRepos(db);
    expect(repos[0].remotes).toHaveLength(1);
    expect(repos[0].remotes[0].name).toBe('origin');
  });

  it('upsertLocalRepo with empty remotes deletes all remotes', () => {
    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);

    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', []);

    const repos = listLocalRepos(db);
    expect(repos[0].remotes).toHaveLength(0);
  });

  it('autoLinkLocalRepos matches remote URLs to github_repos', () => {
    db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/myrepo', 'myrepo']);
    const ghId = (db.exec("SELECT id FROM github_repos WHERE full_name='org/myrepo'")[0].values[0][0]) as number;

    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);

    autoLinkLocalRepos(db);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBe(ghId);
    expect(repos[0].remotes[0].githubRepoId).toBe(ghId);
  });

  it('autoLinkLocalRepos skips remotes already linked', () => {
    db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/myrepo', 'myrepo']);
    const ghId = (db.exec("SELECT id FROM github_repos WHERE full_name='org/myrepo'")[0].values[0][0]) as number;

    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);

    // Link it first
    autoLinkLocalRepos(db);
    // Run again — should not error or change anything
    autoLinkLocalRepos(db);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBe(ghId);
  });

  it('autoLinkLocalRepos skips non-GitHub remotes', () => {
    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://gitlab.com/org/myrepo.git' },
    ]);

    autoLinkLocalRepos(db);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBeNull();
  });

  it('autoLinkLocalRepos does nothing when github_repos has no match', () => {
    upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', [
      { name: 'origin', url: 'https://github.com/org/myrepo.git' },
    ]);

    autoLinkLocalRepos(db);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBeNull();
  });

  it('linkLocalRepo manually sets github_repo_id', () => {
    db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/other', 'other']);
    const ghId = (db.exec("SELECT id FROM github_repos WHERE full_name='org/other'")[0].values[0][0]) as number;

    const localId = upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', []);
    linkLocalRepo(db, localId, ghId);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBe(ghId);
  });

  it('linkLocalRepo can unlink by setting null', () => {
    db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/other', 'other']);
    const ghId = (db.exec("SELECT id FROM github_repos WHERE full_name='org/other'")[0].values[0][0]) as number;

    const localId = upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', []);
    linkLocalRepo(db, localId, ghId);
    linkLocalRepo(db, localId, null);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBeNull();
  });

  it('listLocalRepos uses basename when name is null', () => {
    // Directly insert a repo with null name to test fallback
    db.run("INSERT INTO local_repos (local_path, name) VALUES (?, ?)", ['/home/user/repos/fallback-repo', null]);

    const repos = listLocalRepos(db);
    expect(repos[0].name).toBe('fallback-repo');
  });

  it('listLocalReposForFolder filters by folder path', () => {
    upsertLocalRepo(db, '/home/user/repos/a', 'a', []);
    upsertLocalRepo(db, '/home/user/repos/b', 'b', []);
    upsertLocalRepo(db, '/home/user/work/c', 'c', []);

    const repos = listLocalReposForFolder(db, '/home/user/repos');
    const names = repos.map((r) => r.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).not.toContain('c');
  });

  it('listLocalReposForFolder matches exact folder path', () => {
    upsertLocalRepo(db, '/home/user/repos', 'repos', []);

    const repos = listLocalReposForFolder(db, '/home/user/repos');
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('repos');
  });
});

// ── runLocalDiscovery ─────────────────────────────────────────────────────────

describe('runLocalDiscovery', () => {
  let db: SqlJsDatabase;
  let tmpDir: string;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  it('scans configured folders and upserts discovered repos', async () => {
    const repoPath = path.join(tmpDir, 'my-repo');
    createFakeRepo(repoPath, [{ name: 'origin', url: 'https://github.com/org/my-repo.git' }]);
    addScanFolder(db, tmpDir);

    const result = await runLocalDiscovery(db);

    expect(result.phase).toBe('done');
    expect(result.foldersScanned).toBe(1);
    expect(result.reposFound).toBe(1);

    const repos = listLocalRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('my-repo');
  });

  it('calls onProgress during scanning', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    createFakeRepo(repoPath);
    addScanFolder(db, tmpDir);

    const progressCalls: { phase: string }[] = [];
    await runLocalDiscovery(db, (p) => progressCalls.push({ phase: p.phase }));

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1].phase).toBe('done');
  });

  it('returns zero counts when no scan folders configured', async () => {
    const result = await runLocalDiscovery(db);
    expect(result).toEqual({ phase: 'done', foldersScanned: 0, reposFound: 0 });
  });

  it('auto-links repos to github_repos after scanning', async () => {
    db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/my-repo', 'my-repo']);

    const repoPath = path.join(tmpDir, 'my-repo');
    createFakeRepo(repoPath, [{ name: 'origin', url: 'https://github.com/org/my-repo.git' }]);
    addScanFolder(db, tmpDir);

    await runLocalDiscovery(db);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).not.toBeNull();
  });
});
