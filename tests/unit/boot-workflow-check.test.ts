/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { isWorkflowDataFresh } from '../../src/plugins/notifications/workflow-cache';

// ── Helpers ───────────────────────────────────────────────────────────────────

function insertWorkflowRun(
  db: SqlJsDatabase,
  repoFullName: string,
  fetchedAt: string,
): void {
  db.run(
    `INSERT INTO github_workflow_runs
       (id, repo_full_name, workflow_name, workflow_id, head_branch, head_sha,
        event, status, conclusion, run_number, run_started_at, updated_at, html_url, fetched_at)
     VALUES (?, ?, 'CI', '1', 'main', 'abc', 'push', 'completed', 'success', 1,
             datetime('now'), datetime('now'), 'https://github.com/x/y/actions', ?)`,
    [Math.random().toString(), repoFullName, fetchedAt],
  );
}

// ── Tests: isWorkflowDataFresh ────────────────────────────────────────────────

describe('isWorkflowDataFresh', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('returns false when no workflow runs exist for the repo', () => {
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(false);
  });

  it('returns false when workflow runs exist for a different repo only', () => {
    insertWorkflowRun(db, 'other/repo', new Date().toISOString().replace('T', ' ').slice(0, 19));
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(false);
  });

  it('returns true when data was fetched just now', () => {
    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    insertWorkflowRun(db, 'owner/repo', nowUtc);
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(true);
  });

  it('returns true when data was fetched 10 minutes ago', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    insertWorkflowRun(db, 'owner/repo', tenMinAgo);
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(true);
  });

  it('returns false when data was fetched 31 minutes ago', () => {
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    insertWorkflowRun(db, 'owner/repo', thirtyOneMinAgo);
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(false);
  });

  it('returns false when data was fetched 2 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    insertWorkflowRun(db, 'owner/repo', twoHoursAgo);
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(false);
  });

  it('uses MAX(fetched_at) — returns true if any run was fetched recently', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    insertWorkflowRun(db, 'owner/repo', twoHoursAgo);
    insertWorkflowRun(db, 'owner/repo', fiveMinAgo);
    expect(isWorkflowDataFresh(db, 'owner/repo')).toBe(true);
  });
});
