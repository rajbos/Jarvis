// ── Agent session runner ──────────────────────────────────────────────────────
// Assembles context, runs it through an analysis provider (Ollama by default,
// or the Claude Agent SDK escalation tier), parses structured findings, and
// persists them to the database.
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { getWorkflowSummaryForRepo } from '../../services/github-workflows';
import { resolveLocalRepoPath, resolveEscalationRunInfo } from '../../services/claude-agent';
import { ollamaProvider } from './providers/ollama-provider';
import type { AgentProvider, AgentRunOptions } from './providers/types';
import type { AgentDefinition, AgentFinding, AgentSession, WorkflowRun, WorkflowJob } from '../types';
import type { RawFinding } from './json-extract';

export { extractJsonResult } from './json-extract';
export type { RawFinding, AgentJsonResult } from './json-extract';

// ── DB helpers ────────────────────────────────────────────────────────────────

export function listAgentDefinitions(db: SqlJsDatabase): AgentDefinition[] {
  const stmt = db.prepare(
    'SELECT id, name, description, system_prompt, tools_allowed, created_at, updated_at FROM agent_definitions ORDER BY id ASC',
  );
  const rows: AgentDefinition[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as AgentDefinition);
  stmt.free();
  return rows;
}

export function getAgentDefinition(db: SqlJsDatabase, agentId: number): AgentDefinition | null {
  const stmt = db.prepare(
    'SELECT id, name, description, system_prompt, tools_allowed, created_at, updated_at FROM agent_definitions WHERE id = ?',
  );
  stmt.bind([agentId]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject() as unknown as AgentDefinition;
  stmt.free();
  return row;
}

export interface CreateAgentSessionOptions {
  provider?: string;
  model?: string | null;
  parentSessionId?: number | null;
}

export function createAgentSession(
  db: SqlJsDatabase,
  agentId: number,
  scopeType: string,
  scopeValue: string,
  options: CreateAgentSessionOptions = {},
): number {
  const { provider = 'ollama', model = null, parentSessionId = null } = options;
  db.run(
    `INSERT INTO agent_sessions (agent_id, scope_type, scope_value, status, started_at, provider, model, parent_session_id)
     VALUES (?, ?, ?, 'running', datetime('now'), ?, ?, ?)`,
    [agentId, scopeType, scopeValue, provider, model, parentSessionId],
  );
  const result = db.exec('SELECT last_insert_rowid() AS id');
  return result[0].values[0][0] as number;
}

export function updateAgentSession(
  db: SqlJsDatabase,
  sessionId: number,
  status: string,
  summary: string | null,
  rawResult: string | null,
): void {
  db.run(
    `UPDATE agent_sessions
     SET status = ?, summary = ?, raw_result = ?, completed_at = datetime('now')
     WHERE id = ?`,
    [status, summary, rawResult, sessionId],
  );
}

export function storeAgentFinding(
  db: SqlJsDatabase,
  sessionId: number,
  finding: RawFinding,
): number {
  const toStr = (v: unknown): string | null =>
    v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);

  db.run(
    `INSERT INTO agent_findings
      (session_id, finding_type, subject, reason, pattern, action_type, action_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      toStr(finding.finding_type) ?? 'investigate',
      toStr(finding.subject),
      toStr(finding.reason),
      toStr(finding.pattern),
      toStr(finding.action_type) ?? 'none',
      finding.action_data ? JSON.stringify(finding.action_data) : null,
    ],
  );
  const result = db.exec('SELECT last_insert_rowid() AS id');
  return result[0].values[0][0] as number;
}

export function getAgentSession(db: SqlJsDatabase, sessionId: number): AgentSession | null {
  const sessionStmt = db.prepare(`
    SELECT s.id, s.agent_id, d.name AS agent_name, s.scope_type, s.scope_value,
           s.status, s.started_at, s.completed_at, s.summary,
           s.provider, s.model, s.parent_session_id
    FROM agent_sessions s
    JOIN agent_definitions d ON d.id = s.agent_id
    WHERE s.id = ?
  `);
  sessionStmt.bind([sessionId]);
  if (!sessionStmt.step()) { sessionStmt.free(); return null; }
  const sessionRow = sessionStmt.getAsObject() as Record<string, unknown>;
  sessionStmt.free();

  const findingStmt = db.prepare(`
    SELECT id, session_id, finding_type, subject, reason, pattern,
           action_type, action_data, approved, approved_at, executed_at, execution_error
    FROM agent_findings WHERE session_id = ? ORDER BY id ASC
  `);
  findingStmt.bind([sessionId]);
  const findings: AgentFinding[] = [];
  while (findingStmt.step()) {
    const f = findingStmt.getAsObject() as Record<string, unknown>;
    findings.push({
      id: f.id as number,
      session_id: f.session_id as number,
      finding_type: f.finding_type as AgentFinding['finding_type'],
      subject: f.subject as string,
      reason: f.reason as string,
      pattern: f.pattern as string | null,
      action_type: f.action_type as AgentFinding['action_type'],
      action_data: f.action_data ? (JSON.parse(f.action_data as string) as Record<string, unknown>) : null,
      approved: f.approved as number | null,
      approved_at: f.approved_at as string | null,
      executed_at: f.executed_at as string | null,
      execution_error: f.execution_error as string | null,
    });
  }
  findingStmt.free();

  return {
    id: sessionRow.id as number,
    agent_id: sessionRow.agent_id as number,
    agent_name: sessionRow.agent_name as string,
    scope_type: sessionRow.scope_type as AgentSession['scope_type'],
    scope_value: sessionRow.scope_value as string,
    status: sessionRow.status as AgentSession['status'],
    started_at: sessionRow.started_at as string,
    completed_at: sessionRow.completed_at as string | null,
    summary: sessionRow.summary as string | null,
    findings,
    provider: (sessionRow.provider as string | null) ?? 'ollama',
    model: sessionRow.model as string | null,
    parent_session_id: sessionRow.parent_session_id as number | null,
  };
}

// ── Context assembly ──────────────────────────────────────────────────────────

// Per-job budget for log excerpt text in the assembled agent context. The
// stored excerpt is already sliced to the failing step (or a head+tail
// fallback) by fetchAndStoreWorkflowData, so this just bounds how much of
// that relevant text goes into any single job's context entry.
const MAX_LOG_EXCERPT_CONTEXT_CHARS = 4000;

function buildNotificationContext(db: SqlJsDatabase, repoFullName: string, workflowFilter?: string): string {
  let sql = `
    SELECT id, subject_type, subject_title, subject_url, reason, updated_at
    FROM github_notifications
    WHERE repo_full_name = ? AND unread = 1`;
  const params: unknown[] = [repoFullName];
  if (workflowFilter) {
    sql += ` AND subject_title = ?`;
    params.push(workflowFilter);
  }
  sql += ` ORDER BY updated_at DESC`;
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const header = workflowFilter
    ? `=== NOTIFICATIONS (repo: ${repoFullName}, workflow: "${workflowFilter}") ===`
    : `=== NOTIFICATIONS (repo: ${repoFullName}) ===`;
  const lines: string[] = [header];
  let count = 0;
  while (stmt.step()) {
    const n = stmt.getAsObject() as Record<string, unknown>;
    lines.push(
      `[${n.id}] ${n.subject_type}: "${n.subject_title}" | reason: ${n.reason} | updated: ${n.updated_at}`,
    );
    count++;
  }
  stmt.free();
  if (count === 0) lines.push('(no unread notifications)');
  return lines.join('\n');
}

function buildWorkflowContext(db: SqlJsDatabase, repoFullName: string): string {
  const summary = getWorkflowSummaryForRepo(db, repoFullName);
  if (summary.total_runs === 0) {
    return '=== WORKFLOW RUNS ===\n(no workflow run data cached — run "Fetch Workflow Data" first)';
  }

  // Group by workflow name
  const byWorkflow = new Map<string, WorkflowRun[]>();
  for (const run of summary.recent_runs) {
    const name = run.workflow_name ?? 'unknown';
    if (!byWorkflow.has(name)) byWorkflow.set(name, []);
    byWorkflow.get(name)!.push(run);
  }

  const lines: string[] = [`=== WORKFLOW RUNS (last 7 days, ${summary.total_runs} total) ===`];
  for (const [workflowName, runs] of byWorkflow) {
    lines.push(`\n-- Workflow: ${workflowName} --`);
    for (const run of runs.slice(0, 10)) {
      const jobs = summary.jobs_by_run[run.id] ?? [];
      const jobSummary = jobs.length > 0
        ? jobs.map((j: WorkflowJob) => `  Job "${j.name}": ${j.conclusion ?? j.status}`).join('\n')
        : '  (no job details cached)';
      lines.push(
        `Run #${run.run_number} | ${run.head_branch} | ${run.conclusion ?? run.status} | ${run.run_started_at}`,
      );
      lines.push(jobSummary);
      for (const job of jobs) {
        if (job.error_highlights) {
          lines.push(`  Error highlights for "${job.name}":\n${job.error_highlights}`);
        }
        if (job.log_excerpt) {
          const stepLabel = job.failing_step_name ? ` (failing step: "${job.failing_step_name}")` : '';
          const excerpt = job.log_excerpt.length > MAX_LOG_EXCERPT_CONTEXT_CHARS
            ? job.log_excerpt.slice(0, MAX_LOG_EXCERPT_CONTEXT_CHARS)
            : job.log_excerpt;
          lines.push(`  Log excerpt for "${job.name}"${stepLabel}:\n${excerpt}`);
        }
      }
    }
  }
  return lines.join('\n');
}

