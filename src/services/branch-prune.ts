// ── Branch & worktree pruning ─────────────────────────────────────────────────
// Finds local branches (and the linked worktrees they are checked out in) that
// are safe to delete because their work is on GitHub already, and deletes them.
//
// Deleting a branch/worktree destroys user data, so every rule errs on the side
// of keeping things. A branch is only offered when ALL of these hold:
//   - it is not a default branch, not the main working tree's HEAD, not used by
//     an agent session;
//   - its worktree (if any) has no uncommitted files (untracked included), is
//     not locked and still exists;
//   - GitHub has a MERGED or CLOSED PR for the head branch name (so squash
//     merges work) and the local tip is that PR's head commit or an ancestor of
//     it — commits made after the PR was merged/closed keep the branch;
//   - or, without a PR: its upstream is gone AND every commit is still
//     reachable from a remote-tracking ref (nothing would be lost).
// A branch with an OPEN PR is never offered.

import { execFile } from 'node:child_process';
import path from 'node:path';
import type {
  PruneCandidate,
  PruneCandidates,
  PruneRequestItem,
  PruneResultItem,
  PruneSkipped,
} from '../plugins/types';
import { resolveGitContext } from './git-context';
import { logger } from './logger';
import { prLookupKey, type PrLookup, type PrLookupResult } from './pr-readiness';

// ── Facts (what git/GitHub told us) ───────────────────────────────────────────

export interface PrFact {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** Whether the local branch tip is the PR's head commit or an ancestor of it. */
  tipAtOrBeforeHead: boolean;
}

export interface BranchFact {
  name: string;
  sha: string;
  committedAt: string | null;
  upstreamGone: boolean;
  /** Commits reachable from the branch but from no remote-tracking ref. */
  unpushedCount: number;
  pr: PrFact | null;
  /** The PR lookup for this branch failed, so "no PR" is not known. */
  prLookupFailed: boolean;
}

export interface WorktreeFact {
  path: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  /** Directory is missing on disk. */
  prunable: boolean;
  /** Number of uncommitted entries, untracked files included; null when git could not tell. */
  dirtyFiles: number | null;
}

export interface PruneInput {
  branches: BranchFact[];
  worktrees: WorktreeFact[];
  /** Branch names an agent session uses (any repo — over-protecting is fine). */
  activeBranches: ReadonlySet<string>;
  /** Working directories of agent sessions; a worktree containing one is in use. */
  activePaths: readonly string[];
  /** Branch names that are never offered. */
  defaultBranches?: ReadonlySet<string>;
}

export const ALWAYS_KEPT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'develop', 'trunk']);

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function candidateId(branch: string, sha: string): string {
  return `${branch}@${sha}`;
}

/**
 * Pure: decide which branches/worktrees may be offered for pruning. Anything
 * that is not clearly safe lands in `skipped` with the reason.
 */
export function computePruneCandidates(input: PruneInput): { candidates: PruneCandidate[]; skipped: PruneSkipped[] } {
  const kept = input.defaultBranches ?? ALWAYS_KEPT_BRANCHES;
  const candidates: PruneCandidate[] = [];
  const skipped: PruneSkipped[] = [];

  for (const b of input.branches) {
    if (kept.has(b.name)) continue;
    const skip = (reason: string) => { skipped.push({ branch: b.name, reason }); };

    const wt = input.worktrees.find((w) => w.branch === b.name) ?? null;
    if (wt?.isMain) { skip('checked out in the main working tree'); continue; }
    if (input.activeBranches.has(b.name)) { skip('used by an agent session'); continue; }
    if (wt && input.activePaths.some((p) => isInside(p, wt.path))) { skip('its worktree is used by an agent session'); continue; }
    if (wt?.prunable) { skip('worktree folder is missing (run git worktree prune)'); continue; }
    if (wt?.locked) { skip('worktree is locked'); continue; }
    if (wt && wt.dirtyFiles === null) { skip('worktree status could not be read'); continue; }
    if (wt && wt.dirtyFiles !== null && wt.dirtyFiles > 0) { skip(`worktree has ${wt.dirtyFiles} uncommitted file${wt.dirtyFiles === 1 ? '' : 's'}`); continue; }

    const base = {
      id: candidateId(b.name, b.sha),
      branch: b.name,
      sha: b.sha,
      committedAt: b.committedAt,
      worktreePath: wt?.path ?? null,
    };

    if (b.pr) {
      if (b.pr.state === 'OPEN') { skip(`PR #${b.pr.number} is still open`); continue; }
      if (!b.pr.tipAtOrBeforeHead) { skip(`has commits that are not in PR #${b.pr.number}`); continue; }
      candidates.push({
        ...base,
        reason: b.pr.state === 'MERGED' ? 'pr-merged' : 'pr-closed',
        detail: `PR #${b.pr.number} ${b.pr.state === 'MERGED' ? 'merged' : 'closed'}`,
        prNumber: b.pr.number,
        prUrl: b.pr.url,
      });
      continue;
    }

    if (b.prLookupFailed) { skip('PR state could not be checked'); continue; }
    if (b.unpushedCount > 0) { skip(`${b.unpushedCount} unpushed commit${b.unpushedCount === 1 ? '' : 's'}`); continue; }
    if (b.upstreamGone) {
      candidates.push({ ...base, reason: 'upstream-gone', detail: 'upstream branch deleted, all commits are on a remote', prNumber: null, prUrl: null });
      continue;
    }
    skip('no PR');
  }

  candidates.sort((a, b) => a.branch.localeCompare(b.branch));
  skipped.sort((a, b) => a.branch.localeCompare(b.branch));
  return { candidates, skipped };
}

