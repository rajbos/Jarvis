import fs from 'fs';
import path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BranchUpstreamInfo {
  localBranch: string;
  remoteName: string | null;   // e.g. "origin"
  remoteBranch: string | null; // e.g. "main"
}

export interface RepoHealthStatus {
  localRepoId: number;
  localPath: string;
  repoName: string;
  /** Current HEAD branch (null if detached) */
  currentBranch: string | null;
  /** Whether the current branch has an upstream configured */
  hasUpstream: boolean;
  /** Upstream tracking ref, e.g. "origin/my-feature" */
  upstreamRef: string | null;
  /** true if the repo has no remotes at all */
  noRemote: boolean;
  /** Number of remotes configured */
  remoteCount: number;
  /** Number of GitHub notifications for the linked repo */
  notificationCount: number;
  /** Linked GitHub repo full_name (e.g. "owner/repo") */
  linkedGithubRepo: string | null;
  /** Number of recent failed workflow runs (last 7 days) */
  failedWorkflowRuns: number;
  /** Whether the repo directory still exists on disk */
  exists: boolean;
}

export type HealthWarningKind =
  | 'branch-no-upstream'
  | 'no-remote'
  | 'has-notifications'
  | 'failed-workflows';

export interface HealthWarning {
  kind: HealthWarningKind;
  message: string;
}

export interface DashboardSummary {
  repos: RepoHealthStatus[];
  warnings: { repoId: number; warnings: HealthWarning[] }[];
  totalRepos: number;
  reposWithWarnings: number;
  totalNotifications: number;
  totalFailedRuns: number;
  generatedAt: string;
}

// ── Git config parsing (branch tracking) ──────────────────────────────────────

/**
 * Read HEAD to determine the current branch.
 * Returns null if HEAD is detached.
 */
export function getCurrentBranch(repoPath: string): string | null {
  const headPath = path.join(repoPath, '.git', 'HEAD');
  try {
    const content = fs.readFileSync(headPath, 'utf-8').trim();
    const match = content.match(/^ref: refs\/heads\/(.+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Parse `.git/config` to find the upstream (tracking) configuration for
 * a given branch. Returns { remoteName, remoteBranch } or nulls.
 */
export function getBranchUpstream(repoPath: string, branchName: string): BranchUpstreamInfo {
  const result: BranchUpstreamInfo = {
    localBranch: branchName,
    remoteName: null,
    remoteBranch: null,
  };

  const configPath = path.join(repoPath, '.git', 'config');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Look for [branch "branchName"] section
    const branchSectionRe = new RegExp(
      `\\[branch\\s+"${escapeRegExp(branchName)}"\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    );
    const sectionMatch = content.match(branchSectionRe);
    if (!sectionMatch) return result;

    const section = sectionMatch[1];
    const remoteMatch = section.match(/^\s*remote\s*=\s*(.+)$/m);
    const mergeMatch = section.match(/^\s*merge\s*=\s*(.+)$/m);

    if (remoteMatch) {
      result.remoteName = remoteMatch[1].trim();
    }
    if (mergeMatch) {
      const mergeRef = mergeMatch[1].trim();
      // merge is typically "refs/heads/branchName"
      result.remoteBranch = mergeRef.replace(/^refs\/heads\//, '');
    }
  } catch {
    // Can't read config — leave nulls
  }

  return result;
}

/**
 * Count remotes configured in `.git/config`.
 */
export function countRemotes(repoPath: string): number {
  const configPath = path.join(repoPath, '.git', 'config');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const matches = content.match(/\[remote\s+"[^"]+"\]/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Health check orchestration ────────────────────────────────────────────────

export function checkRepoHealth(
  localRepoId: number,
  localPath: string,
  repoName: string,
  linkedGithubRepo: string | null,
  notificationCount: number,
  failedWorkflowRuns: number,
): RepoHealthStatus {
  const exists = fs.existsSync(path.join(localPath, '.git'));

  if (!exists) {
    return {
      localRepoId,
      localPath,
      repoName,
      currentBranch: null,
      hasUpstream: false,
      upstreamRef: null,
      noRemote: true,
      remoteCount: 0,
      notificationCount,
      linkedGithubRepo,
      failedWorkflowRuns,
      exists: false,
    };
  }

  const currentBranch = getCurrentBranch(localPath);
  const remoteCount = countRemotes(localPath);
  let hasUpstream = false;
  let upstreamRef: string | null = null;

  if (currentBranch) {
    const upstream = getBranchUpstream(localPath, currentBranch);
    if (upstream.remoteName && upstream.remoteBranch) {
      hasUpstream = true;
      upstreamRef = `${upstream.remoteName}/${upstream.remoteBranch}`;
    }
  }

  return {
    localRepoId,
    localPath,
    repoName,
    currentBranch,
    hasUpstream,
    upstreamRef,
    noRemote: remoteCount === 0,
    remoteCount,
    notificationCount,
    linkedGithubRepo,
    failedWorkflowRuns,
    exists,
  };
}

/**
 * Derive warnings from a repo health status.
 */
export function deriveWarnings(status: RepoHealthStatus): HealthWarning[] {
  const warnings: HealthWarning[] = [];

  if (!status.exists) {
    // Don't produce branch/remote warnings for missing repos
    return warnings;
  }

  if (status.noRemote) {
    warnings.push({
      kind: 'no-remote',
      message: `No remote configured — local-only repository`,
    });
  } else if (status.currentBranch && !status.hasUpstream) {
    warnings.push({
      kind: 'branch-no-upstream',
      message: `Branch "${status.currentBranch}" has no upstream — unfinished/unpushed work?`,
    });
  }

  if (status.notificationCount > 0) {
    warnings.push({
      kind: 'has-notifications',
      message: `${status.notificationCount} unread notification${status.notificationCount > 1 ? 's' : ''}`,
    });
  }

  if (status.failedWorkflowRuns > 0) {
    warnings.push({
      kind: 'failed-workflows',
      message: `${status.failedWorkflowRuns} failed workflow run${status.failedWorkflowRuns > 1 ? 's' : ''} in the last 7 days`,
    });
  }

  return warnings;
}
