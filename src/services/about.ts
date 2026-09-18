// ── About info (version, release date, repo link) ────────────────────────────
import { app, net } from 'electron';
import fs from 'fs';
import path from 'path';

export const REPO_URL = 'https://github.com/rajbos/Jarvis';
const RELEASE_TAG_API = 'https://api.github.com/repos/rajbos/Jarvis/releases/tags/';

export interface AboutInfo {
  /** What to show as "the version": the release version when installed, the git branch in dev. */
  displayVersion: string;
  /** The version baked into the build (package.json / installer). */
  appVersion: string;
  /** True for a development run (not an installed build). */
  isDev: boolean;
  /** Current git branch during development, null when unavailable. */
  branch: string | null;
  /** ISO timestamp of the matching GitHub release, null when unknown. */
  releasedAt: string | null;
  /** Release page for the running version, null when unknown. */
  releaseUrl: string | null;
  /** Link back to the open source repository. */
  repoUrl: string;
}

interface GitHubRelease {
  published_at?: string | null;
  created_at?: string | null;
  html_url?: string | null;
}

/** Cache release lookups per tag so opening the About popup twice does not re-fetch. */
const releaseCache = new Map<string, { releasedAt: string | null; releaseUrl: string | null }>();

/**
 * Read the checked-out branch straight from `.git/HEAD` — no git binary needed.
 * Returns the short commit sha for a detached HEAD, or null when there is no repo.
 */
export function readGitBranch(startDir: string): string | null {
  try {
    let gitDir = path.join(startDir, '.git');
    const stat = fs.statSync(gitDir);

    if (stat.isFile()) {
      // Worktrees and submodules store `gitdir: <path>` in a plain file.
      const pointer = fs.readFileSync(gitDir, 'utf8').trim();
      const match = pointer.match(/^gitdir:\s*(.+)$/);
      if (!match) return null;
      gitDir = path.resolve(startDir, match[1]);
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];
    return head ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

async function fetchReleaseInfo(tag: string): Promise<{ releasedAt: string | null; releaseUrl: string | null }> {
  const cached = releaseCache.get(tag);
  if (cached) return cached;

  let result: { releasedAt: string | null; releaseUrl: string | null } = { releasedAt: null, releaseUrl: null };
  try {
    const response = await net.fetch(`${RELEASE_TAG_API}${encodeURIComponent(tag)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Jarvis/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.ok) {
      const release = await response.json() as GitHubRelease;
      result = {
        releasedAt: release.published_at ?? release.created_at ?? null,
        releaseUrl: release.html_url ?? null,
      };
      releaseCache.set(tag, result);
    }
  } catch (error) {
    console.warn('[About] Release lookup failed:', error);
  }

  return result;
}

export async function getAboutInfo(): Promise<AboutInfo> {
  const appVersion = app.getVersion();
  const isDev = !app.isPackaged;

  if (isDev) {
    const branch = readGitBranch(app.getAppPath());
    return {
      displayVersion: branch ?? `${appVersion} (dev)`,
      appVersion,
      isDev: true,
      branch,
      releasedAt: null,
      releaseUrl: null,
      repoUrl: REPO_URL,
    };
  }

  const { releasedAt, releaseUrl } = await fetchReleaseInfo(`v${appVersion}`);
  return {
    displayVersion: appVersion,
    appVersion,
    isDev: false,
    branch: null,
    releasedAt,
    releaseUrl,
    repoUrl: REPO_URL,
  };
}

/** Test seam: drop the cached release lookups. */
export function clearReleaseCache(): void {
  releaseCache.clear();
}
