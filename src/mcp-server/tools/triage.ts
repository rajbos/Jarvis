// ── Triage tools for the Jarvis MCP server ────────────────────────────────────
// Read-only views over data the Jarvis app already stores that answers "what
// needs my attention?": unread notifications, failed workflow runs, PR
// readiness verdicts, agent sessions and usage samples.
//
// Result contract (see docs/MCP-SERVER.md, "Triage tools"):
//   ok:false  -> the MCP layer sets isError. Used when a prerequisite is
//                missing (table absent in an older database / never populated),
//                an argument is invalid, or a named repo/owner/session is not
//                known at all.
//   ok:true   -> success. An empty `items` array with `total: 0` is a genuine
//                "nothing needs attention" answer.
// Every list reports `total` (matches before the cap), `returned` and
// `truncated`. Only selected, non-secret columns are returned: never tokens,
// log excerpts, raw API payloads or agent raw_result blobs.
import type { Database as SqlJsDatabase } from 'sql.js';

export type TriageResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Page<T> {
  total: number;
  returned: number;
  truncated: boolean;
  items: T[];
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

function readAll<T>(db: SqlJsDatabase, sql: string, params: Array<string | number> = []): T[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows: T[] = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
  } finally {
    stmt.free();
  }
  return rows;
}

function hasTable(db: SqlJsDatabase, table: string): boolean {
  return readAll(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0;
}

function columns(db: SqlJsDatabase, table: string): Set<string> {
  return new Set(readAll<{ name: string }>(db, `PRAGMA table_info(${table})`).map((r) => r.name));
}

function missingTable(table: string, what: string): TriageResult<never> {
  return {
    ok: false,
    error: `No ${what} data available: table "${table}" does not exist in the Jarvis database. ` +
      'Start the Jarvis app (a recent version) so it can create and populate it.',
  };
}

function page<T>(total: number, items: T[]): Page<T> {
  return { total, returned: items.length, truncated: total > items.length, items };
}

/** "owner/repo" matches one repo, "owner" matches every repo of the owner. */
function repoFilter(repo: string, column: string): { sql: string; param: string } {
  const r = repo.trim().toLowerCase();
  return r.includes('/')
    ? { sql: `LOWER(${column}) = ?`, param: r }
    : { sql: `LOWER(${column}) LIKE ?`, param: `${r.replace(/[%_]/g, '')}/%` };
}

function repoOrOwnerKnown(db: SqlJsDatabase, repo: string, sources: Array<[string, string]>): boolean {
  const tables = [...sources, ['github_repos', 'full_name'] as [string, string]];
  for (const [table, column] of tables) {
    if (!hasTable(db, table)) continue;
    const filter = repoFilter(repo, column);
    if (readAll(db, `SELECT 1 FROM ${table} WHERE ${filter.sql} LIMIT 1`, [filter.param]).length > 0) return true;
  }
  return false;
}

function unknownRepo(repo: string): TriageResult<never> {
  return { ok: false, error: `Repo or owner "${repo}" is not known to Jarvis (no cached data for it). Check the spelling ("owner/repo" or "owner").` };
}

// ── Unread notifications ──────────────────────────────────────────────────────

export interface TriageNotification {
  id: string;
  repoFullName: string;
  subjectType: string | null;
  subjectTitle: string | null;
  actorLogin: string | null;
  reason: string | null;
  unread: boolean;
  updatedAt: string | null;
}

export interface TriageNotificationOptions {
  repo?: string;
  /** Default true: only unread notifications. */
  unreadOnly?: boolean;
  limit?: number;
}

export function triageNotifications(db: SqlJsDatabase, opts: TriageNotificationOptions = {}): TriageResult<Page<TriageNotification>> {
  if (!hasTable(db, 'github_notifications')) return missingTable('github_notifications', 'notification');
  const limit = clampLimit(opts.limit);
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (opts.repo) {
    if (!repoOrOwnerKnown(db, opts.repo, [['github_notifications', 'repo_full_name']])) return unknownRepo(opts.repo);
    const f = repoFilter(opts.repo, 'repo_full_name');
    where.push(f.sql);
    params.push(f.param);
  }
  if (opts.unreadOnly ?? true) where.push('unread = 1');
  const total = readAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM github_notifications WHERE ${where.join(' AND ')}`, params)[0]?.n ?? 0;
  const rows = readAll<{
    id: string; repo_full_name: string; subject_type: string | null; subject_title: string | null;
    subject_actor_login: string | null; reason: string | null; unread: number; updated_at: string | null;
  }>(
    db,
    `SELECT id, repo_full_name, subject_type, subject_title, subject_actor_login, reason, unread, updated_at
     FROM github_notifications WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    [...params, limit],
  );
  return {
    ok: true,
    value: page(total, rows.map((r) => ({
      id: r.id,
      repoFullName: r.repo_full_name,
      subjectType: r.subject_type,
      subjectTitle: r.subject_title,
      actorLogin: r.subject_actor_login,
      reason: r.reason,
      unread: r.unread === 1,
      updatedAt: r.updated_at,
    }))),
  };
}

