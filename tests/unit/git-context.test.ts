import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGitConfig, resolveGitContext } from '../../src/services/git-context';

describe('parseGitConfig', () => {
  it('parses sections, quoted subsections and values', () => {
    const sections = parseGitConfig([
      '[core]',
      '\tbare = false',
      '# comment',
      '[remote "origin"]',
      '\turl = https://github.com/me/repo.git',
      '[branch "feature/x"]',
      '\tremote = origin',
      '\tmerge = refs/heads/feature/x',
    ].join('\n'));
    expect(sections).toEqual([
      { section: 'core', subsection: null, values: { bare: 'false' } },
      { section: 'remote', subsection: 'origin', values: { url: 'https://github.com/me/repo.git' } },
      { section: 'branch', subsection: 'feature/x', values: { remote: 'origin', merge: 'refs/heads/feature/x' } },
    ]);
  });
});

describe('resolveGitContext', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-git-context-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const CONFIG = [
    '[remote "origin"]',
    '\turl = git@github.com:me/repo.git',
    '[remote "upstream"]',
    '\turl = https://github.com/org/repo',
    '[branch "fix-bug"]',
    '\tremote = origin',
    '\tmerge = refs/heads/fix-bug-remote',
  ].join('\n');

  it('resolves branch, upstream branch and repo candidates from a normal checkout subfolder', () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/fix-bug\n');
    fs.writeFileSync(path.join(repo, '.git', 'config'), CONFIG);

    const ctx = resolveGitContext(path.join(repo, 'src', 'deep'));
    expect(ctx).toEqual({
      repoRoot: repo,
      branch: 'fix-bug',
      upstreamBranch: 'fix-bug-remote',
      upstreamRemote: 'origin',
      repoFullName: 'me/repo',
      repoCandidates: ['me/repo', 'org/repo'],
    });
  });

  it('follows a linked worktree .git file to its gitdir and common config', () => {
    const main = path.join(root, 'main');
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'config'), CONFIG);
    fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
    fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');

    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    const ctx = resolveGitContext(wt);
    expect(ctx?.repoRoot).toBe(wt);
    expect(ctx?.branch).toBe('wt-branch');
    expect(ctx?.upstreamBranch).toBeNull();
    expect(ctx?.repoFullName).toBe('me/repo');
  });

  it('returns a null branch for a detached HEAD', () => {
    const repo = path.join(root, 'detached');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    fs.writeFileSync(path.join(repo, '.git', 'config'), '');
    const ctx = resolveGitContext(repo);
    expect(ctx?.branch).toBeNull();
    expect(ctx?.repoCandidates).toEqual([]);
  });

  it('returns null outside a git repository', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    // The temp dir itself is not inside a repo on CI/dev machines; guard anyway.
    const ctx = resolveGitContext(plain);
    if (ctx) expect(ctx.repoRoot).not.toBe(plain);
    expect(resolveGitContext('')).toBeNull();
  });
});
