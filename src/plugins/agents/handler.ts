// ── Agents IPC handlers ───────────────────────────────────────────────────────
import { ipcMain, dialog } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { getConfigValue, saveDatabase } from '../../storage/database';
import { loadGitHubAuth, loadGitHubPat } from '../../services/github-oauth';
import {
  fetchAndStoreWorkflowData,
  getWorkflowSummaryForRepo,
  createGitHubIssue,
} from '../../services/github-workflows';
import { checkCopilotAssignable, assignCopilotToIssue } from '../../services/github-copilot';
import {
  listAgentDefinitions,
  getAgentDefinition,
  createAgentSession,
  getAgentSession,
  runAgentSession,
} from './runner';

/**
 * Compose the issue body handed to the Copilot coding agent. The agent works
 * entirely from this text, so it always includes the diagnosis plus the
 * failing workflow/step and run links from action_data — regardless of
 * whether the LLM-authored issue_body already mentioned them.
 */
function buildCopilotHandoffIssueBody(actionData: Record<string, unknown>): string {
  const diagnosis = (actionData.issue_body as string | undefined)?.trim() || '(no diagnosis text provided)';
  const workflowName = actionData.workflow_name as string | undefined;
  const failingStep = actionData.failing_step as string | undefined;
  const runUrls = (actionData.run_urls as string[] | undefined) ?? [];

  const sections = [diagnosis];
  if (workflowName || failingStep) {
    sections.push(
      [
        '## Failing workflow',
        workflowName ? `Workflow: \`${workflowName}\`` : null,
        failingStep ? `Step: \`${failingStep}\`` : null,
      ].filter(Boolean).join('\n'),
    );
  }
  if (runUrls.length > 0) {
    sections.push(['## Failing runs', ...runUrls.map((url) => `- ${url}`)].join('\n'));
  }
  sections.push(
    '---\n_This issue was created by Jarvis and assigned to the GitHub Copilot coding agent for an automated fix attempt._',
  );
  return sections.join('\n\n');
}

