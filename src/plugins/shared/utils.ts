// ── Shared renderer utility helpers ──────────────────────────────────────────

/** Returns a human-readable relative time label (e.g. "3h ago", "2d ago"). */
export function relativeAge(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/** Returns a short description of a notification reason/type combination. */
export function notifDescription(type: string, reason: string): string {
  if (reason === 'assign') return type === 'PullRequest' ? 'PR assigned to you' : 'Issue assigned to you';
  if (reason === 'review_requested') return 'PR review requested';
  if (reason === 'mention') return `@mentioned in ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'team_mention') return `Team @mentioned in ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'author') return `Your ${type === 'PullRequest' ? 'PR' : type.toLowerCase()} has activity`;
  if (reason === 'comment') return `Comment on ${type === 'PullRequest' ? 'PR' : type.toLowerCase()}`;
  if (reason === 'subscribed') return `Watched ${type === 'PullRequest' ? 'PR' : type.toLowerCase()} updated`;
  if (reason === 'state_change') return `${type === 'PullRequest' ? 'PR' : type} state changed`;
  if (reason === 'ci_activity') return 'CI activity';
  if (reason === 'security_alert') return '\u26A0\uFE0F Security alert';
  return `${type} \u2014 ${reason}`;
}

/** Returns true if the notification reason involves the user directly. */
export function isDirect(reason: string): boolean {
  return ['assign', 'review_requested', 'mention', 'team_mention', 'author', 'security_alert'].includes(reason);
}

// ── Local repo path helpers ───────────────────────────────────────────────────

import type { LocalRepo } from '../types';

// ── Deduplication ─────────────────────────────────────────────────────────────

export interface DeduplicatedLocalRepo {
  /** The canonical repo (most recently scanned clone, then most recently discovered, then path order). */
  primaryRepo: LocalRepo;
  /** All local paths sharing the same remote, primary first. */
  allLocalPaths: string[];
  /** Normalized GitHub full_name for the primary remote, or null. */
  githubFullName: string | null;
  /** True when 2 or more local clones share the same remote. */
  isDuplicate: boolean;
}

/**
 * Sort remotes deterministically: 'origin' first, then alphabetically by name.
 */
function sortedRemotes(repo: LocalRepo): LocalRepo['remotes'] {
  return [...repo.remotes].sort((a, b) =>
    a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name.localeCompare(b.name),
  );
}

/**
 * Compute a stable deduplication key for a local repo.
 * Priority:
 *   1. `repo.linkedGithubRepoId` — stable across renames
 *   2. `remote.githubRepoId` (origin preferred) — stable across renames
 *   3. Normalized GitHub remote URL (origin preferred)
 *   4. Local path — unique, no grouping
 */
function getDedupeKey(repo: LocalRepo): string {
  if (repo.linkedGithubRepoId != null) return `gid:${repo.linkedGithubRepoId}`;

  const remotes = sortedRemotes(repo);
  for (const remote of remotes) {
    if (remote.githubRepoId != null) return `gid:${remote.githubRepoId}`;
  }
  for (const remote of remotes) {
    const gh = normalizeGitHubUrl(remote.url);
    if (gh) return `gh:${gh.toLowerCase()}`;
  }
  return `local:${repo.localPath}`;
}

/**
 * Group repos that share the same remote into deduplicated entries.
 * Repos with no shared remotes appear as individual entries.
 * Insertion order of first-seen groups is preserved for stable rendering.
 */
export function deduplicateLocalRepos(repos: LocalRepo[]): DeduplicatedLocalRepo[] {
  const groups = new Map<string, LocalRepo[]>();
  const keyOrder: string[] = [];

  for (const repo of repos) {
    const key = getDedupeKey(repo);
    if (!groups.has(key)) {
      groups.set(key, []);
      keyOrder.push(key);
    }
    groups.get(key)!.push(repo);
  }

  return keyOrder.map((key) => {
    const group = groups.get(key)!;
    // Primary = most recently scanned; break ties by discoveredAt then localPath
    const sorted = [...group].sort((a, b) => {
      const ta = a.lastScanned ? new Date(a.lastScanned).getTime() : 0;
      const tb = b.lastScanned ? new Date(b.lastScanned).getTime() : 0;
      if (tb !== ta) return tb - ta;
      const da = a.discoveredAt ? new Date(a.discoveredAt).getTime() : 0;
      const db = b.discoveredAt ? new Date(b.discoveredAt).getTime() : 0;
      if (db !== da) return db - da;
      return a.localPath.localeCompare(b.localPath);
    });
    const primaryRepo = sorted[0];
    let githubFullName: string | null = null;
    for (const remote of sortedRemotes(primaryRepo)) {
      const fn = normalizeGitHubUrl(remote.url);
      if (fn) { githubFullName = fn; break; }
    }
    return {
      primaryRepo,
      allLocalPaths: sorted.map((r) => r.localPath),
      githubFullName,
      isDuplicate: group.length > 1,
    };
  });
}

/** Returns all repos whose localPath is at or under the given parentPath. */
export function getReposUnder(parentPath: string, repos: LocalRepo[]): LocalRepo[] {
  const norm = parentPath.replace(/[\\/]+$/, '');
  return repos.filter((r) => {
    const nr = r.localPath;
    return nr === norm || nr.startsWith(norm + '/') || nr.startsWith(norm + '\\');
  });
}

