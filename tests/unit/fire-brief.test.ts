/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  acknowledgeBrief, addProseSummary, buildFireBrief, collectBriefInputs, formatElapsed, resolveSince,
  DEFAULT_LOOKBACK_MS, MAX_ITEMS_PER_SECTION, SESSION_STALL_MS, type FireBriefInputs,
} from '../../src/services/fire-brief';
import type { ActiveSessionEntry } from '../../src/plugins/types';

const NOW = Date.parse('2026-01-10T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const sqlTime = (offsetMs: number) => iso(offsetMs).slice(0, 19).replace('T', ' ');
const HOUR = 3600_000;

function inputs(partial: Partial<FireBriefInputs> = {}): FireBriefInputs {
  return { now: NOW, lastBriefAt: null, notifications: [], failedRuns: [], prs: [], sessions: [], taskFailures: [], ...partial };
}

function session(activity: string, updatedOffset: number, extra: Record<string, unknown> = {}): ActiveSessionEntry {
  return {
    session: { key: `local:copilot:${activity}${updatedOffset}`, provider: 'copilot', origin: 'local', client: 'Copilot CLI', sessionId: 's', title: 'Fix the widget', cwd: null, repoFullName: 'acme/widgets', branch: null, activity, startedAt: null, updatedAt: iso(updatedOffset), ...extra },
    agent: { light: 'amber', label: 'x', detail: '', blocking: false },
    pr: null, verdict: 'no_pr', verdictLabel: 'No PR yet',
  } as unknown as ActiveSessionEntry;
}

describe('resolveSince', () => {
  it('defaults to 24h, honours the marker, caps at 7 days, ignores future markers', () => {
    expect(resolveSince(NOW, null)).toBe(NOW - DEFAULT_LOOKBACK_MS);
    expect(resolveSince(NOW, NOW - 2 * HOUR)).toBe(NOW - 2 * HOUR);
    expect(resolveSince(NOW, NOW - 30 * 24 * HOUR)).toBe(NOW - 7 * 24 * HOUR);
    expect(resolveSince(NOW, NOW + HOUR)).toBe(NOW - DEFAULT_LOOKBACK_MS);
  });
});

describe('buildFireBrief', () => {
  it('is all clear when there is nothing to report', () => {
    const b = buildFireBrief(inputs());
    expect(b.allClear).toBe(true);
    expect(b.sections).toEqual([]);
  });

  it('groups notifications per repo and links to the item or the repo', () => {
    const b = buildFireBrief(inputs({ notifications: [
      { id: '1', repoFullName: 'acme/widgets', title: 'Bug', subjectType: 'Issue', subjectUrl: 'https://api.github.com/repos/acme/widgets/issues/5', host: 'github.com' },
      { id: '2', repoFullName: 'acme/gears', title: 'A', subjectType: 'Issue', subjectUrl: null, host: 'github.com' },
      { id: '3', repoFullName: 'acme/gears', title: 'B', subjectType: 'Issue', subjectUrl: null, host: 'github.com' },
    ] }));
    const items = b.sections[0].items;
    expect(items[0]).toMatchObject({ text: 'acme/gears: 2 unread notifications', url: 'https://github.com/acme/gears' });
    expect(items[1]).toMatchObject({ text: 'acme/widgets: Bug', url: 'https://github.com/acme/widgets/issues/5' });
  });

  it('only includes failed runs since the last brief', () => {
    const run = (id: string, at: number) => ({ id, repoFullName: 'acme/widgets', workflowName: 'CI', branch: 'main', htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}`, at: iso(at) });
    const b = buildFireBrief(inputs({ lastBriefAt: NOW - 2 * HOUR, failedRuns: [run('old', -3 * HOUR), run('new', -HOUR)] }));
    expect(b.sections[0].items.map((i) => i.id)).toEqual(['run:new']);
    expect(b.sections[0].items[0].url).toBe('https://github.com/acme/widgets/actions/runs/new');
  });

  it('parses SQLite timestamps without a zone as UTC', () => {
    const b = buildFireBrief(inputs({ failedRuns: [{ id: '1', repoFullName: 'a/b', workflowName: null, branch: null, htmlUrl: null, at: '2026-01-10 11:00:00' }] }));
    expect(b.sections[0].items[0]).toMatchObject({ text: 'a/b: workflow failed', url: 'https://github.com/a/b' });
  });

  it('lists ready and blocked PRs but not idle or stale ones', () => {
    const pr = (n: number, ready: boolean, waitingOn: string[], age = HOUR) => ({ repoFullName: 'acme/widgets', prNumber: n, ready, waitingOn, checkedAt: iso(-age) });
    const b = buildFireBrief(inputs({ prs: [pr(1, false, ['checks']), pr(2, true, []), pr(3, false, []), pr(4, true, [], 10 * 24 * HOUR)] }));
    const items = b.sections[0].items;
    expect(items.map((i) => i.text)).toEqual(['acme/widgets#2 is ready for review', 'acme/widgets#1 is blocked, waiting on checks']);
    expect(items[0].url).toBe('https://github.com/acme/widgets/pull/2');
  });

  it('flags sessions needing input and stalled ones', () => {
    const b = buildFireBrief(inputs({ sessions: [
      session('waiting_for_user', -HOUR),
      session('working', -(SESSION_STALL_MS + 60_000)),
      session('working', -60_000),
      session('idle', -5 * HOUR),
    ] }));
    expect(b.sections[0].items.map((i) => i.text)).toEqual([
      'Copilot CLI needs input: Fix the widget',
      'Copilot CLI looks stalled (no update for 31 min): Fix the widget',
    ]);
    expect(b.sections[0].items[0].severity).toBe('fire');
  });

  it('skips sessions whose PR was merged or closed, keeps open or missing PRs', () => {
    const withPr = (activity: string, state: string | null) => {
      const e = session(activity, -60 * 24 * HOUR, { key: `${activity}:${state}` });
      if (state) e.pr = { state, url: `https://github.com/acme/widgets/pull/1` } as ActiveSessionEntry['pr'];
      return e;
    };
    const b = buildFireBrief(inputs({ sessions: [
      withPr('working', 'MERGED'),
      withPr('working', 'CLOSED'),
      withPr('waiting_for_user', 'MERGED'),
      withPr('working', 'OPEN'),
      withPr('working', null),
    ] }));
    expect(b.sections[0].items.map((i) => i.id)).toEqual(['session:working:OPEN', 'session:working:null']);
  });

  it('formats elapsed time in a human-readable unit', () => {
    const MIN = 60_000;
    expect(formatElapsed(31 * MIN)).toBe('31 min');
    expect(formatElapsed(60 * MIN)).toBe('1 hour');
    expect(formatElapsed(47 * HOUR)).toBe('47 hours');
    expect(formatElapsed(48 * HOUR)).toBe('2 days');
    expect(formatElapsed(20 * 24 * HOUR)).toBe('2 weeks');
    expect(formatElapsed(108027 * MIN)).toBe('2 months');
    expect(formatElapsed(400 * 24 * HOUR)).toBe('1 year');
  });

  it('reports task failures since the last brief with a local tab hint', () => {
    const b = buildFireBrief(inputs({ taskFailures: [
      { taskId: 'sync', failedAt: iso(-HOUR), error: 'boom' },
      { taskId: 'old', failedAt: iso(-3 * 24 * HOUR), error: 'x' },
    ] }));
    expect(b.sections[0].items).toHaveLength(1);
    expect(b.sections[0].items[0]).toMatchObject({ url: null, tab: 'setup' });
  });

  it('caps items per section but keeps the total', () => {
    const notifications = Array.from({ length: 25 }, (_, i) => ({ id: String(i), repoFullName: `acme/r${String(i).padStart(2, '0')}`, title: 't', subjectType: null, subjectUrl: null, host: 'github.com' }));
    const b = buildFireBrief(inputs({ notifications }));
    expect(b.sections[0].items).toHaveLength(MAX_ITEMS_PER_SECTION);
    expect(b.sections[0].total).toBe(25);
    expect(b.totalItems).toBe(25);
  });

  it('every item has a link or a local tab', () => {
    const b = buildFireBrief(inputs({
      sessions: [session('waiting_for_user', -HOUR)],
      taskFailures: [{ taskId: 't', failedAt: iso(-HOUR), error: 'e' }],
      prs: [{ repoFullName: 'a/b', prNumber: 1, ready: true, waitingOn: [], checkedAt: iso(-HOUR) }],
    }));
    for (const s of b.sections) for (const i of s.items) expect(i.url !== null || i.tab !== undefined).toBe(true);
  });
});

describe('addProseSummary', () => {
  const brief = buildFireBrief(inputs({ taskFailures: [{ taskId: 't', failedAt: iso(-HOUR), error: 'e' }] }));

  it('returns the structured brief unchanged without a summarizer (Ollama stopped)', async () => {
    expect(await addProseSummary(brief, null)).toBe(brief);
  });
  it('degrades gracefully when the summarizer throws or times out', async () => {
    expect(await addProseSummary(brief, async () => { throw new Error('connection refused'); })).toBe(brief);
    expect(await addProseSummary(brief, () => new Promise(() => undefined), 20)).toBe(brief);
  });
  it('adds trimmed prose on success and skips it for an all-clear brief', async () => {
    expect((await addProseSummary(brief, async () => '  Task t failed.  ')).summary).toBe('Task t failed.');
    const clear = buildFireBrief(inputs());
    expect(await addProseSummary(clear, async () => 'x')).toBe(clear);
  });
});

describe('collectBriefInputs', () => {
  let db: SqlJsDatabase;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  it('reads every source from the schema and respects the acknowledgement marker', () => {
    db.run("INSERT INTO github_notifications (id, repo_full_name, repo_owner, subject_title, unread) VALUES ('1','acme/widgets','acme','Bug',1), ('2','acme/widgets','acme','Read',0)");
    db.run(
      "INSERT INTO github_workflow_runs (id, repo_full_name, workflow_name, head_branch, conclusion, updated_at, html_url) VALUES ('r1','acme/widgets','CI','main','failure',?, 'https://github.com/acme/widgets/actions/runs/1'), ('r2','acme/widgets','CI','main','success',?, NULL)",
      [sqlTime(-HOUR), sqlTime(-HOUR)],
    );
    db.run("INSERT INTO pr_readiness (repo_full_name, pr_number, head_sha, ready, waiting_on, checked_at) VALUES ('acme/widgets', 7, 'abc', 0, 'checks,copilot_review', ?)", [iso(-HOUR)]);
    db.run("INSERT INTO task_failures (task_id, failed_at, error) VALUES ('sync', ?, 'boom')", [iso(-HOUR)]);

    const brief = buildFireBrief(collectBriefInputs(db, null, NOW));
    expect(brief.sections.map((s) => s.id).sort()).toEqual(['failed_runs', 'notifications', 'prs', 'task_failures']);
    expect(brief.sections.find((s) => s.id === 'prs')!.items[0].text).toContain('checks + Copilot review');
    expect(brief.sections.find((s) => s.id === 'notifications')!.total).toBe(1);

    acknowledgeBrief(db, NOW - 30 * 60_000);
    const after = buildFireBrief(collectBriefInputs(db, null, NOW));
    expect(after.sections.map((s) => s.id).sort()).toEqual(['notifications', 'prs']);
  });

  it('survives missing tables', async () => {
    const SQL = await initSqlJs();
    const bare = new SQL.Database();
    expect(buildFireBrief(collectBriefInputs(bare, null, NOW)).allClear).toBe(true);
  });
});
