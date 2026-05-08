/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect } from 'vitest';
import {
  relativeAge,
  notifDescription,
  isDirect,
  renderChatMarkdown,
} from '../../src/plugins/shared/utils';

// ── relativeAge ───────────────────────────────────────────────────────────────
describe('relativeAge', () => {
  it('returns "just now" for < 1 hour ago', () => {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(relativeAge(thirtyMinsAgo)).toBe('just now');
  });

  it('returns hours for 1–23 hours ago', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
    expect(relativeAge(fiveHoursAgo)).toBe('5h ago');
  });

  it('returns days for 1–13 days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    expect(relativeAge(threeDaysAgo)).toBe('3d ago');
  });

  it('returns weeks for ≥ 14 days ago', () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 3_600_000).toISOString();
    expect(relativeAge(threeWeeksAgo)).toBe('3w ago');
  });

  it('boundary: exactly 1 hour ago', () => {
    // 1h counts as "1h ago", not "just now"
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(relativeAge(oneHourAgo)).toBe('1h ago');
  });

  it('boundary: exactly 14 days ago returns weeks', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
    expect(relativeAge(twoWeeksAgo)).toBe('2w ago');
  });
});

// ── notifDescription ──────────────────────────────────────────────────────────
describe('notifDescription', () => {
  it('assign on PullRequest', () => {
    expect(notifDescription('PullRequest', 'assign')).toBe('PR assigned to you');
  });

  it('assign on Issue', () => {
    expect(notifDescription('Issue', 'assign')).toBe('Issue assigned to you');
  });

  it('review_requested (PullRequest)', () => {
    expect(notifDescription('PullRequest', 'review_requested')).toBe('PR review requested');
  });

  it('mention on Issue', () => {
    expect(notifDescription('Issue', 'mention')).toBe('@mentioned in issue');
  });

  it('mention on PullRequest', () => {
    expect(notifDescription('PullRequest', 'mention')).toBe('@mentioned in PR');
  });

  it('team_mention on Issue', () => {
    expect(notifDescription('Issue', 'team_mention')).toBe('Team @mentioned in issue');
  });

  it('author on Issue', () => {
    expect(notifDescription('Issue', 'author')).toBe('Your issue has activity');
  });

  it('author on PullRequest', () => {
    expect(notifDescription('PullRequest', 'author')).toBe('Your PR has activity');
  });

  it('comment on PullRequest', () => {
    expect(notifDescription('PullRequest', 'comment')).toBe('Comment on PR');
  });

  it('subscribed on PullRequest', () => {
    expect(notifDescription('PullRequest', 'subscribed')).toBe('Watched PR updated');
  });

  it('state_change on PullRequest', () => {
    expect(notifDescription('PullRequest', 'state_change')).toBe('PR state changed');
  });

  it('ci_activity', () => {
    expect(notifDescription('CheckSuite', 'ci_activity')).toBe('CI activity');
  });

  it('security_alert', () => {
    expect(notifDescription('RepositoryVulnerabilityAlert', 'security_alert')).toContain('Security alert');
  });

  it('unknown reason falls back to "Type — reason" format', () => {
    expect(notifDescription('Release', 'unknown_reason')).toBe('Release \u2014 unknown_reason');
  });
});

// ── isDirect ──────────────────────────────────────────────────────────────────
describe('isDirect', () => {
  it.each(['assign', 'review_requested', 'mention', 'team_mention', 'author', 'security_alert'])(
    'returns true for direct reason: %s',
    (reason) => {
      expect(isDirect(reason)).toBe(true);
    },
  );

  it.each(['subscribed', 'comment', 'state_change', 'ci_activity', 'unknown'])(
    'returns false for non-direct reason: %s',
    (reason) => {
      expect(isDirect(reason)).toBe(false);
    },
  );
});