/**
 * Given a parent path and repos under it, returns the immediate child
 * directories (one path segment deeper), each with a repo count.
 */
export function getImmediateChildren(
  parentPath: string,
  repos: LocalRepo[],
): { path: string; name: string; repoCount: number }[] {
  const norm = parentPath.replace(/[\\/]+$/, '');
  const sep = norm.includes('\\') ? '\\' : '/';
  const map = new Map<string, number>();
  for (const repo of repos) {
    if (repo.localPath === norm) continue; // repo IS the parent
    const rel = repo.localPath.slice(norm.length).replace(/^[\\/]+/, '');
    const firstSeg = rel.split(/[\\/]/)[0];
    if (!firstSeg) continue;
    const childPath = norm + sep + firstSeg;
    map.set(childPath, (map.get(childPath) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([path, count]) => ({
      path,
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      repoCount: count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns true if any repo under parentPath is nested deeper than one level. */
export function hasDeepRepos(parentPath: string, repos: LocalRepo[]): boolean {
  const norm = parentPath.replace(/[\\/]+$/, '');
  return repos.some((r) => {
    if (r.localPath === norm) return false;
    const rel = r.localPath.slice(norm.length).replace(/^[\\/]+/, '');
    return /[\\/]/.test(rel);
  });
}

/**
 * Parse a git remote URL and extract `owner/repo` for GitHub remotes.
 * Works in the renderer (no node builtins). Returns null for non-GitHub URLs.
 */
export function normalizeGitHubUrl(url: string): string | null {
  if (!url) return null;
  const https = url.match(/https?:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (https) return https[1];
  const ssh = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (ssh) return ssh[1];
  return null;
}

/** Lightweight Markdown → HTML renderer (no external dependency). */
export function renderChatMarkdown(text: string): string {
  // 1. Extract fenced code blocks so their content is never processed as Markdown.
  const blocks: string[] = [];
  let out = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_: string, code: string) => {
    blocks.push(
      `<pre class="ec-code-block"><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`,
    );
    return `\x00B${blocks.length - 1}\x00`;
  });

  // Inline formatter — protects code spans before applying bold/italic/links.
  const inline = (s: string): string => {
    const codeSpans: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_: string, c: string) => {
      codeSpans.push(`<span class="ec-inline-code">${c}</span>`);
      return `\x00CS${codeSpans.length - 1}\x00`;
    });
    s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\x00CS(\d+)\x00/g, (_: string, i: string) => codeSpans[parseInt(i, 10)]);
    return s;
  };

  // 2. Process line-by-line for block elements (headings, lists, HR).
  const lines = out.split('\n');
  const parts: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;

  const closeList = (): void => {
    if (listTag) { parts.push(listTag === 'ul' ? '</ul>' : '</ol>'); listTag = null; }
  };

  for (const raw of lines) {
    let m: RegExpMatchArray | null;
    // eslint-disable-next-line no-control-regex
    if (/^\x00B\d+\x00$/.test(raw))       { closeList(); parts.push(raw);                                              continue; }
    if (/^-{3,}\s*$/.test(raw))            { closeList(); parts.push('<hr class="ec-hr">');                            continue; }
    if ((m = raw.match(/^###\s+(.*)/)))    { closeList(); parts.push(`<h5 class="ec-heading">${inline(m[1])}</h5>`);  continue; }
    if ((m = raw.match(/^##\s+(.*)/)))     { closeList(); parts.push(`<h4 class="ec-heading">${inline(m[1])}</h4>`);  continue; }
    if ((m = raw.match(/^#\s+(.*)/)))      { closeList(); parts.push(`<h3 class="ec-heading">${inline(m[1])}</h3>`);  continue; }
    if ((m = raw.match(/^[-*+] (.*)/)))    {
      if (listTag !== 'ul') { closeList(); parts.push('<ul class="ec-list">'); listTag = 'ul'; }
      parts.push(`<li>${inline(m[1])}</li>`);                                                                          continue;
    }
    if ((m = raw.match(/^\d+\. (.*)/)))    {
      if (listTag !== 'ol') { closeList(); parts.push('<ol class="ec-list">'); listTag = 'ol'; }
      parts.push(`<li>${inline(m[1])}</li>`);                                                                          continue;
    }
    if (raw.trim() === '')                 { closeList(); parts.push('');                                              continue; }
    closeList();
    parts.push(inline(raw));
  }
  closeList();

  // 3. Join: insert <br> only between consecutive non-block, non-empty lines.
  // eslint-disable-next-line no-control-regex
  const BLOCK = /^(<h[3-5]|<[uo]l|<\/[uo]l>|<li|<hr|\x00B)/;
  const joined: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const curr = parts[i];
    const next = parts[i + 1];
    joined.push(curr);
    if (next !== undefined && curr !== '' && next !== '' && !BLOCK.test(curr) && !BLOCK.test(next)) {
      joined.push('<br>');
    }
  }
  out = joined.join('');

  // 4. Restore code blocks.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\x00B(\d+)\x00/g, (_: string, i: string) => blocks[parseInt(i, 10)]);
  return out;
}