function buildLocalRepoContext(db: SqlJsDatabase, repoFullName: string): string {
  const localPath = resolveLocalRepoPath(db, repoFullName);
  return `=== LOCAL REPO ===\n${localPath ? `Cloned at: ${localPath}` : 'Not cloned locally'}`;
}

// The commit range worth diffing: the last known-good run and the first run
// in the currently failing streak. Deliberately not pre-fetching diffs or
// logs here — a provider with repo access (the Claude Agent SDK escalation
// tier) can read them itself; a text-only provider just gets the SHAs.
function buildFailureRangeContext(db: SqlJsDatabase, repoFullName: string, workflowFilter?: string): string {
  const info = resolveEscalationRunInfo(db, repoFullName, workflowFilter);
  if (!info.firstFailureHeadSha) {
    return '=== FAILURE COMMIT RANGE ===\n(no active failing streak found in cached workflow run history)';
  }
  const lines = ['=== FAILURE COMMIT RANGE ==='];
  if (info.workflowName) lines.push(`Workflow: ${info.workflowName}`);
  lines.push(`First failing run: #${info.firstFailureRunNumber ?? '?'} @ ${info.firstFailureHeadSha}`);
  lines.push(
    info.lastSuccessHeadSha
      ? `Last known-good commit: ${info.lastSuccessHeadSha}`
      : 'Last known-good commit: unknown (no successful run found before the failing streak in cached history)',
  );
  if (info.htmlUrl) lines.push(`Latest run URL: ${info.htmlUrl}`);
  return lines.join('\n');
}

