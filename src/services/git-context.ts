// ── Git context resolution ────────────────────────────────────────────────────
// Maps an arbitrary working directory (e.g. the cwd of a running agent session)
// to its repository root, current branch and GitHub remotes — by reading the
// .git metadata directly, so no git binary is required. Handles linked
// worktrees, where `.git` is a file pointing at `<common>/worktrees/<name>`.

import fs from 'fs';
import path from 'path';
import { normalizeGitHubUrl } from './local-discovery';

export interface GitContext {
  repoRoot: string;
  /** Local branch name, or null when HEAD is detached. */
  branch: string | null;
  /** Branch name on the remote this branch tracks (usually equal to `branch`). */
  upstreamBranch: string | null;
  /** Remote the branch tracks, when configured. */
  upstreamRemote: string | null;
  /** GitHub `owner/repo` of the remote the branch pushes to (tracking remote, else origin). */
  repoFullName: string | null;
  /**
   * All GitHub repos this checkout knows about, in lookup order: the push
   * remote first, then `upstream`, then any others. A PR for a fork branch
   * usually lives in the `upstream` repo.
   */
  repoCandidates: string[];
}

interface GitConfigSection {
  section: string;
  subsection: string | null;
  values: Record<string, string>;
}

/** Minimal git-config parser: sections, quoted subsections and key = value pairs. */
export function parseGitConfig(content: string): GitConfigSection[] {
  const sections: GitConfigSection[] = [];
  let current: GitConfigSection | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/);
    if (header) {
      current = { section: header[1].toLowerCase(), subsection: header[2] ?? null, values: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9-]+)\s*=\s*(.*)$/);
    if (kv) current.values[kv[1].toLowerCase()] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return sections;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Walk up from `startDir` to the nearest directory containing a `.git` entry. */
function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Resolve the per-worktree git dir and the shared (common) git dir. */
function resolveGitDirs(repoRoot: string): { gitDir: string; commonDir: string } | null {
  const dotGit = path.join(repoRoot, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }

  let gitDir = dotGit;
  if (stat.isFile()) {
    const pointer = readFileSafe(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return null;
    gitDir = path.resolve(repoRoot, pointer);
  }

  let commonDir = gitDir;
  const common = readFileSafe(path.join(gitDir, 'commondir'))?.trim();
  if (common) commonDir = path.resolve(gitDir, common);

  return { gitDir, commonDir };
}

export function resolveGitContext(cwd: string): GitContext | null {
  if (!cwd) return null;
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;
  const dirs = resolveGitDirs(repoRoot);
  if (!dirs) return null;

  const head = readFileSafe(path.join(dirs.gitDir, 'HEAD'))?.trim() ?? '';
  const branch = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? null;

  const config = parseGitConfig(readFileSafe(path.join(dirs.commonDir, 'config')) ?? '');
  const remotes = new Map<string, string>();
  for (const s of config) {
    if (s.section === 'remote' && s.subsection && s.values.url) {
      const repo = normalizeGitHubUrl(s.values.url);
      if (repo) remotes.set(s.subsection, repo);
    }
  }

  const branchCfg = branch
    ? config.find((s) => s.section === 'branch' && s.subsection === branch)
    : undefined;
  const upstreamRemote = branchCfg?.values.pushremote ?? branchCfg?.values.remote ?? null;
  const upstreamBranch = branchCfg?.values.merge?.replace(/^refs\/heads\//, '') ?? null;

  const order = [upstreamRemote, 'origin', 'upstream', ...remotes.keys()];
  const repoCandidates: string[] = [];
  for (const name of order) {
    const repo = name ? remotes.get(name) : undefined;
    if (repo && !repoCandidates.some((r) => r.toLowerCase() === repo.toLowerCase())) repoCandidates.push(repo);
  }

  return {
    repoRoot,
    branch,
    upstreamBranch,
    upstreamRemote,
    repoFullName: repoCandidates[0] ?? null,
    repoCandidates,
  };
}
