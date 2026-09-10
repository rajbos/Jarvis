// ── Claude Agent SDK escalation service ──────────────────────────────────────
//
// Drives the `claude` CLI in headless print mode (`-p --output-format
// stream-json`) as a read-only investigator over a repo's local clone. This
// is the "deep dive" tier: unlike the local Ollama tier, which only reasons
// over a pre-assembled text blob, this tier gets a real agentic loop with
// the checkout as its working directory — it can read workflow YAML, walk
// git history, and pull logs on demand.
//
// Auth is whatever the `claude` CLI already has on disk (the same
// ~/.claude/.credentials.json that getClaudeCredentialsPath() reads) — we
// never pass a token on the command line and never add a second credential
// store.
//
// Tool access is restricted by construction, not by prompt instructions:
// --tools pins the loaded tool set to Read/Grep/Glob/Bash, --restricted
// additionally confines the file tools to the working directory, and
// --allowedTools/--disallowedTools narrow Bash to read-only git
// inspection commands. A process spawned this way cannot write files or run
// arbitrary shell even if the model is coaxed into trying.
import { spawn } from 'child_process';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { RawFinding } from '../plugins/types';

// ── CLI availability ─────────────────────────────────────────────────────────

export interface ClaudeCliAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

let cachedAvailability: ClaudeCliAvailability | null = null;

/**
 * Detect whether the `claude` CLI is installed and reachable on PATH.
 * Jarvis ships as an installed Electron app on machines that may not have
 * Claude Code installed, so this must degrade cleanly rather than throw.
 * Result is cached for the process lifetime; pass force to re-probe (tests,
 * or after the user reports installing the CLI).
 */
export async function detectClaudeCli(force = false): Promise<ClaudeCliAvailability> {
  if (cachedAvailability && !force) return cachedAvailability;

  cachedAvailability = await new Promise<ClaudeCliAvailability>((resolve) => {
    let settled = false;
    let stdout = '';
    let child;
    try {
      child = spawn('claude', ['--version'], { shell: process.platform === 'win32' });
    } catch (err) {
      resolve({ available: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ available: false, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ available: true, version: stdout.trim() });
      else resolve({ available: false, error: `claude --version exited with code ${code ?? 'null'}` });
    });
  });

  return cachedAvailability;
}

/** Test-only: clear the cached CLI availability probe. */
export function resetClaudeCliAvailabilityCache(): void {
  cachedAvailability = null;
}

// ── Local clone lookup ────────────────────────────────────────────────────────

/**
 * Resolve the local clone path for a repo, if Jarvis has one linked.
 * Shared by the agent runner's text-context assembly (buildLocalRepoContext)
 * and the escalation gate (no clone ⇒ no escalation, since the whole point
 * of this tier is repo access).
 */
export function resolveLocalRepoPath(db: SqlJsDatabase, repoFullName: string): string | null {
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
  return row?.local_path ?? null;
}

// ── Failing commit range ──────────────────────────────────────────────────────

export interface EscalationRunInfo {
  workflowName: string | null;
  lastSuccessHeadSha: string | null;
  firstFailureHeadSha: string | null;
  firstFailureRunNumber: number | null;
  htmlUrl: string | null;
}

const EMPTY_RUN_INFO: EscalationRunInfo = {
  workflowName: null,
  lastSuccessHeadSha: null,
  firstFailureHeadSha: null,
  firstFailureRunNumber: null,
  htmlUrl: null,
};

/**
 * Find the last known-good run and the first run of the current failing
 * streak for a workflow, from cached run history. This gives the escalation
 * tier a commit range to diff instead of a wall of pre-truncated log text —
 * it can read the actual diff and logs itself.
 */
export function resolveEscalationRunInfo(
  db: SqlJsDatabase,
  repoFullName: string,
  workflowFilter?: string,
): EscalationRunInfo {
  let sql = `
    SELECT workflow_name, head_sha, run_number, conclusion, run_started_at, html_url
    FROM github_workflow_runs
    WHERE repo_full_name = ?`;
  const params: unknown[] = [repoFullName];
  if (workflowFilter) {
    sql += ' AND workflow_name = ?';
    params.push(workflowFilter);
  }
  sql += ' ORDER BY run_started_at DESC';

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const runs: Array<Record<string, unknown>> = [];
  while (stmt.step()) runs.push(stmt.getAsObject());
  stmt.free();

  if (runs.length === 0) return { ...EMPTY_RUN_INFO, workflowName: workflowFilter ?? null };

  // runs[0] is the most recent run. If it isn't currently failing there is no
  // active streak to diff.
  if (runs[0].conclusion !== 'failure') {
    return { ...EMPTY_RUN_INFO, workflowName: (runs[0].workflow_name as string | null) ?? workflowFilter ?? null };
  }

  // Walk backwards (older) while the streak of failures continues, to find
  // the first run of the current failing streak.
  let i = 0;
  while (i + 1 < runs.length && runs[i + 1].conclusion === 'failure') i++;
  const firstFailure = runs[i];
  const lastSuccess = runs.slice(i + 1).find((r) => r.conclusion === 'success') ?? null;

  return {
    workflowName: (firstFailure.workflow_name as string | null) ?? workflowFilter ?? null,
    lastSuccessHeadSha: (lastSuccess?.head_sha as string | null | undefined) ?? null,
    firstFailureHeadSha: (firstFailure.head_sha as string | null | undefined) ?? null,
    firstFailureRunNumber: (firstFailure.run_number as number | null | undefined) ?? null,
    htmlUrl: (runs[0].html_url as string | null | undefined) ?? null,
  };
}

