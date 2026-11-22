import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computePruneCandidates,
  findPruneCandidates,
  parseWorktreeList,
  pruneBranches,
  type BranchFact,
  type PruneDeps,
  type PruneInput,
  type WorktreeFact,
} from '../../src/services/branch-prune';
import type { PrLookup, PrLookupResult } from '../../src/services/pr-readiness';
import { prLookupKey } from '../../src/services/pr-readiness';

const SHA = 'a'.repeat(40);

function branch(over: Partial<BranchFact> = {}): BranchFact {
  return { name: 'feature/x', sha: SHA, committedAt: null, upstreamGone: false, unpushedCount: 0, pr: null, prLookupFailed: false, ...over };
}
function worktree(over: Partial<WorktreeFact> = {}): WorktreeFact {
  return { path: '/repo/wt', branch: 'feature/x', isMain: false, locked: false, prunable: false, dirtyFiles: 0, ...over };
}
function compute(over: Partial<PruneInput>) {
  return computePruneCandidates({ branches: [], worktrees: [], activeBranches: new Set(), activePaths: [], ...over });
}
const merged = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED' as const, tipAtOrBeforeHead: true };

describe('computePruneCandidates', () => {
  it('offers a branch whose PR is merged, with its idle worktree', () => {
    const { candidates } = compute({ branches: [branch({ pr: merged })], worktrees: [worktree()] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ branch: 'feature/x', reason: 'pr-merged', prNumber: 7, worktreePath: '/repo/wt' });
  });

  it('offers a closed PR branch as pr-closed', () => {
    const { candidates } = compute({ branches: [branch({ pr: { ...merged, state: 'CLOSED' } })] });
    expect(candidates[0].reason).toBe('pr-closed');
  });

  it('never offers a branch with an open PR', () => {
    const { candidates, skipped } = compute({ branches: [branch({ pr: { ...merged, state: 'OPEN', tipAtOrBeforeHead: false } })] });
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toMatch(/still open/);
  });

  it('keeps a branch whose PR closed before its latest commits', () => {
    const { candidates, skipped } = compute({ branches: [branch({ pr: { ...merged, state: 'CLOSED', tipAtOrBeforeHead: false } })] });
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toMatch(/not in PR #7/);
  });

  it('never offers a branch without a PR', () => {
    const { candidates, skipped } = compute({ branches: [branch()] });
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toBe('no PR');
  });

  it('keeps unpushed work without a PR even when the upstream is gone', () => {
    const { candidates } = compute({ branches: [branch({ upstreamGone: true, unpushedCount: 2 })] });
    expect(candidates).toEqual([]);
  });

  it('offers an upstream-gone branch whose commits are all on a remote', () => {
    const { candidates } = compute({ branches: [branch({ upstreamGone: true })] });
    expect(candidates[0].reason).toBe('upstream-gone');
  });

  it('does not offer an upstream-gone branch when the PR lookup failed', () => {
    const { candidates } = compute({ branches: [branch({ upstreamGone: true, prLookupFailed: true })] });
    expect(candidates).toEqual([]);
  });

  it.each([
    ['uncommitted files', { dirtyFiles: 1 }],
    ['unknown status', { dirtyFiles: null }],
    ['locked', { locked: true }],
    ['missing folder', { prunable: true }],
  ])('keeps a branch whose worktree is %s', (_name, wt) => {
    const { candidates } = compute({ branches: [branch({ pr: merged })], worktrees: [worktree(wt)] });
    expect(candidates).toEqual([]);
  });

  it('never offers the main working tree branch, default branches or agent-used branches', () => {
    const main = compute({ branches: [branch({ pr: merged })], worktrees: [worktree({ isMain: true })] });
    expect(main.candidates).toEqual([]);
    const def = compute({ branches: [branch({ name: 'main', pr: merged })] });
    expect(def.candidates).toEqual([]);
    const active = compute({ branches: [branch({ pr: merged })], activeBranches: new Set(['feature/x']) });
    expect(active.candidates).toEqual([]);
  });

  it('never offers a worktree an agent session runs in', () => {
    const { candidates } = compute({ branches: [branch({ pr: merged })], worktrees: [worktree({ path: '/repo/wt' })], activePaths: ['/repo/wt/src'] });
    expect(candidates).toEqual([]);
  });

  it('never offers a detached worktree (no branch, no PR)', () => {
    const { candidates } = compute({ worktrees: [worktree({ branch: null })] });
    expect(candidates).toEqual([]);
  });
});

describe('parseWorktreeList', () => {
  it('parses main, linked, locked, prunable and detached entries', () => {
    const out = [
      'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /r-wt', 'HEAD bbb', 'branch refs/heads/feat/a', 'locked reason', '',
      'worktree /gone', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
    ].join('\n');
    const wts = parseWorktreeList(out);
    expect(wts).toEqual([
      { path: '/r', branch: 'main', isMain: true, locked: false, prunable: false },
      { path: '/r-wt', branch: 'feat/a', isMain: false, locked: true, prunable: false },
      { path: '/gone', branch: null, isMain: false, locked: false, prunable: true },
    ]);
  });
});

// ── Against real git repositories ─────────────────────────────────────────────

const EMPTY_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prune-cfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

describe('against real git repos', () => {
  // Spawning git is slow on Windows; these tests make dozens of calls.
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let tmp: string;
  let repo: string;
  let origin: string;
  let prs: Record<string, { state: 'OPEN' | 'CLOSED' | 'MERGED'; head?: string }>;
  let active: { branches: Set<string>; paths: string[] };

  function deps(): PruneDeps {
    return {
      repoCandidates: () => ['acme/rocket'],
      activeUse: async () => active,
      fetchPrs: async (lookups: PrLookup[]) => {
        const map = new Map<string, PrLookupResult>();
        for (const l of lookups) {
          if (l.kind !== 'branch') continue;
          const p = prs[l.branch];
          map.set(prLookupKey(l), p
            ? { ok: true, pr: { number: 1, url: 'https://github.com/acme/rocket/pull/1', state: p.state, headRefOid: p.head ?? git(repo, 'rev-parse', `refs/heads/${l.branch}`) } as never }
            : { ok: true, pr: null });
        }
        return map;
      },
    };
  }

  /** Branch with `n` commits off main, pushed to origin. */
  function makeBranch(name: string, push = true): string {
    git(repo, 'checkout', '-q', '-b', name, 'main');
    fs.writeFileSync(path.join(repo, `${name.replace(/\//g, '_')}.txt`), name);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', name);
    if (push) git(repo, 'push', '-q', '-u', 'origin', name);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    return sha;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prune-'));
    origin = path.join(tmp, 'origin.git');
    repo = path.join(tmp, 'repo');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    prs = {};
    active = { branches: new Set(), paths: [] };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('offers a squash-merged branch and a worktree, prunes both, and keeps everything unsafe', async () => {
    makeBranch('merged/a');
    makeBranch('merged/b');
    makeBranch('open/c');
    makeBranch('nopr/d');
    makeBranch('closed/old');
    const unpushedTip = makeBranch('merged/e');
    prs['merged/a'] = { state: 'MERGED' };
    prs['merged/b'] = { state: 'MERGED' };
    prs['open/c'] = { state: 'OPEN' };
    prs['merged/e'] = { state: 'MERGED' };

    // merged/b is checked out in a clean worktree
    const wtB = path.join(tmp, 'wt-b');
    git(repo, 'worktree', 'add', '-q', wtB, 'merged/b');
    // closed/old: PR closed at the old head, then the branch gained a local commit
    const oldHead = git(repo, 'rev-parse', 'refs/heads/closed/old');
    prs['closed/old'] = { state: 'CLOSED', head: oldHead };
    git(repo, 'checkout', '-q', 'closed/old');
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'later');
    git(repo, 'checkout', '-q', 'main');
    // merged/e gets a local commit after the PR head
    git(repo, 'checkout', '-q', 'merged/e');
    fs.writeFileSync(path.join(repo, 'e2.txt'), 'e2');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'e2');
    git(repo, 'checkout', '-q', 'main');
    prs['merged/e'] = { state: 'MERGED', head: unpushedTip };

    const res = await findPruneCandidates(repo, deps());
    expect(res.prLookup).toBe('ok');
    expect(res.candidates.map((c) => c.branch)).toEqual(['merged/a', 'merged/b']);
    const b = res.candidates.find((c) => c.branch === 'merged/b')!;
    // Windows runners hand out 8.3 short temp paths; compare the real paths.
    expect(fs.realpathSync.native(b.worktreePath!).toLowerCase()).toBe(fs.realpathSync.native(wtB).toLowerCase());
    const skipped = Object.fromEntries(res.skipped.map((s) => [s.branch, s.reason]));
    expect(skipped['open/c']).toMatch(/still open/);
    expect(skipped['nopr/d']).toBe('no PR');
    expect(skipped['closed/old']).toMatch(/not in PR/);
    expect(skipped['merged/e']).toMatch(/not in PR/);

    const results = await pruneBranches(repo, res.candidates.map((c) => ({ branch: c.branch, sha: c.sha })), deps());
    expect(results.every((r) => r.ok)).toBe(true);
    const remaining = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
    expect(remaining).not.toContain('merged/a');
    expect(remaining).not.toContain('merged/b');
    expect(remaining).toEqual(expect.arrayContaining(['main', 'open/c', 'nopr/d', 'closed/old', 'merged/e']));
    expect(fs.existsSync(wtB)).toBe(false);
  });

  it('never offers or removes a worktree with an untracked or modified file', async () => {
    makeBranch('merged/dirty');
    prs['merged/dirty'] = { state: 'MERGED' };
    const wt = path.join(tmp, 'wt-dirty');
    git(repo, 'worktree', 'add', '-q', wt, 'merged/dirty');
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'precious');

    const res = await findPruneCandidates(repo, deps());
    expect(res.candidates).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/uncommitted/);
    expect(fs.existsSync(path.join(wt, 'scratch.txt'))).toBe(true);
  });

  it('refuses to prune an item that is no longer a candidate, or whose branch moved', async () => {
    const sha = makeBranch('merged/a');
    prs['merged/a'] = { state: 'MERGED' };
    const stale = await pruneBranches(repo, [{ branch: 'merged/a', sha: 'b'.repeat(40) }, { branch: 'main', sha: git(repo, 'rev-parse', 'main') }], deps());
    expect(stale.every((r) => !r.ok)).toBe(true);
    expect(git(repo, 'for-each-ref', 'refs/heads/merged/a')).toContain(sha);
  });

  it('protects branches used by an agent session', async () => {
    makeBranch('merged/a');
    prs['merged/a'] = { state: 'MERGED' };
    active.branches.add('merged/a');
    expect((await findPruneCandidates(repo, deps())).candidates).toEqual([]);
  });

  it('fails closed when agent sessions cannot be determined', async () => {
    const sha = makeBranch('merged/a');
    prs['merged/a'] = { state: 'MERGED' };
    const failing: PruneDeps = { ...deps(), activeUse: async () => { throw new Error('sessions unreadable'); } };

    await expect(findPruneCandidates(repo, failing)).rejects.toThrow('sessions unreadable');
    await expect(pruneBranches(repo, [{ branch: 'merged/a', sha }], failing)).rejects.toThrow('sessions unreadable');
    expect(git(repo, 'for-each-ref', 'refs/heads/merged/a')).toContain(sha);
  });

  it('offers a gone-upstream branch only when all commits are on a remote', async () => {
    makeBranch('gone/pushed');
    git(repo, 'push', '-q', 'origin', '--delete', 'gone/pushed');
    makeBranch('gone/local');
    // Simulate a squash-merge deleting the remote branch while a commit was never pushed
    git(repo, 'checkout', '-q', 'gone/local');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'unpushed');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'push', '-q', 'origin', '--delete', 'gone/local');

    const res = await findPruneCandidates(repo, deps());
    // gone/pushed's commit is no longer on any remote ref either (the remote ref was deleted),
    // so neither is offered — deleting would lose commits that exist nowhere else.
    expect(res.candidates).toEqual([]);
    expect(res.skipped.map((s) => s.branch)).toEqual(expect.arrayContaining(['gone/local', 'gone/pushed']));
  });

  it('offers a gone-upstream branch that was merged by fast-forward into main', async () => {
    makeBranch('gone/ff');
    git(repo, 'merge', '-q', '--ff-only', 'gone/ff');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'push', '-q', 'origin', '--delete', 'gone/ff');
    const res = await findPruneCandidates(repo, deps());
    expect(res.candidates.map((c) => [c.branch, c.reason])).toEqual([['gone/ff', 'upstream-gone']]);
  });

  it('degrades to upstream-gone only when no credentials are available', async () => {
    makeBranch('merged/a');
    prs['merged/a'] = { state: 'MERGED' };
    const res = await findPruneCandidates(repo, { ...deps(), fetchPrs: async () => null });
    expect(res.prLookup).toBe('unavailable');
    expect(res.candidates).toEqual([]);
  });
});