// ── renderChatMarkdown ────────────────────────────────────────────────────────
describe('renderChatMarkdown', () => {
  it('converts **bold** to <strong>', () => {
    expect(renderChatMarkdown('Hello **world**!')).toContain('<strong>world</strong>');
  });

  it('converts `inline code` to ec-inline-code span', () => {
    const out = renderChatMarkdown('Run `npm install` first');
    expect(out).toContain('<span class="ec-inline-code">npm install</span>');
  });

  it('converts # heading to h3', () => {
    expect(renderChatMarkdown('# Title')).toContain('<h3 class="ec-heading">Title</h3>');
  });

  it('converts ## heading to h4', () => {
    expect(renderChatMarkdown('## Sub')).toContain('<h4 class="ec-heading">Sub</h4>');
  });

  it('converts ### heading to h5', () => {
    expect(renderChatMarkdown('### Sub-sub')).toContain('<h5 class="ec-heading">Sub-sub</h5>');
  });

  it('converts fenced code blocks with HTML escaping', () => {
    const out = renderChatMarkdown('```\nconst x = 1 < 2 && true;\n```');
    expect(out).toContain('<pre class="ec-code-block">');
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
  });

  it('converts HTML special chars inside code blocks (>)', () => {
    const out = renderChatMarkdown('```\na > b\n```');
    expect(out).toContain('&gt;');
  });

  it('converts newlines to <br> outside code blocks', () => {
    const out = renderChatMarkdown('line one\nline two');
    expect(out).toContain('<br>');
  });

  it('does not add <br> between block elements', () => {
    const out = renderChatMarkdown('## Section\nSome text');
    expect(out).not.toMatch(/<\/h4><br>/);
    expect(out).toContain('<h4 class="ec-heading">Section</h4>');
  });

  it('converts unordered list items to <ul><li>', () => {
    const out = renderChatMarkdown('- alpha\n- beta\n- gamma');
    expect(out).toContain('<ul class="ec-list">');
    expect(out).toContain('<li>alpha</li>');
    expect(out).toContain('<li>beta</li>');
    expect(out).toContain('</ul>');
  });

  it('converts ordered list items to <ol><li>', () => {
    const out = renderChatMarkdown('1. first\n2. second');
    expect(out).toContain('<ol class="ec-list">');
    expect(out).toContain('<li>first</li>');
    expect(out).toContain('</ol>');
  });

  it('converts *italic* to <em>', () => {
    expect(renderChatMarkdown('*hello*')).toContain('<em>hello</em>');
  });

  it('converts markdown links to <a>', () => {
    const out = renderChatMarkdown('[GitHub](https://github.com)');
    expect(out).toContain('<a href="https://github.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('GitHub');
  });

  it('does not crash on empty string', () => {
    expect(() => renderChatMarkdown('')).not.toThrow();
  });
});

// ── getReposUnder ─────────────────────────────────────────────────────────────
import {
  getReposUnder,
  getImmediateChildren,
  hasDeepRepos,
  normalizeGitHubUrl,
} from '../../src/plugins/shared/utils';
import type { LocalRepo } from '../../src/plugins/types';

function makeRepo(localPath: string): LocalRepo {
  return { id: 0, localPath, remoteUrl: null, fullName: null, scannedAt: '' };
}

describe('getReposUnder', () => {
  const repos = [
    makeRepo('/home/user/projects/frontend'),
    makeRepo('/home/user/projects/backend'),
    makeRepo('/home/user/other/tool'),
    makeRepo('/home/user/projects'),
  ];

  it('returns repos directly at the given path', () => {
    const result = getReposUnder('/home/user/projects', repos);
    expect(result.map((r) => r.localPath)).toContain('/home/user/projects');
  });

  it('returns repos nested under the given path', () => {
    const result = getReposUnder('/home/user/projects', repos);
    expect(result.map((r) => r.localPath)).toContain('/home/user/projects/frontend');
    expect(result.map((r) => r.localPath)).toContain('/home/user/projects/backend');
  });

  it('excludes repos outside the given path', () => {
    const result = getReposUnder('/home/user/projects', repos);
    expect(result.map((r) => r.localPath)).not.toContain('/home/user/other/tool');
  });

  it('strips trailing slashes from the parent path', () => {
    const result = getReposUnder('/home/user/projects/', repos);
    expect(result).toHaveLength(3);
  });
});

describe('getImmediateChildren', () => {
  const repos = [
    makeRepo('/projects/frontend'),
    makeRepo('/projects/frontend/sub'),
    makeRepo('/projects/backend'),
    makeRepo('/projects/tools/linter'),
  ];

  it('returns immediate child directories with repo counts', () => {
    const children = getImmediateChildren('/projects', repos);
    const names = children.map((c) => c.name);
    expect(names).toContain('frontend');
    expect(names).toContain('backend');
    expect(names).toContain('tools');
  });

  it('counts all repos nested under each child', () => {
    const children = getImmediateChildren('/projects', repos);
    const frontend = children.find((c) => c.name === 'frontend');
    expect(frontend?.repoCount).toBe(2);
  });

  it('sorts children alphabetically', () => {
    const children = getImmediateChildren('/projects', repos);
    const names = children.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it('skips repos whose path equals the parent path', () => {
    const reposWithParent = [...repos, makeRepo('/projects')];
    const children = getImmediateChildren('/projects', reposWithParent);
    expect(children.every((c) => c.path !== '/projects')).toBe(true);
  });
});

describe('hasDeepRepos', () => {
  it('returns true when a repo is nested more than one level deep', () => {
    const repos = [makeRepo('/projects/a/deep/repo')];
    expect(hasDeepRepos('/projects', repos)).toBe(true);
  });

  it('returns false when all repos are exactly one level deep', () => {
    const repos = [makeRepo('/projects/frontend'), makeRepo('/projects/backend')];
    expect(hasDeepRepos('/projects', repos)).toBe(false);
  });

  it('returns false when the repo path equals the parent path', () => {
    const repos = [makeRepo('/projects')];
    expect(hasDeepRepos('/projects', repos)).toBe(false);
  });
});

describe('normalizeGitHubUrl (renderer version)', () => {
  it('parses HTTPS GitHub URLs', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses HTTPS URLs ending in .git', () => {
    expect(normalizeGitHubUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses SSH GitHub URLs', () => {
    expect(normalizeGitHubUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('returns null for non-GitHub URLs', () => {
    expect(normalizeGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeGitHubUrl('')).toBeNull();
  });
});

// ── deduplicateLocalRepos ─────────────────────────────────────────────────────
import { deduplicateLocalRepos } from '../../src/plugins/shared/utils';
import type { LocalRemote } from '../../src/plugins/types';

function makeFullRepo(
  localPath: string,
  remotes: { name: string; url: string; githubRepoId?: number | null }[] = [],
  opts: { id?: number; linkedGithubRepoId?: number | null; lastScanned?: string | null; discoveredAt?: string } = {},
): LocalRepo {
  return {
    id: opts.id ?? 0,
    localPath,
    name: localPath.split(/[\\/]/).filter(Boolean).pop() ?? localPath,
    remotes: remotes as LocalRemote[],
    discoveredAt: opts.discoveredAt ?? '2024-01-01T00:00:00Z',
    lastScanned: opts.lastScanned !== undefined ? opts.lastScanned : null,
    linkedGithubRepoId: opts.linkedGithubRepoId ?? null,
  };
}

describe('deduplicateLocalRepos', () => {
  it('groups two clones of the same GitHub remote URL', () => {
    const repos = [
      makeFullRepo('/repos/a/myrepo', [{ name: 'origin', url: 'https://github.com/org/myrepo.git' }]),
      makeFullRepo('/repos/b/myrepo', [{ name: 'origin', url: 'https://github.com/org/myrepo.git' }]),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(1);
    expect(result[0].allLocalPaths).toHaveLength(2);
    expect(result[0].isDuplicate).toBe(true);
    expect(result[0].githubFullName).toBe('org/myrepo');
  });

  it('groups by linkedGithubRepoId (handles remote renames)', () => {
    const repos = [
      makeFullRepo('/repos/old-name', [{ name: 'origin', url: 'https://github.com/org/old-name.git' }], { linkedGithubRepoId: 42 }),
      makeFullRepo('/repos/new-name', [{ name: 'origin', url: 'https://github.com/org/new-name.git' }], { linkedGithubRepoId: 42 }),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(1);
    expect(result[0].isDuplicate).toBe(true);
    expect(result[0].allLocalPaths).toContain('/repos/old-name');
    expect(result[0].allLocalPaths).toContain('/repos/new-name');
  });

  it('groups by remote.githubRepoId even when linkedGithubRepoId is null', () => {
    const repos = [
      makeFullRepo('/repos/clone1', [{ name: 'origin', url: 'https://github.com/org/repo.git', githubRepoId: 99 }]),
      makeFullRepo('/repos/clone2', [{ name: 'origin', url: 'https://github.com/org/repo-renamed.git', githubRepoId: 99 }]),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(1);
    expect(result[0].isDuplicate).toBe(true);
  });

  it('does not group repos with different remotes', () => {
    const repos = [
      makeFullRepo('/repos/a', [{ name: 'origin', url: 'https://github.com/org/repo-a.git' }]),
      makeFullRepo('/repos/b', [{ name: 'origin', url: 'https://github.com/org/repo-b.git' }]),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(2);
    expect(result.every((g) => !g.isDuplicate)).toBe(true);
  });

  it('treats repos with no remotes as unique entries', () => {
    const repos = [
      makeFullRepo('/repos/no-remote-a'),
      makeFullRepo('/repos/no-remote-b'),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(2);
  });

  it('selects the most recently scanned clone as primary', () => {
    const repos = [
      makeFullRepo('/repos/old', [{ name: 'origin', url: 'https://github.com/org/repo.git' }], { lastScanned: '2024-01-01T00:00:00Z' }),
      makeFullRepo('/repos/new', [{ name: 'origin', url: 'https://github.com/org/repo.git' }], { lastScanned: '2024-06-01T00:00:00Z' }),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result[0].primaryRepo.localPath).toBe('/repos/new');
    expect(result[0].allLocalPaths[0]).toBe('/repos/new');
  });

  it('uses localPath as tiebreaker for repos with equal lastScanned', () => {
    const scanned = '2024-01-01T00:00:00Z';
    const repos = [
      makeFullRepo('/repos/z-clone', [{ name: 'origin', url: 'https://github.com/org/repo.git' }], { lastScanned: scanned }),
      makeFullRepo('/repos/a-clone', [{ name: 'origin', url: 'https://github.com/org/repo.git' }], { lastScanned: scanned }),
    ];
    const result = deduplicateLocalRepos(repos);
    // a-clone < z-clone lexicographically → a-clone is primary
    expect(result[0].primaryRepo.localPath).toBe('/repos/a-clone');
  });

  it('handles null lastScanned gracefully', () => {
    const repos = [
      makeFullRepo('/repos/scanned', [{ name: 'origin', url: 'https://github.com/org/repo.git' }], { lastScanned: '2024-01-01T00:00:00Z' }),
      makeFullRepo('/repos/unscanned', [{ name: 'origin', url: 'https://github.com/org/repo.git' }], { lastScanned: null }),
    ];
    const result = deduplicateLocalRepos(repos);
    // Scanned repo should be primary (null treated as oldest)
    expect(result[0].primaryRepo.localPath).toBe('/repos/scanned');
  });

  it('prefers origin remote for githubFullName', () => {
    const repos = [
      makeFullRepo('/repos/myfork', [
        { name: 'upstream', url: 'https://github.com/org/repo.git' },
        { name: 'origin', url: 'https://github.com/user/myfork.git' },
      ]),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result[0].githubFullName).toBe('user/myfork');
  });

  it('handles HTTPS and SSH variants of the same URL as identical', () => {
    const repos = [
      makeFullRepo('/repos/https', [{ name: 'origin', url: 'https://github.com/org/repo.git' }]),
      makeFullRepo('/repos/ssh', [{ name: 'origin', url: 'git@github.com:org/repo.git' }]),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(1);
    expect(result[0].isDuplicate).toBe(true);
  });

  it('returns single entries unchanged', () => {
    const repos = [
      makeFullRepo('/repos/solo', [{ name: 'origin', url: 'https://github.com/org/solo.git' }]),
    ];
    const result = deduplicateLocalRepos(repos);
    expect(result).toHaveLength(1);
    expect(result[0].isDuplicate).toBe(false);
    expect(result[0].allLocalPaths).toEqual(['/repos/solo']);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateLocalRepos([])).toEqual([]);
  });
});