export function registerHandlers(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): void {
  // ── Agent definitions ─────────────────────────────────────────────────────

  ipcMain.handle('agents:list', () => {
    return listAgentDefinitions(db);
  });

  ipcMain.handle('agents:update', (_event, agentId: number, systemPrompt: string) => {
    if (typeof agentId !== 'number') return { ok: false, error: 'Invalid agentId' };
    if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) return { ok: false, error: 'Invalid systemPrompt' };
    db.run(
      `UPDATE agent_definitions SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?`,
      [systemPrompt, agentId],
    );
    saveDatabase();
    return { ok: true };
  });

  // ── Run an agent session ──────────────────────────────────────────────────

  ipcMain.handle(
    'agents:run',
    async (
      _event,
      agentId: number,
      scopeType: 'repo' | 'org' | 'global',
      scopeValue: string,
      workflowFilter?: string,
    ) => {
      if (typeof agentId !== 'number') return { ok: false, error: 'Invalid agentId' };
      if (!['repo', 'org', 'global'].includes(scopeType)) return { ok: false, error: 'Invalid scopeType' };
      if (typeof scopeValue !== 'string' || scopeValue.length === 0) return { ok: false, error: 'Invalid scopeValue' };
      if (workflowFilter !== undefined && typeof workflowFilter !== 'string') return { ok: false, error: 'Invalid workflowFilter' };

      const model = getConfigValue(db, 'selected_ollama_model');
      if (!model) return { ok: false, error: 'No Ollama model selected. Please select one in settings.' };

      const agentDef = getAgentDefinition(db, agentId);
      if (!agentDef) return { ok: false, error: `Agent definition ${agentId} not found` };

      const sessionId = createAgentSession(db, agentId, scopeType, scopeValue);
      saveDatabase();

      // Query cached workflow run count so the renderer can show it immediately
      let workflowRunCount = 0;
      if (scopeType === 'repo') {
        try {
          const countResult = db.exec(
            'SELECT COUNT(*) FROM github_workflow_runs WHERE repo_full_name = ?',
            [scopeValue],
          );
          workflowRunCount = (countResult[0]?.values[0]?.[0] as number) ?? 0;
        } catch { /* non-fatal */ }
      }

      // Notify the renderer immediately so it can show a "waiting for model" state
      // before the first token arrives (Ollama startup + context assembly can take seconds)
      getWindow()?.webContents.send('agent:session-starting', {
        sessionId,
        agentName: agentDef.name,
        scopeType,
        scopeValue,
        workflowRunCount,
        workflowFilter: workflowFilter ?? null,
      });

      // Fire and forget — results come back via agent:session-complete event
      void runAgentSession(db, sessionId, agentDef, scopeType, scopeValue, model, getWindow, workflowFilter).then(() => {
        saveDatabase();
      }).catch((err: unknown) => {
        console.error('[Agents] Session runner error:', err);
        saveDatabase();
      });

      return { sessionId };
    },
  );

  // ── Session query ─────────────────────────────────────────────────────────

  ipcMain.handle('agents:get-session', (_event, sessionId: number) => {
    if (typeof sessionId !== 'number') return null;
    return getAgentSession(db, sessionId);
  });

  // ── Finding approval lifecycle ────────────────────────────────────────────

  ipcMain.handle('agents:approve-finding', (_event, findingId: number) => {
    if (typeof findingId !== 'number') return { ok: false };
    db.run(
      `UPDATE agent_findings SET approved = 1, approved_at = datetime('now') WHERE id = ?`,
      [findingId],
    );
    saveDatabase();
    return { ok: true };
  });

  ipcMain.handle('agents:reject-finding', (_event, findingId: number) => {
    if (typeof findingId !== 'number') return { ok: false };
    db.run(
      `UPDATE agent_findings SET approved = 0, approved_at = datetime('now') WHERE id = ?`,
      [findingId],
    );
    saveDatabase();
    return { ok: true };
  });

  // ── Execute an approved finding's action ──────────────────────────────────

  ipcMain.handle('agents:execute-finding', async (_event, findingId: number) => {
    if (typeof findingId !== 'number') return { ok: false, error: 'Invalid findingId' };

    const stmt = db.prepare(
      `SELECT f.id, f.action_type, f.action_data, f.approved, f.executed_at,
              s.scope_value AS repo_full_name
       FROM agent_findings f
       JOIN agent_sessions s ON s.id = f.session_id
       WHERE f.id = ?`,
    );
    stmt.bind([findingId]);
    if (!stmt.step()) { stmt.free(); return { ok: false, error: 'Finding not found' }; }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();

    if (row.approved !== 1) return { ok: false, error: 'Finding not approved' };
    if (row.executed_at) return { ok: false, error: 'Finding already executed' };

    const actionType = row.action_type as string;
    const actionData = row.action_data
      ? (JSON.parse(row.action_data as string) as Record<string, unknown>)
      : {};
    const repoFullName = row.repo_full_name as string;

    try {
      if (actionType === 'close_notifications') {
        const auth = loadGitHubAuth(db);
        if (!auth) return { ok: false, error: 'Not authenticated with GitHub' };
        const ids = (actionData.notification_ids as string[] | undefined) ?? [];
        const dismissed: string[] = [];
        const errors: string[] = [];
        for (const id of ids) {
          try {
            const resp = await fetch(`https://api.github.com/notifications/threads/${id}`, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            });
            if (!resp.ok && resp.status !== 404) {
              errors.push(`${id}: HTTP ${resp.status}`);
            } else {
              db.run('DELETE FROM github_notifications WHERE id = ?', [id]);
              dismissed.push(id);
            }
          } catch (e) {
            errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
            console.warn(`[Agents] Could not mark notification ${id} read:`, e);
          }
        }
        if (errors.length > 0) {
          console.warn('[Agents] close_notifications partial errors:', errors);
        }
        // Mark executed and return dismissed IDs so renderer can update its lists
        db.run(
          `UPDATE agent_findings SET executed_at = datetime('now'), execution_error = ? WHERE id = ?`,
          [errors.length > 0 ? errors.join(', ') : null, findingId],
        );
        saveDatabase();
        return { ok: true, dismissedIds: dismissed };
      } else if (actionType === 'create_issue') {
        const auth = loadGitHubAuth(db);
        if (!auth) return { ok: false, error: 'Not authenticated with GitHub' };
        const title = (actionData.issue_title as string | undefined) ?? 'Issue from Jarvis agent';
        const body = (actionData.issue_body as string | undefined) ?? '';
        const labels = (actionData.issue_labels as string[] | undefined) ?? [];
        await createGitHubIssue(auth.accessToken, repoFullName, title, body, labels);
      } else if (actionType === 'assign_copilot') {
        const auth = loadGitHubAuth(db);
        if (!auth) return { ok: false, error: 'Not authenticated with GitHub' };

        const availability = await checkCopilotAssignable(auth.accessToken, repoFullName);
        if (!availability.available) {
          const detail = availability.detail ? ` — ${availability.detail}` : '';
          const message = availability.reason === 'not_enabled_or_no_seat'
            ? 'Copilot coding agent is not assignable for this repository. Enable the coding agent for ' +
              'this repository/organization in GitHub Copilot settings, and make sure your GitHub account ' +
              'holds a Copilot Pro, Pro+, Business, or Enterprise seat.'
            : availability.reason === 'repo_not_found_or_no_access'
              ? `The authenticated GitHub account cannot access ${repoFullName} — check org OAuth app approval and repo permissions.`
              : `Could not verify Copilot coding agent availability for ${repoFullName}${detail}.`;
          throw new Error(message);
        }

        const title = (actionData.issue_title as string | undefined) ?? 'Workflow failure diagnosed by Jarvis';
        const labels = (actionData.issue_labels as string[] | undefined) ?? [];
        const body = buildCopilotHandoffIssueBody(actionData);
        const issue = await createGitHubIssue(auth.accessToken, repoFullName, title, body, labels);

        try {
          await assignCopilotToIssue(auth.accessToken, repoFullName, issue.node_id);
        } catch (assignErr) {
          const assignMsg = assignErr instanceof Error ? assignErr.message : String(assignErr);
          throw new Error(
            `Issue created (${issue.url}) but assigning Copilot coding agent failed: ${assignMsg}`,
            { cause: assignErr },
          );
        }
      } else if (actionType === 'clone_repo') {        const result = await dialog.showOpenDialog({
          title: `Select parent folder to clone ${repoFullName} into`,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, error: 'No folder selected — clone cancelled' };
        }
        const parentDir = result.filePaths[0];
        const repoName = repoFullName.split('/').pop() ?? repoFullName;
        const cloneUrl = `https://github.com/${repoFullName}.git`;
        const destDir = path.join(parentDir, repoName);
        await new Promise<void>((resolve, reject) => {
          execFile('git', ['clone', cloneUrl, destDir], (err) => {
            if (err) reject(new Error(`git clone failed: ${err.message}`));
            else resolve();
          });
        });
      } else {
        return { ok: false, error: `Unknown action type: ${actionType}` };
      }

      db.run(
        `UPDATE agent_findings SET executed_at = datetime('now'), execution_error = NULL WHERE id = ?`,
        [findingId],
      );
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.run(
        `UPDATE agent_findings SET execution_error = ? WHERE id = ?`,
        [message, findingId],
      );
      saveDatabase();
      return { ok: false, error: message };
    }
  });

  // ── Copilot coding agent handoff — preflight capability check ──────────────
  // Lets the UI disable the "assign Copilot" action with a concrete reason
  // instead of offering a button that would always fail.

  ipcMain.handle('agents:check-copilot-availability', async (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) {
      return { available: false, reason: 'api_error', detail: 'Invalid repo name' };
    }
    const auth = loadGitHubAuth(db);
    if (!auth) return { available: false, reason: 'not_authenticated' };
    return checkCopilotAssignable(auth.accessToken, repoFullName);
  });

  // ── Workflow data fetching ────────────────────────────────────────────────

  ipcMain.handle('github:fetch-workflow-runs', async (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) {
      return { ok: false, error: 'Invalid repo name' };
    }
    const auth = loadGitHubAuth(db);
    if (!auth) return { ok: false, error: 'Not authenticated with GitHub' };
    const pat = loadGitHubPat(db);
    try {
      const { runsStored } = await fetchAndStoreWorkflowData(db, auth.accessToken, repoFullName);
      saveDatabase();
      return { ok: true, count: runsStored };
    } catch (err) {
      // GitHub returns 403 when OAuth app is blocked by the org, 404 for private repos
      // the token can't access. Retry with PAT when available.
      if (pat && err instanceof Error && /GitHub API error (403|404):/.test(err.message)) {
        try {
          const { runsStored } = await fetchAndStoreWorkflowData(db, pat, repoFullName);
          saveDatabase();
          return { ok: true, count: runsStored };
        } catch (patErr) {
          return { ok: false, error: patErr instanceof Error ? patErr.message : String(patErr) };
        }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('github:get-workflow-summary', (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || repoFullName.length === 0) {
      return { repo_full_name: repoFullName, total_runs: 0, recent_runs: [], jobs_by_run: {} };
    }
    return getWorkflowSummaryForRepo(db, repoFullName);
  });

  ipcMain.handle('github:get-cached-workflow-info', (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || repoFullName.length === 0) {
      return { fetchedAt: null, runCount: 0 };
    }
    const result = db.exec(
      `SELECT MAX(fetched_at) AS latest, COUNT(*) AS cnt FROM github_workflow_runs WHERE repo_full_name = ?`,
      [repoFullName],
    );
    const row = result[0]?.values[0];
    return {
      fetchedAt: (row?.[0] as string | null) ?? null,
      runCount: (row?.[1] as number) ?? 0,
    };
  });
}