// ── Failed workflow runs ──────────────────────────────────────────────────────

export interface TriageFailedRun {
  id: string;
  repoFullName: string;
  workflowName: string | null;
  headBranch: string | null;
  event: string | null;
  conclusion: string | null;
  runNumber: number | null;
  runStartedAt: string | null;
  htmlUrl: string | null;
}

export interface TriageFailedRunOptions {
  repo?: string;
  /** Only runs started within this many hours before `now`. */
  sinceHours?: number;
  limit?: number;
  now?: number;
}

const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

export function triageFailedRuns(db: SqlJsDatabase, opts: TriageFailedRunOptions = {}): TriageResult<Page<TriageFailedRun>> {
  if (!hasTable(db, 'github_workflow_runs')) return missingTable('github_workflow_runs', 'workflow run');
  if (opts.sinceHours !== undefined && !(opts.sinceHours > 0)) {
    return { ok: false, error: 'sinceHours must be a positive number.' };
  }
  const limit = clampLimit(opts.limit);
  const where: string[] = [`LOWER(COALESCE(conclusion, '')) IN (${FAILED_CONCLUSIONS.map(() => '?').join(',')})`];
  const params: Array<string | number> = [...FAILED_CONCLUSIONS];
  if (opts.repo) {
    if (!repoOrOwnerKnown(db, opts.repo, [['github_workflow_runs', 'repo_full_name']])) return unknownRepo(opts.repo);
    const f = repoFilter(opts.repo, 'repo_full_name');
    where.push(f.sql);
    params.push(f.param);
  }
  if (opts.sinceHours !== undefined) {
    where.push('run_started_at >= ?');
    params.push(new Date((opts.now ?? Date.now()) - opts.sinceHours * 3_600_000).toISOString());
  }
  const total = readAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM github_workflow_runs WHERE ${where.join(' AND ')}`, params)[0]?.n ?? 0;
  const rows = readAll<{
    id: string; repo_full_name: string; workflow_name: string | null; head_branch: string | null; event: string | null;
    conclusion: string | null; run_number: number | null; run_started_at: string | null; html_url: string | null;
  }>(
    db,
    `SELECT id, repo_full_name, workflow_name, head_branch, event, conclusion, run_number, run_started_at, html_url
     FROM github_workflow_runs WHERE ${where.join(' AND ')} ORDER BY run_started_at DESC LIMIT ?`,
    [...params, limit],
  );
  return {
    ok: true,
    value: page(total, rows.map((r) => ({
      id: r.id,
      repoFullName: r.repo_full_name,
      workflowName: r.workflow_name,
      headBranch: r.head_branch,
      event: r.event,
      conclusion: r.conclusion,
      runNumber: r.run_number,
      runStartedAt: r.run_started_at,
      htmlUrl: r.html_url,
    }))),
  };
}

// ── PR readiness ──────────────────────────────────────────────────────────────

export interface TriagePrReadiness {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  ready: boolean;
  waitingOn: string | null;
  checkedAt: string;
}

export interface TriagePrReadinessOptions {
  repo?: string;
  /** true: only ready PRs, false: only PRs still waiting, undefined: both. */
  ready?: boolean;
  limit?: number;
}

export function triagePrReadiness(db: SqlJsDatabase, opts: TriagePrReadinessOptions = {}): TriageResult<Page<TriagePrReadiness>> {
  if (!hasTable(db, 'pr_readiness')) return missingTable('pr_readiness', 'PR readiness');
  const limit = clampLimit(opts.limit);
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (opts.repo) {
    if (!repoOrOwnerKnown(db, opts.repo, [['pr_readiness', 'repo_full_name']])) return unknownRepo(opts.repo);
    const f = repoFilter(opts.repo, 'repo_full_name');
    where.push(f.sql);
    params.push(f.param);
  }
  if (opts.ready !== undefined) {
    where.push('ready = ?');
    params.push(opts.ready ? 1 : 0);
  }
  const total = readAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM pr_readiness WHERE ${where.join(' AND ')}`, params)[0]?.n ?? 0;
  const rows = readAll<{
    repo_full_name: string; pr_number: number; head_sha: string; ready: number; waiting_on: string | null; checked_at: string;
  }>(
    db,
    `SELECT repo_full_name, pr_number, head_sha, ready, waiting_on, checked_at
     FROM pr_readiness WHERE ${where.join(' AND ')} ORDER BY checked_at DESC LIMIT ?`,
    [...params, limit],
  );
  return {
    ok: true,
    value: page(total, rows.map((r) => ({
      repoFullName: r.repo_full_name,
      prNumber: r.pr_number,
      headSha: r.head_sha,
      ready: r.ready === 1,
      waitingOn: r.waiting_on,
      checkedAt: r.checked_at,
    }))),
  };
}

