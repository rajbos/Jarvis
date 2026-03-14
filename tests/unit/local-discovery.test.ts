/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

// ── normalizeGitHubUrl ────────────────────────────────────────────────────────

describe('normalizeGitHubUrl', () => {
  it('handles HTTPS URLs with .git suffix', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('handles HTTPS URLs without .git suffix', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('handles SSH URLs', () => {
    expect(normalizeGitHubUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('handles SSH URLs without .git', () => {
    expect(normalizeGitHubUrl('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('returns null for non-GitHub remotes', () => {
    expect(normalizeGitHubUrl('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(normalizeGitHubUrl('git@bitbucket.org:owner/repo.git')).toBeNull();
    expect(normalizeGitHubUrl('')).toBeNull();
  });
});

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

  it('linkLocalRepo manually sets github_repo_id', () => {
    db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/other', 'other']);
    const ghId = (db.exec("SELECT id FROM github_repos WHERE full_name='org/other'")[0].values[0][0]) as number;

    const localId = upsertLocalRepo(db, '/home/user/repos/myrepo', 'myrepo', []);
    linkLocalRepo(db, localId, ghId);

    const repos = listLocalRepos(db);
    expect(repos[0].linkedGithubRepoId).toBe(ghId);
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
});