// ── Main agent session runner ─────────────────────────────────────────────────

/**
 * Run an agent session: assemble context, run it through an analysis
 * provider (Ollama by default), parse findings, persist results, and push
 * progress events to the renderer window.
 */
export async function runAgentSession(
  db: SqlJsDatabase,
  sessionId: number,
  agentDef: AgentDefinition,
  scopeType: 'repo' | 'org' | 'global',
  scopeValue: string,
  model: string,
  getWindow: () => BrowserWindow | null,
  workflowFilter?: string,
  provider: AgentProvider = ollamaProvider,
  providerOptions?: AgentRunOptions,
): Promise<void> {
  const win = getWindow();

  try {
    // Assemble context
    const notifContext = scopeType === 'repo'
      ? buildNotificationContext(db, scopeValue, workflowFilter)
      : '(N/A for non-repo scope)';
    const workflowContext = scopeType === 'repo'
      ? buildWorkflowContext(db, scopeValue)
      : '(N/A for non-repo scope)';
    const localRepoContext = scopeType === 'repo'
      ? buildLocalRepoContext(db, scopeValue)
      : '(N/A for non-repo scope)';
    const failureRangeContext = scopeType === 'repo'
      ? buildFailureRangeContext(db, scopeValue, workflowFilter)
      : '(N/A for non-repo scope)';

    const userMessage = [notifContext, workflowContext, localRepoContext, failureRangeContext].join('\n\n');

    // Emit debug context so the renderer can show it in the chat debug viewer
    getWindow()?.webContents.send('agent:debug-context', {
      sessionId,
      systemPrompt: agentDef.system_prompt,
      userMessage,
    });

    const outcome = await provider.run(
      model,
      agentDef.system_prompt,
      userMessage,
      {
        onToken: (token) => getWindow()?.webContents.send('agent:token', token),
        onAnalysisComplete: () => getWindow()?.webContents.send('agent:analysis-complete', { sessionId }),
        onFindingsError: (message) => getWindow()?.webContents.send('agent:phase2-error', { sessionId, message }),
      },
      providerOptions,
    );

    for (const finding of outcome.findings) {
      storeAgentFinding(db, sessionId, finding);
    }

    updateAgentSession(db, sessionId, 'completed', outcome.summary, outcome.analysisText);

    getWindow()?.webContents.send('agent:session-complete', { sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateAgentSession(db, sessionId, 'failed', null, message);
    win?.webContents.send('agent:session-error', { sessionId, message });
  }
}