// ── CLI invocation ────────────────────────────────────────────────────────────

export const DEFAULT_CLAUDE_AGENT_MODEL = 'claude-opus-5';

// Tool set loaded at all — nothing outside this list is even available to
// the model, regardless of what it asks for.
const READ_ONLY_TOOLS = 'Read,Grep,Glob,Bash';

// Bash is pinned to read-only, non-destructive git inspection commands.
// Everything else that would need a permission prompt is auto-denied (see
// --permission-prompts none below) rather than left to the model's judgment.
const ALLOWED_TOOL_PATTERNS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(cat:*)',
  'Bash(ls:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
];

// Defense in depth on top of --tools: even tool names that did load are
// explicitly denied here.
const DISALLOWED_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-paragraph root-cause summary.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding_type: { type: 'string', enum: ['ignore', 'investigate', 'action_required'] },
          subject: { type: 'string' },
          reason: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['finding_type', 'subject', 'reason'],
      },
    },
  },
  required: ['summary', 'findings'],
};

export interface ClaudeAgentQueryResult {
  analysisText: string;
  summary: string | null;
  findings: RawFinding[];
  costUsd?: number;
  isError: boolean;
  errorMessage?: string;
}

interface ClaudeStreamLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  structured_output?: { summary?: string; findings?: RawFinding[] };
}

/** Pure helper (exported for tests): parse one stream-json line, if it carries a text delta. */
export function extractTextDelta(line: string): string | null {
  let parsed: ClaudeStreamLine;
  try {
    parsed = JSON.parse(line) as ClaudeStreamLine;
  } catch {
    return null;
  }
  if (parsed.type !== 'stream_event') return null;
  if (parsed.event?.type !== 'content_block_delta') return null;
  if (parsed.event.delta?.type !== 'text_delta') return null;
  return typeof parsed.event.delta.text === 'string' ? parsed.event.delta.text : null;
}

/** Pure helper (exported for tests): parse one stream-json line as a terminal `result` message. */
export function parseResultLine(line: string): ClaudeStreamLine | null {
  let parsed: ClaudeStreamLine;
  try {
    parsed = JSON.parse(line) as ClaudeStreamLine;
  } catch {
    return null;
  }
  return parsed.type === 'result' ? parsed : null;
}

export interface RunClaudeAgentQueryOptions {
  model?: string;
  signal?: AbortSignal;
  /** Override for tests — defaults to the real `claude` binary on PATH. */
  claudeBin?: string;
}

/**
 * Run one headless Claude Agent SDK query against a repo checkout.
 * Streams assistant text via onToken; resolves with the final structured
 * findings (via --json-schema) once the CLI exits.
 */
export async function runClaudeAgentQuery(
  systemPrompt: string,
  userMessage: string,
  cwd: string,
  onToken: (token: string) => void,
  options: RunClaudeAgentQueryOptions = {},
): Promise<ClaudeAgentQueryResult> {
  const availability = await detectClaudeCli();
  if (!availability.available) {
    throw new Error(
      `Claude CLI not found on PATH — install Claude Code to use the Claude escalation tier` +
      `${availability.error ? ` (${availability.error})` : ''}.`,
    );
  }

  const model = options.model ?? DEFAULT_CLAUDE_AGENT_MODEL;
  const claudeBin = options.claudeBin ?? 'claude';

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--restricted',
    '--tools', READ_ONLY_TOOLS,
    '--allowedTools', ALLOWED_TOOL_PATTERNS.join(' '),
    '--disallowedTools', DISALLOWED_TOOLS.join(' '),
    '--permission-prompts', 'none',
    '--model', model,
    '--system-prompt', systemPrompt,
    '--json-schema', JSON.stringify(FINDINGS_JSON_SCHEMA),
    userMessage,
  ];

  return new Promise<ClaudeAgentQueryResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(claudeBin, args, {
        cwd,
        shell: process.platform === 'win32',
        env: process.env,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdoutBuffer = '';
    let stderrText = '';
    let analysisText = '';
    let lastResult: ClaudeStreamLine | null = null;
    let settled = false;

    const onAbort = () => { child.kill(); };
    options.signal?.addEventListener('abort', onAbort);

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const delta = extractTextDelta(line);
        if (delta) {
          analysisText += delta;
          onToken(delta);
          continue;
        }
        const result = parseResultLine(line);
        if (result) lastResult = result;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8'); });

    child.on('error', (err) => {
      settleReject(new Error(`Failed to launch claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);

      if (options.signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

      if (!lastResult) {
        reject(new Error(
          `Claude CLI exited (code ${code ?? 'null'}) without a result` +
          `${stderrText ? `: ${stderrText.slice(0, 500)}` : ''}`,
        ));
        return;
      }

      const isError = Boolean(lastResult.is_error);
      const resultText = typeof lastResult.result === 'string' ? lastResult.result : analysisText;
      const structured = lastResult.structured_output;

      resolve({
        analysisText: analysisText || resultText,
        summary: structured?.summary ?? resultText.slice(0, 300) ?? null,
        findings: Array.isArray(structured?.findings) ? structured.findings : [],
        costUsd: typeof lastResult.total_cost_usd === 'number' ? lastResult.total_cost_usd : undefined,
        isError,
        errorMessage: isError ? resultText : undefined,
      });
    });
  });
}