// ── git plumbing ──────────────────────────────────────────────────────────────

interface GitResult { code: number; stdout: string; stderr: string }

/** Run git with an argument array (never a shell), so branch names cannot inject anything. */
export function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
  return r.stdout;
}

interface RawBranch { name: string; sha: string; committedAt: string | null; upstreamGone: boolean }

export async function listLocalBranches(repoPath: string): Promise<RawBranch[]> {
  const out = await gitOrThrow(repoPath, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(upstream:track)',
    'refs/heads',
  ]);
  const branches: RawBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, sha, date, track] = line.split('\0');
    if (!ref?.startsWith('refs/heads/') || !sha) continue;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      sha,
      committedAt: date || null,
      upstreamGone: (track ?? '').trim() === '[gone]',
    });
  }
  return branches;
}

/** Parse `git worktree list --porcelain`. The first entry is the main working tree. */
export function parseWorktreeList(output: string): Omit<WorktreeFact, 'dirtyFiles'>[] {
  const result: Omit<WorktreeFact, 'dirtyFiles'>[] = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const first = lines.find((l) => l.startsWith('worktree '));
    if (!first) continue;
    const branchLine = lines.find((l) => l.startsWith('branch '));
    result.push({
      path: first.slice('worktree '.length),
      branch: branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null,
      isMain: result.length === 0,
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
      prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
    });
  }
  return result;
}

