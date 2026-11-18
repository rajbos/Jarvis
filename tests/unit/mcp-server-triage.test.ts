/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  attentionSummary,
  triageAgentSessions,
  triageFailedRuns,
  triageNotifications,
  triagePrReadiness,
  triageUsage,
} from '../../src/mcp-server/tools/triage';

const NOW = Date.parse('2026-11-18T12:00:00Z');

describe('MCP triage tools', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });
  afterEach(() => db.close());

  function notif(id: string, repo: string, unread: number, at: string) {
    db.run(
      'INSERT INTO github_notifications (id, repo_full_name, repo_owner, subject_title, unread, updated_at) VALUES (?,?,?,?,?,?)',
      [id, repo, repo.split('/')[0], `t-${id}`, unread, at],
    );
  }

  it('lists unread notifications with repo/org filter and truncation', () => {
    notif('1', 'acme/a', 1, '2026-11-18T10:00:00Z');
    notif('2', 'acme/b', 1, '2026-11-18T11:00:00Z');
    notif('3', 'acme/a', 0, '2026-11-18T09:00:00Z');
    notif('4', 'other/x', 1, '2026-11-18T08:00:00Z');

    const all = triageNotifications(db, { limit: 2 });
    expect(all.ok && all.value).toMatchObject({ total: 3, returned: 2, truncated: true });
    const org = triageNotifications(db, { repo: 'ACME' });
    expect(org.ok && org.value.items.map((i) => i.id)).toEqual(['2', '1']);
    const one = triageNotifications(db, { repo: 'acme/a', unreadOnly: false });
    expect(one.ok && one.value.total).toBe(2);
  });

  it('distinguishes empty (success) from unknown repo (error)', () => {
    notif('1', 'acme/a', 0, '2026-11-18T10:00:00Z');
    const empty = triageNotifications(db, { repo: 'acme/a' });
    expect(empty).toEqual({ ok: true, value: { total: 0, returned: 0, truncated: false, items: [] } });
    expect(triageNotifications(db, { repo: 'nope/none' }).ok).toBe(false);
  });

  it('reports a missing table as an error and a degraded summary', () => {
    db.run('DROP TABLE pr_readiness');
    expect(triagePrReadiness(db).ok).toBe(false);
    const s = attentionSummary(db, NOW);
    expect(s.prsReady.total).toBeNull();
    expect(s.prsReady.unavailable).toMatch(/pr_readiness/);
    expect(s.unreadNotifications.total).toBe(0);
  });

  it('lists failed runs within a time window', () => {
    const run = (id: string, repo: string, conclusion: string, at: string) =>
      db.run(
        'INSERT INTO github_workflow_runs (id, repo_full_name, workflow_name, conclusion, run_started_at) VALUES (?,?,?,?,?)',
        [id, repo, 'CI', conclusion, at],
      );
    run('1', 'acme/a', 'failure', '2026-11-18T11:00:00Z');
    run('2', 'acme/a', 'failure', '2026-11-10T11:00:00Z');
    run('3', 'acme/a', 'success', '2026-11-18T11:30:00Z');
    run('4', 'acme/b', 'timed_out', '2026-11-18T10:00:00Z');

    const recent = triageFailedRuns(db, { sinceHours: 24, now: NOW });
    expect(recent.ok && recent.value.items.map((i) => i.id)).toEqual(['1', '4']);
    const repo = triageFailedRuns(db, { repo: 'acme/a' });
    expect(repo.ok && repo.value.total).toBe(2);
    expect(triageFailedRuns(db, { repo: 'acme/a', sinceHours: 0.5, now: NOW })).toMatchObject({ ok: true, value: { total: 0 } });
    expect(triageFailedRuns(db, { repo: 'ghost/repo' }).ok).toBe(false);
    expect(triageFailedRuns(db, { sinceHours: -1 }).ok).toBe(false);
  });

  it('lists PR readiness verdicts', () => {
    db.run(`INSERT INTO pr_readiness (repo_full_name, pr_number, head_sha, ready, waiting_on, checked_at) VALUES
      ('acme/a', 1, 'abc', 1, NULL, '2026-11-18T10:00:00Z'),
      ('acme/a', 2, 'def', 0, 'CI', '2026-11-18T11:00:00Z')`);
    const ready = triagePrReadiness(db, { ready: true });
    expect(ready.ok && ready.value.items).toEqual([
      { repoFullName: 'acme/a', prNumber: 1, headSha: 'abc', ready: true, waitingOn: null, checkedAt: '2026-11-18T10:00:00Z' },
    ]);
    const waiting = triagePrReadiness(db, { repo: 'acme', ready: false });
    expect(waiting.ok && waiting.value.items[0].waitingOn).toBe('CI');
    expect(triagePrReadiness(db, { repo: 'zzz/q' }).ok).toBe(false);
  });

  it('lists open agent sessions, finds by id and errors on unknown id', () => {
    db.run("INSERT INTO agent_definitions (id, name, system_prompt) VALUES (1, 'Reviewer', 'p')");
    db.run(
      `INSERT INTO agent_sessions (id, agent_id, scope_type, scope_value, status, summary, raw_result) VALUES
      (1, 1, 'repo', 'acme/a', 'running', 'working', 'SECRET-RAW'),
      (2, 1, 'repo', 'acme/b', 'completed', ?, 'SECRET-RAW')`,
      ['x'.repeat(900)],
    );
    const open = triageAgentSessions(db);
    expect(open.ok && open.value.items.map((i) => i.id)).toEqual([1]);
    expect(JSON.stringify(open)).not.toContain('SECRET-RAW');
    const done = triageAgentSessions(db, { id: 2 });
    expect(done.ok && done.value.items[0].summary!.length).toBeLessThan(600);
    expect(triageAgentSessions(db, { id: 99 })).toEqual({ ok: false, error: 'Agent session 99 not found.' });
    expect(triageAgentSessions(db, { includeCompleted: true })).toMatchObject({ ok: true, value: { total: 2 } });
  });

  it('returns usage samples, latest first, and errors for unknown or empty metrics', () => {
    db.run('INSERT INTO usage_samples (metric, at, data) VALUES (?,?,?), (?,?,?), (?,?,?)', [
      'claude', NOW - 1000, JSON.stringify({ five_hour: [40, 100] }),
      'claude', NOW - 7_200_000, JSON.stringify({ five_hour: [10, 100] }),
      'copilot', NOW - 500, JSON.stringify({ acct: [5, null] }),
    ]);
    const latest = triageUsage(db);
    expect(latest.ok && latest.value.samples.map((s) => s.metric)).toEqual(['claude', 'copilot']);
    const hist = triageUsage(db, { metric: 'claude', limit: 5, now: NOW });
    expect(hist.ok && hist.value.samples).toHaveLength(2);
    const windowed = triageUsage(db, { metric: 'claude', limit: 5, sinceHours: 1, now: NOW });
    expect(windowed.ok && windowed.value.samples[0].series.five_hour).toEqual({ value: 40, limit: 100 });
    expect(triageUsage(db, { metric: 'claude', limit: 1, now: NOW })).toMatchObject({ ok: true, value: { truncated: true } });
    expect(triageUsage(db, { metric: 'github-pat' }).ok).toBe(false);
    expect(triageUsage(db, { metric: 'bogus' }).ok).toBe(false);
  });

  it('summarises counts', () => {
    notif('1', 'acme/a', 1, '2026-11-18T10:00:00Z');
    const s = attentionSummary(db, NOW);
    expect(s.unreadNotifications.total).toBe(1);
    expect(s.failedRunsLast24h.total).toBe(0);
  });
});