// ── Agent sessions ────────────────────────────────────────────────────────────

export interface TriageAgentSession {
  id: number;
  agentName: string | null;
  scopeType: string;
  scopeValue: string | null;
  status: string | null;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Short summary written by the agent (capped); raw results are never returned. */
  summary: string | null;
}

export interface TriageAgentSessionOptions {
  /** Look up one session by id (not found -> error). */
  id?: number;
  status?: string;
  /** Default false: only sessions that have not completed. */
  includeCompleted?: boolean;
  limit?: number;
}

const SUMMARY_CAP = 500;

export function triageAgentSessions(db: SqlJsDatabase, opts: TriageAgentSessionOptions = {}): TriageResult<Page<TriageAgentSession>> {
  if (!hasTable(db, 'agent_sessions')) return missingTable('agent_sessions', 'agent session');
  const limit = clampLimit(opts.limit);
  const cols = columns(db, 'agent_sessions');
  const hasDefs = hasTable(db, 'agent_definitions');
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (opts.id !== undefined) {
    where.push('s.id = ?');
    params.push(opts.id);
  } else {
    if (opts.status) {
      where.push('LOWER(COALESCE(s.status, \'\')) = ?');
      params.push(opts.status.toLowerCase());
    } else if (!opts.includeCompleted) {
      where.push("LOWER(COALESCE(s.status, '')) NOT IN ('completed', 'failed', 'cancelled', 'error')");
    }
  }
  const sel = (c: string) => (cols.has(c) ? `s.${c}` : 'NULL');
  const from = `agent_sessions s ${hasDefs ? 'LEFT JOIN agent_definitions d ON d.id = s.agent_id' : ''}`;
  const whereSql = where.join(' AND ');
  const total = readAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${from} WHERE ${whereSql}`, params)[0]?.n ?? 0;
  if (opts.id !== undefined && total === 0) return { ok: false, error: `Agent session ${opts.id} not found.` };
  const rows = readAll<{
    id: number; agent_name: string | null; scope_type: string; scope_value: string | null; status: string | null;
    provider: string | null; model: string | null; started_at: string | null; completed_at: string | null; summary: string | null;
  }>(
    db,
    `SELECT s.id AS id, ${hasDefs ? 'd.name' : 'NULL'} AS agent_name, s.scope_type AS scope_type, s.scope_value AS scope_value,
            s.status AS status, ${sel('provider')} AS provider, ${sel('model')} AS model,
            s.started_at AS started_at, s.completed_at AS completed_at, s.summary AS summary
     FROM ${from} WHERE ${whereSql} ORDER BY s.started_at DESC, s.id DESC LIMIT ?`,
    [...params, limit],
  );
  return {
    ok: true,
    value: page(total, rows.map((r) => ({
      id: r.id,
      agentName: r.agent_name,
      scopeType: r.scope_type,
      scopeValue: r.scope_value,
      status: r.status,
      provider: r.provider,
      model: r.model,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      summary: r.summary && r.summary.length > SUMMARY_CAP ? `${r.summary.slice(0, SUMMARY_CAP)}…` : r.summary,
    }))),
  };
}

// ── Usage samples ─────────────────────────────────────────────────────────────

export const USAGE_METRICS = ['github-oauth', 'github-pat', 'claude', 'copilot', 'github-api-calls'] as const;

export interface TriageUsageSample {
  metric: string;
  at: string;
  series: Record<string, { value: number; limit: number | null }>;
}

export interface TriageUsageOptions {
  metric?: string;
  /** Only samples from the last N hours. */
  sinceHours?: number;
  /** Samples per metric. Default 1 (the latest). */
  limit?: number;
  now?: number;
}

export function triageUsage(db: SqlJsDatabase, opts: TriageUsageOptions = {}): TriageResult<{ samples: TriageUsageSample[]; truncated: boolean }> {
  if (!hasTable(db, 'usage_samples')) return missingTable('usage_samples', 'usage');
  if (opts.metric && !(USAGE_METRICS as readonly string[]).includes(opts.metric)) {
    return { ok: false, error: `Unknown usage metric "${opts.metric}". Valid metrics: ${USAGE_METRICS.join(', ')}.` };
  }
  if (opts.sinceHours !== undefined && !(opts.sinceHours > 0)) return { ok: false, error: 'sinceHours must be a positive number.' };
  const per = Math.min(Math.max(Math.trunc(opts.limit ?? 1), 1), 100);
  const metrics = opts.metric ? [opts.metric] : [...USAGE_METRICS];
  const samples: TriageUsageSample[] = [];
  let truncated = false;
  for (const metric of metrics) {
    const where = ['metric = ?'];
    const params: Array<string | number> = [metric];
    if (opts.sinceHours !== undefined) {
      where.push('at >= ?');
      params.push((opts.now ?? Date.now()) - opts.sinceHours * 3_600_000);
    }
    const rows = readAll<{ at: number; data: string }>(
      db,
      `SELECT at, data FROM usage_samples WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`,
      [...params, per + 1],
    );
    if (rows.length > per) truncated = true;
    for (const row of rows.slice(0, per)) {
      let parsed: Record<string, [number, number | null]> = {};
      try {
        const raw = JSON.parse(row.data) as unknown;
        if (raw && typeof raw === 'object') parsed = raw as Record<string, [number, number | null]>;
      } catch {
        continue; // skip an unreadable sample rather than failing the whole call
      }
      const series: TriageUsageSample['series'] = {};
      for (const [name, pair] of Object.entries(parsed)) {
        if (Array.isArray(pair) && typeof pair[0] === 'number') series[name] = { value: pair[0], limit: typeof pair[1] === 'number' ? pair[1] : null };
      }
      samples.push({ metric, at: new Date(row.at).toISOString(), series });
    }
  }
  if (opts.metric && samples.length === 0) {
    return { ok: false, error: `No usage samples recorded for metric "${opts.metric}"${opts.sinceHours ? ` in the last ${opts.sinceHours}h` : ''}.` };
  }
  return { ok: true, value: { samples, truncated } };
}

// ── Attention summary ─────────────────────────────────────────────────────────

export interface AttentionSection {
  total: number | null;
  /** Set when the section could not be computed (e.g. table missing in an older database). */
  unavailable?: string;
}

export interface AttentionSummary {
  unreadNotifications: AttentionSection;
  failedRunsLast24h: AttentionSection;
  prsReady: AttentionSection;
  prsWaiting: AttentionSection;
  openAgentSessions: AttentionSection;
}

function section<T>(r: TriageResult<Page<T>>): AttentionSection {
  return r.ok ? { total: r.value.total } : { total: null, unavailable: r.error };
}

/** Counts only; use the drill-down tools for the items. Never fails: missing sections are flagged. */
export function attentionSummary(db: SqlJsDatabase, now: number = Date.now()): AttentionSummary {
  return {
    unreadNotifications: section(triageNotifications(db, { limit: 1 })),
    failedRunsLast24h: section(triageFailedRuns(db, { sinceHours: 24, limit: 1, now })),
    prsReady: section(triagePrReadiness(db, { ready: true, limit: 1 })),
    prsWaiting: section(triagePrReadiness(db, { ready: false, limit: 1 })),
    openAgentSessions: section(triageAgentSessions(db, { limit: 1 })),
  };
}
