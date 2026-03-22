import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getCurrentBranch,
  getBranchUpstream,
  countRemotes,
  checkRepoHealth,
  deriveWarnings,
} from '../../src/services/git-health';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-health-test-'));
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createFakeRepo(
  repoPath: string,
  opts: {
    branch?: string;
    remotes?: { name: string; url: string }[];
    branchTracking?: { branch: string; remote: string; merge: string };
  } = {},
): void {
  fs.mkdirSync(repoPath, { recursive: true });
  const gitDir = path.join(repoPath, '.git');
  fs.mkdirSync(gitDir);

  // HEAD
  const headContent = opts.branch
    ? `ref: refs/heads/${opts.branch}\n`
    : 'abc123def456\n'; // detached HEAD
  fs.writeFileSync(path.join(gitDir, 'HEAD'), headContent, 'utf-8');

  // config
  let configContent = '[core]\n\trepositoryformatversion = 0\n';
  for (const remote of opts.remotes ?? []) {
    configContent += `[remote "${remote.name}"]\n\turl = ${remote.url}\n\tfetch = +refs/heads/*:refs/remotes/${remote.name}/*\n`;
  }
  if (opts.branchTracking) {
    configContent += `[branch "${opts.branchTracking.branch}"]\n\tremote = ${opts.branchTracking.remote}\n\tmerge = ${opts.branchTracking.merge}\n`;
  }
  fs.writeFileSync(path.join(gitDir, 'config'), configContent, 'utf-8');
}

// ── getCurrentBranch ──────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { removeDir(tmpDir); });

  it('returns branch name when on a branch', () => {
    const repo = path.join(tmpDir, 'myrepo');
    createFakeRepo(repo, { branch: 'feature/cool-stuff' });
    expect(getCurrentBranch(repo)).toBe('feature/cool-stuff');
  });

  it('returns null for detached HEAD', () => {
    const repo = path.join(tmpDir, 'detached');
    createFakeRepo(repo, {}); // no branch
    expect(getCurrentBranch(repo)).toBeNull();
  });

  it('returns null for missing repo', () => {
    expect(getCurrentBranch(path.join(tmpDir, 'nonexistent'))).toBeNull();
  });
});

// ── getBranchUpstream ─────────────────────────────────────────────────────────

describe('getBranchUpstream', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { removeDir(tmpDir); });

  it('returns upstream info when branch has tracking config', () => {
    const repo = path.join(tmpDir, 'tracked');
    createFakeRepo(repo, {
      branch: 'main',
      remotes: [{ name: 'origin', url: 'https://github.com/owner/repo.git' }],
      branchTracking: { branch: 'main', remote: 'origin', merge: 'refs/heads/main' },
    });
    const info = getBranchUpstream(repo, 'main');
    expect(info.localBranch).toBe('main');
    expect(info.remoteName).toBe('origin');
    expect(info.remoteBranch).toBe('main');
  });

  it('returns nulls when branch has no tracking', () => {
    const repo = path.join(tmpDir, 'untracked');
    createFakeRepo(repo, {
      branch: 'feature-x',
      remotes: [{ name: 'origin', url: 'https://github.com/owner/repo.git' }],
    });
    const info = getBranchUpstream(repo, 'feature-x');
    expect(info.localBranch).toBe('feature-x');
    expect(info.remoteName).toBeNull();
    expect(info.remoteBranch).toBeNull();
  });
});

// ── countRemotes ──────────────────────────────────────────────────────────────

describe('countRemotes', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { removeDir(tmpDir); });

  it('returns 0 for repos with no remotes', () => {
    const repo = path.join(tmpDir, 'no-remote');
    createFakeRepo(repo, { branch: 'main', remotes: [] });
    expect(countRemotes(repo)).toBe(0);
  });

  it('counts multiple remotes', () => {
    const repo = path.join(tmpDir, 'multi');
    createFakeRepo(repo, {
      branch: 'main',
      remotes: [
        { name: 'origin', url: 'https://github.com/owner/repo.git' },
        { name: 'upstream', url: 'https://github.com/parent/repo.git' },
      ],
    });
    expect(countRemotes(repo)).toBe(2);
  });
});

// ── checkRepoHealth ───────────────────────────────────────────────────────────

