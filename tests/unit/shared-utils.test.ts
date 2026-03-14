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

  it('does not crash on empty string', () => {
    expect(() => renderChatMarkdown('')).not.toThrow();
  });
});
