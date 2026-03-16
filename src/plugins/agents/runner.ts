// ── Agent session runner ──────────────────────────────────────────────────────
// Assembles context, calls Ollama via streamChat, parses structured findings,
// and persists them to the database.
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { streamChat } from '../../services/ollama';
import { getWorkflowSummaryForRepo } from '../../services/github-workflows';
import type { AgentDefinition, AgentFinding, AgentSession, WorkflowRun, WorkflowJob } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawFinding {
  subject?: string;
  finding_type?: string;
  reason?: string;
  pattern?: string | null;
  action_type?: string;
  action_data?: Record<string, unknown>;
}

interface AgentJsonResult {
  summary?: string;
  findings?: RawFinding[];
}

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

export function createAgentSession(
  db: SqlJsDatabase,
  agentId: number,
  scopeType: string,
  scopeValue: string,
): number {
  db.run(
    `INSERT INTO agent_sessions (agent_id, scope_type, scope_value, status, started_at)
     VALUES (?, ?, ?, 'running', datetime('now'))`,
    [agentId, scopeType, scopeValue],
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
           s.status, s.started_at, s.completed_at, s.summary
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
  };
}

// ── Context assembly ──────────────────────────────────────────────────────────

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
        if (job.log_excerpt) {
          lines.push(`  Log excerpt for "${job.name}":\n${job.log_excerpt.slice(0, 500)}`);
        }
      }
    }
  }
  return lines.join('\n');
}

function buildLocalRepoContext(db: SqlJsDatabase, repoFullName: string): string {
  const stmt = db.prepare(`
    SELECT lr.local_path
    FROM local_repos lr
    JOIN local_repo_remotes lrr ON lrr.local_repo_id = lr.id
    JOIN github_repos gr ON gr.id = lrr.github_repo_id
    WHERE gr.full_name = ?
    LIMIT 1
  `);
  stmt.bind([repoFullName]);
  const exists = stmt.step();
  const row = exists ? (stmt.getAsObject() as { local_path: string }) : null;
  stmt.free();

  return `=== LOCAL REPO ===\n${row ? `Cloned at: ${row.local_path}` : 'Not cloned locally'}`;
}

// ── JSON extraction ───────────────────────────────────────────────────────────

/**
 * Extract the first ```json ... ``` block from the agent response.
 * Returns null if none found or JSON is invalid.
 */
export function extractJsonResult(text: string): AgentJsonResult | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as AgentJsonResult;
  } catch {
    return null;
  }
}

// ── Main agent session runner ─────────────────────────────────────────────────

/**
 * Run an agent session: assemble context, stream to Ollama, parse findings,
 * persist results, and push progress events to the renderer window.
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

    const userMessage = [notifContext, workflowContext, localRepoContext].join('\n\n');

    // Emit debug context so the renderer can show it in the chat debug viewer
    getWindow()?.webContents.send('agent:debug-context', {
      sessionId,
      systemPrompt: agentDef.system_prompt,
      userMessage,
    });

    // ── Phase 1: stream the analysis / reasoning to the renderer ────────────
    let analysisResponse = '';
    await streamChat(
      model,
      [
        { role: 'system', content: agentDef.system_prompt },
        { role: 'user', content: userMessage },
      ],
      (token) => {
        analysisResponse += token;
        getWindow()?.webContents.send('agent:token', token);
      },
    );

    // Signal the renderer that phase 1 is done so it can show a separator
    getWindow()?.webContents.send('agent:analysis-complete', { sessionId });

    // ── Phase 2: second call — emit ONLY the structured JSON ─────────────────
    // Pass the phase-1 response back as the assistant turn so the model has
    // full context, then ask it to output nothing but the JSON block.
    // A 60-second timeout guards against the model hanging indefinitely.
    const PHASE2_TIMEOUT_MS = 60_000;
    let jsonResponse = '';
    const phase2Controller = new AbortController();
    const phase2Timer = setTimeout(() => phase2Controller.abort(), PHASE2_TIMEOUT_MS);
    try {
      await streamChat(
        model,
        [
          { role: 'system', content: agentDef.system_prompt },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: analysisResponse },
          {
            role: 'user',
            content:
              'Based on your analysis above, output ONLY the JSON findings code block — no prose, no explanation. ' +
              'Start with ```json and end with ```. Nothing else.',
          },
        ],
        (token) => { jsonResponse += token; },
        phase2Controller.signal,
      );
    } catch (phase2Err) {
      const isTimeout = phase2Controller.signal.aborted;
      const phase2Msg = isTimeout
        ? 'Phase 2 timed out after 60 s — could not extract structured findings'
        : (phase2Err instanceof Error ? phase2Err.message : String(phase2Err));
      console.warn('[Agents] Phase 2 failed:', phase2Msg);
      getWindow()?.webContents.send('agent:phase2-error', { sessionId, message: phase2Msg });
      // Fall through — extractJsonResult will be tried on whatever partial response was received,
      // then fall back to phase-1 text before giving up.
    } finally {
      clearTimeout(phase2Timer);
    }

    // Parse findings from the dedicated JSON response; fall back to phase-1
    // in case the model puts it there anyway (backwards-compat).
    const parsed = extractJsonResult(jsonResponse) ?? extractJsonResult(analysisResponse);
    const summary = parsed?.summary ?? analysisResponse.slice(0, 300);

    if (parsed?.findings && Array.isArray(parsed.findings)) {
      for (const finding of parsed.findings) {
        storeAgentFinding(db, sessionId, finding);
      }
    }

    updateAgentSession(db, sessionId, 'completed', summary, analysisResponse);

    getWindow()?.webContents.send('agent:session-complete', { sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateAgentSession(db, sessionId, 'failed', null, message);
    win?.webContents.send('agent:session-error', { sessionId, message });
  }
}