describe('checkRepoHealth', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { removeDir(tmpDir); });

  it('reports healthy tracked repo correctly', () => {
    const repo = path.join(tmpDir, 'healthy');
    createFakeRepo(repo, {
      branch: 'main',
      remotes: [{ name: 'origin', url: 'https://github.com/owner/repo.git' }],
      branchTracking: { branch: 'main', remote: 'origin', merge: 'refs/heads/main' },
    });

    const status = checkRepoHealth(1, repo, 'healthy', 'owner/repo', 0, 0);
    expect(status.exists).toBe(true);
    expect(status.currentBranch).toBe('main');
    expect(status.hasUpstream).toBe(true);
    expect(status.upstreamRef).toBe('origin/main');
    expect(status.noRemote).toBe(false);
    expect(status.remoteCount).toBe(1);
  });

  it('detects repo with no remote', () => {
    const repo = path.join(tmpDir, 'no-remote');
    createFakeRepo(repo, { branch: 'main', remotes: [] });

    const status = checkRepoHealth(2, repo, 'no-remote', null, 0, 0);
    expect(status.noRemote).toBe(true);
    expect(status.remoteCount).toBe(0);
  });

  it('detects untracked branch', () => {
    const repo = path.join(tmpDir, 'untracked');
    createFakeRepo(repo, {
      branch: 'feat/wip',
      remotes: [{ name: 'origin', url: 'https://github.com/owner/repo.git' }],
    });

    const status = checkRepoHealth(3, repo, 'untracked', 'owner/repo', 0, 0);
    expect(status.currentBranch).toBe('feat/wip');
    expect(status.hasUpstream).toBe(false);
    expect(status.upstreamRef).toBeNull();
  });

  it('handles missing directory', () => {
    const status = checkRepoHealth(4, path.join(tmpDir, 'gone'), 'gone', null, 0, 0);
    expect(status.exists).toBe(false);
  });
});

// ── deriveWarnings ────────────────────────────────────────────────────────────

describe('deriveWarnings', () => {
  it('returns branch-no-upstream warning for untracked branch', () => {
    const warnings = deriveWarnings({
      localRepoId: 1,
      localPath: '/tmp/repo',
      repoName: 'repo',
      currentBranch: 'feature',
      hasUpstream: false,
      upstreamRef: null,
      noRemote: false,
      remoteCount: 1,
      notificationCount: 0,
      linkedGithubRepo: null,
      failedWorkflowRuns: 0,
      exists: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('branch-no-upstream');
  });

  it('returns no-remote warning', () => {
    const warnings = deriveWarnings({
      localRepoId: 1,
      localPath: '/tmp/repo',
      repoName: 'repo',
      currentBranch: 'main',
      hasUpstream: false,
      upstreamRef: null,
      noRemote: true,
      remoteCount: 0,
      notificationCount: 0,
      linkedGithubRepo: null,
      failedWorkflowRuns: 0,
      exists: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('no-remote');
  });

  it('prefers no-remote over branch-no-upstream', () => {
    const warnings = deriveWarnings({
      localRepoId: 1,
      localPath: '/tmp/repo',
      repoName: 'repo',
      currentBranch: 'main',
      hasUpstream: false,
      upstreamRef: null,
      noRemote: true,
      remoteCount: 0,
      notificationCount: 0,
      linkedGithubRepo: null,
      failedWorkflowRuns: 0,
      exists: true,
    });
    expect(warnings.map((w) => w.kind)).not.toContain('branch-no-upstream');
    expect(warnings.map((w) => w.kind)).toContain('no-remote');
  });

  it('returns notifications and failed workflow warnings', () => {
    const warnings = deriveWarnings({
      localRepoId: 1,
      localPath: '/tmp/repo',
      repoName: 'repo',
      currentBranch: 'main',
      hasUpstream: true,
      upstreamRef: 'origin/main',
      noRemote: false,
      remoteCount: 1,
      notificationCount: 3,
      linkedGithubRepo: 'owner/repo',
      failedWorkflowRuns: 2,
      exists: true,
    });
    const kinds = warnings.map((w) => w.kind);
    expect(kinds).toContain('has-notifications');
    expect(kinds).toContain('failed-workflows');
  });

  it('returns empty for healthy repo', () => {
    const warnings = deriveWarnings({
      localRepoId: 1,
      localPath: '/tmp/repo',
      repoName: 'repo',
      currentBranch: 'main',
      hasUpstream: true,
      upstreamRef: 'origin/main',
      noRemote: false,
      remoteCount: 1,
      notificationCount: 0,
      linkedGithubRepo: 'owner/repo',
      failedWorkflowRuns: 0,
      exists: true,
    });
    expect(warnings).toHaveLength(0);
  });

  it('skips warnings for non-existing repos', () => {
    const warnings = deriveWarnings({
      localRepoId: 1,
      localPath: '/tmp/gone',
      repoName: 'gone',
      currentBranch: null,
      hasUpstream: false,
      upstreamRef: null,
      noRemote: true,
      remoteCount: 0,
      notificationCount: 5,
      linkedGithubRepo: null,
      failedWorkflowRuns: 0,
      exists: false,
    });
    // non-existing repos don't produce branch/remote warnings
    // but DO produce notification warnings
    expect(warnings).toHaveLength(0);
  });
});