/** Count uncommitted entries (staged, modified, untracked). Throws if git cannot tell. */
async function countDirty(worktreePath: string): Promise<number> {
  const out = await gitOrThrow(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return out.split('\0').filter(Boolean).length;
}

async function listWorktrees(repoPath: string): Promise<WorktreeFact[]> {
  const parsed = parseWorktreeList(await gitOrThrow(repoPath, ['worktree', 'list', '--porcelain']));
  const facts: WorktreeFact[] = [];
  for (const wt of parsed) {
    // Unknown cleanliness counts as dirty: a failing `git status` must never make a worktree prunable.
    let dirty: number | null = null;
    if (!wt.prunable) {
      try { dirty = await countDirty(wt.path); } catch (err) {
        logger.warn('[BranchPrune] git status failed for worktree:', err instanceof Error ? err.message : String(err));
      }
    }
    facts.push({ ...wt, dirtyFiles: dirty });
  }
  return facts;
}

async function countUnpushed(repoPath: string, sha: string): Promise<number> {
  const r = await runGit(repoPath, ['rev-list', '--count', sha, '--not', '--remotes']);
  const n = Number.parseInt(r.stdout.trim(), 10);
  // Unknown → treat as "has unpushed work".
  return r.code === 0 && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  // Exit 0 = ancestor; 1 = not; anything else (e.g. object missing locally) = unknown → false.
  return (await runGit(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface PruneDeps {
  /** Resolve PR lookups on GitHub. Return null when no credentials are available. */
  fetchPrs(lookups: PrLookup[]): Promise<Map<string, PrLookupResult> | null>;
  /**
   * Branches and working directories used by agent sessions. Must throw when
   * they cannot be determined — pruning then fails instead of guessing.
   */
  activeUse(): Promise<{ branches: ReadonlySet<string>; paths: readonly string[] }>;
  /** GitHub `owner/repo` candidates of the checkout (push remote first). Defaults to reading git config. */
  repoCandidates?(repoPath: string): string[];
}

/** Gather facts from git and GitHub, then run the pure rules. */
export async function findPruneCandidates(repoPath: string, deps: PruneDeps): Promise<PruneCandidates> {
  const [branches, worktrees, active] = await Promise.all([
    listLocalBranches(repoPath),
    listWorktrees(repoPath),
    deps.activeUse(),
  ]);

  const repos = deps.repoCandidates ? deps.repoCandidates(repoPath) : (resolveGitContext(repoPath)?.repoCandidates ?? []);
  const owner = repos[0]?.split('/')[0];

  // Only look up branches that could possibly be offered.
  const lookupBranches = branches.filter((b) => !ALWAYS_KEPT_BRANCHES.has(b.name) && !active.branches.has(b.name));
  const lookups: PrLookup[] = [];
  for (const b of lookupBranches) {
    for (const repo of repos) lookups.push({ kind: 'branch', repoFullName: repo, branch: b.name, headOwner: owner });
  }
  const results = repos.length > 0 && lookups.length > 0 ? await deps.fetchPrs(lookups) : null;

  let prLookup: PruneCandidates['prLookup'] = repos.length === 0 ? 'no-github-remote' : results ? 'ok' : 'unavailable';
  const facts: BranchFact[] = [];
  for (const b of branches) {
    let pr: PrFact | null = null;
    let failed = repos.length === 0 || (repos.length > 0 && lookups.length > 0 && !results);
    if (results && lookupBranches.includes(b)) {
      type Raw = Extract<PrLookupResult, { ok: true }>['pr'];
      const found: NonNullable<Raw>[] = [];
      for (const repo of repos) {
        const res = results.get(prLookupKey({ kind: 'branch', repoFullName: repo, branch: b.name, headOwner: owner }));
        if (!res || !res.ok) { failed = true; continue; }
        if (res.pr) found.push(res.pr);
      }
      // A live PR anywhere wins; otherwise the first merged/closed one.
      const chosen = found.find((p) => p.state === 'OPEN') ?? found[0];
      if (chosen) {
        failed = false;
        pr = {
          number: chosen.number,
          url: chosen.url,
          state: chosen.state,
          tipAtOrBeforeHead: chosen.state === 'OPEN' ? false : await isAncestor(repoPath, b.sha, chosen.headRefOid),
        };
      } else if (failed && prLookup === 'ok') {
        prLookup = 'partial';
      }
    }
    facts.push({
      name: b.name,
      sha: b.sha,
      committedAt: b.committedAt,
      upstreamGone: b.upstreamGone,
      unpushedCount: await countUnpushed(repoPath, b.sha),
      pr,
      prLookupFailed: failed,
    });
  }

  const { candidates, skipped } = computePruneCandidates({
    branches: facts,
    worktrees,
    activeBranches: active.branches,
    activePaths: active.paths,
  });
  return { repoPath, candidates, skipped, prLookup, generatedAt: new Date().toISOString() };
}

/**
 * Delete the requested branches/worktrees. The request is only a selection:
 * candidates are recomputed from scratch and an item is acted on only when it is
 * still a candidate with the same tip commit. Each item is re-verified right
 * before it is deleted, and git itself refuses to remove a dirty or locked
 * worktree (no --force is ever used for worktrees).
 */
export async function pruneBranches(repoPath: string, items: PruneRequestItem[], deps: PruneDeps): Promise<PruneResultItem[]> {
  const fresh = await findPruneCandidates(repoPath, deps);
  const byId = new Map(fresh.candidates.map((c) => [c.id, c]));
  const results: PruneResultItem[] = [];

  for (const item of items) {
    const id = candidateId(item.branch, item.sha);
    const candidate = byId.get(id);
    if (!candidate) {
      results.push({ id, branch: item.branch, sha: item.sha, ok: false, error: 'No longer safe to prune — nothing was deleted', worktreeRemoved: false });
      continue;
    }
    results.push(await pruneOne(repoPath, candidate));
  }
  return results;
}

async function pruneOne(repoPath: string, c: PruneCandidate): Promise<PruneResultItem> {
  const fail = (error: string, worktreeRemoved = false): PruneResultItem =>
    ({ id: c.id, branch: c.branch, sha: c.sha, ok: false, error, worktreeRemoved });
  try {
    const ref = `refs/heads/${c.branch}`;
    const tip = (await runGit(repoPath, ['rev-parse', '--verify', '--quiet', ref])).stdout.trim();
    if (tip !== c.sha) return fail('Branch changed since it was listed — nothing was deleted');

    let worktreeRemoved = false;
    if (c.worktreePath) {
      if (await countDirty(c.worktreePath) > 0) return fail('Worktree has uncommitted files — nothing was deleted');
      // No --force: git refuses a dirty or locked worktree.
      const rm = await runGit(repoPath, ['worktree', 'remove', '--', c.worktreePath]);
      if (rm.code !== 0) return fail(`git refused to remove the worktree: ${rm.stderr.trim().slice(0, 200)}`);
      worktreeRemoved = true;
    }

    const del = await runGit(repoPath, ['branch', '-D', '--', c.branch]);
    if (del.code !== 0) return fail(`Could not delete the branch: ${del.stderr.trim().slice(0, 200)}`, worktreeRemoved);
    logger.info(`[BranchPrune] Deleted branch ${c.branch} (was ${c.sha.slice(0, 7)})${worktreeRemoved ? ' and its worktree' : ''}`);
    return { id: c.id, branch: c.branch, sha: c.sha, ok: true, worktreeRemoved };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
