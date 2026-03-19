# Notification Intelligence & Agent Framework

> **Status**: Planning → Implementation
> **Goal**: Detect notifications that require action, use LLM agents to analyze them, and present human-in-the-loop approval for any resulting actions.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Current State Analysis](#2-current-state-analysis)
3. [Missing Data in the Database](#3-missing-data-in-the-database)
4. [New GitHub API Calls Required](#4-new-github-api-calls-required)
5. [Agent Framework Design](#5-agent-framework-design)
6. [Use Case: Workflow Failure Analysis](#6-use-case-workflow-failure-analysis)
7. [Ollama Integration](#7-ollama-integration)
8. [UI Design](#8-ui-design)
9. [IPC Channel Catalogue](#9-ipc-channel-catalogue)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Overview

Jarvis already collects GitHub notifications and groups them by repo/org. The next step is
**intelligence**: automatically determining which notifications require human attention and which
can be safely dismissed, by running a configurable LLM agent against the accumulated data.

### Key principles

| Principle | Explanation |
|-----------|-------------|
| **Human-in-the-loop** | The agent analyses and recommends; it cannot take any write action (close, create issue) without explicit user approval. |
| **Configurable use cases** | Agent definitions (system prompt + allowed tools) are stored in the DB and can be customised by the user. |
| **Local-first** | Analysis runs against cached data + local repo checkout. Ollama is the inference engine — no cloud. |
| **Progressive disclosure** | Results appear in the existing chat panel; approval actions are surfaced as a distinct approval UI inside the same panel. |

---

## 2. Current State Analysis

### What we have

| Data | Where |
|------|-------|
| Unread GitHub notifications | `github_notifications` table |
| Repo metadata (name, branch, language, archived) | `github_repos` table |
| Local repo clones + remote mappings | `local_repos`, `local_repo_remotes` |
| GitHub orgs | `github_orgs` |
| Chat / conversation log | `conversations` |
| Ollama streaming chat (multi-tool) | `src/services/ollama.ts` `streamChat` / `chatWithTools` |

### What is missing

| Missing | Impact |
|---------|--------|
| GitHub Actions workflow run history | Cannot detect recurring failures or post-failure successes |
| Per-job step details + log excerpt | Cannot identify the failing step or error message |
| Notification→subject detail (PR body, issue body) | Cannot enrich notifications beyond title |
| Configurable agent definitions stored in DB | No way to manage custom use cases |
| Agent session tracking (run history, findings) | No audit trail for agent runs |
| Structured approval/findings model | No way for agent to propose actions for user approval |

---

## 3. Missing Data in the Database

### New tables required

```sql
-- Configurable LLM agent use cases
CREATE TABLE IF NOT EXISTS agent_definitions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT,
    system_prompt TEXT NOT NULL,
    tools_allowed TEXT,          -- JSON array of IPC tool names the agent may call
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cached GitHub Actions workflow runs
CREATE TABLE IF NOT EXISTS github_workflow_runs (
    id              TEXT PRIMARY KEY,   -- GitHub numeric run ID as text
    repo_full_name  TEXT NOT NULL,
    workflow_name   TEXT,
    workflow_id     TEXT,
    head_branch     TEXT,
    head_sha        TEXT,
    event           TEXT,               -- push, pull_request, schedule, workflow_dispatch …
    status          TEXT,               -- queued, in_progress, completed
    conclusion      TEXT,               -- success, failure, cancelled, skipped, timed_out …
    run_number      INTEGER,
    run_started_at  DATETIME,
    updated_at      DATETIME,
    html_url        TEXT,
    fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_repo ON github_workflow_runs(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_wf_runs_conclusion ON github_workflow_runs(repo_full_name, conclusion);

-- Per-job details for a workflow run (identifies failing step + log excerpt)
CREATE TABLE IF NOT EXISTS github_workflow_jobs (
    id              TEXT PRIMARY KEY,   -- GitHub numeric job ID as text
    run_id          TEXT NOT NULL,
    repo_full_name  TEXT NOT NULL,
    name            TEXT,               -- job name
    status          TEXT,
    conclusion      TEXT,
    started_at      DATETIME,
    completed_at    DATETIME,
    log_excerpt     TEXT,               -- first ~3000 chars of combined failed-step logs
    fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wf_jobs_run ON github_workflow_jobs(run_id);

-- Agent run sessions
CREATE TABLE IF NOT EXISTS agent_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      INTEGER NOT NULL REFERENCES agent_definitions(id),
    scope_type    TEXT NOT NULL,   -- 'repo' | 'org' | 'global'
    scope_value   TEXT,            -- repo_full_name OR org login
    status        TEXT DEFAULT 'pending',  -- pending | running | completed | failed
    started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at  DATETIME,
    summary       TEXT,            -- human-readable summary from agent
    raw_result    TEXT             -- full JSON result blob from Ollama
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);

-- Structured findings emitted by an agent session (one per actionable item)
CREATE TABLE IF NOT EXISTS agent_findings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    finding_type  TEXT NOT NULL,   -- 'ignore' | 'investigate' | 'action_required'
    subject       TEXT,            -- what this finding concerns (workflow name, PR title …)
    reason        TEXT,            -- LLM explanation
    pattern       TEXT,            -- recurring pattern detected (if any)
    action_type   TEXT,            -- 'close_notifications' | 'create_issue' | 'none'
    action_data   TEXT,            -- JSON payload for the proposed action
    approved      INTEGER,         -- NULL = pending; 1 = approved; 0 = rejected
    approved_at   DATETIME,
    executed_at   DATETIME
);
CREATE INDEX IF NOT EXISTS idx_findings_session ON agent_findings(session_id);
```

### Seed data — built-in agent definitions

The schema migration should insert two starter agents:

```sql
INSERT OR IGNORE INTO agent_definitions (name, description, system_prompt, tools_allowed)
VALUES (
  'Workflow Failure Analyst',
  'Analyses repos with multiple CheckSuite/WorkflowRun notifications. Detects recurring failures, post-failure successes, and common error patterns.',
  '<see section 6>',
  '["github:get-workflow-summary", "github:list-notifications-for-repo"]'
);

INSERT OR IGNORE INTO agent_definitions (name, description, system_prompt, tools_allowed)
VALUES (
  'Notification Triage',
  'Reviews all unread notifications for a repo and recommends which are safe to dismiss vs. need investigation.',
  '<see section 6>',
  '["github:list-notifications-for-repo"]'
);
```

---

## 4. New GitHub API Calls Required

### 4.1 Workflow runs list

```
GET /repos/{owner}/{repo}/actions/runs
  ?per_page=50
  &created=>{iso_date}    (ISO 8601, e.g. 7 days ago)
  &branch={branch}        (optional — filter to default branch)
```

Response fields to persist: `id`, `name` (workflow name), `workflow_id`, `head_branch`,
`head_sha`, `event`, `status`, `conclusion`, `run_number`, `run_started_at`, `updated_at`,
`html_url`.

### 4.2 Jobs for a run

```
GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
  ?per_page=30
  &filter=failed          (only failed jobs — reduces payload)
```

Response fields: `id`, `run_id`, `name`, `status`, `conclusion`, `started_at`,
`completed_at`, `steps[].name`, `steps[].conclusion`, `steps[].number`.

### 4.3 Job log download (streaming)

```
GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs
```

Returns a redirect to a pre-signed URL for a plain-text log file. We download only the first
`3 000` characters of the log to keep DB size manageable. Only requested for jobs with
conclusion = `failure`.

**Rate-limit consideration**: log downloads consume rate-limit budget. Only fetch logs for the
most recent 3 failed runs per workflow.

### 4.4 Mark notification thread as done (already partially implemented)

```
PATCH /notifications/threads/{thread_id}
```

Already wired in `markNotificationRead` in `github-notifications.ts`. The agent findings
`close_notifications` action will call this via the existing `github:dismiss-notification`
IPC channel — no new API call needed.

### 4.5 Create issue (for `create_issue` action type)

```
POST /repos/{owner}/{repo}/issues
  { title, body, labels }
```

New function `createIssue(accessToken, repoFullName, title, body, labels)` in a shared
GitHub service. Only called after explicit user approval.

---

## 5. Agent Framework Design

### 5.1 Agent definition model

An `AgentDefinition` is stored in `agent_definitions` and contains:

- **name** — display label
- **description** — one-liner shown in the UI selector
- **system_prompt** — full instruction set injected as the Ollama system message
- **tools_allowed** — JSON array of IPC channel names the runner may call to enrich context

### 5.2 Session lifecycle

```
User clicks "Analyse" on repo  →  AgentSelector modal  →  user picks agent & confirms
→  IPC: agents:run({ agentId, scopeType: 'repo', scopeValue: 'org/repo' })
→  Main creates agent_session row (status = 'running')
→  AgentRunner collects context (notifications, workflow summary, local repo info)
→  Builds prompt → streamChat() to Ollama
→  Parses structured JSON result
→  Stores agent_findings rows
→  Updates agent_session (status = 'completed', summary = ...)
→  Pushes 'agent:session-complete' event to renderer
→  Renderer opens/focuses chat panel with session result and approval UI
```

### 5.3 Agent runner (`src/plugins/agents/runner.ts`)

```typescript
async function runAgentSession(
  db: SqlJsDatabase,
  sessionId: number,
  agentDef: AgentDefinition,
  scopeType: 'repo' | 'org' | 'global',
  scopeValue: string,
  model: string,
  accessToken: string,
  getWindow: () => BrowserWindow | null,
): Promise<void>
```

**Steps**:
1. Build context block (notifications, workflow runs, local repo path if available)
2. Assemble messages: `[system, user_context_message]`
3. Call `streamChat()` — push each token to renderer via `agent:token` event
4. Collect full response, parse JSON from the last assistant message
5. Persist findings to `agent_findings`
6. Update `agent_sessions` status and summary
7. Emit `agent:session-complete` with session id to renderer

### 5.4 Parse & store findings

The agent is instructed to emit a JSON block in its final message (see section 7). The
runner extracts the JSON (tolerating surrounding prose), validates the schema, and inserts
one `agent_findings` row per finding.

---

## 6. Use Case: Workflow Failure Analysis

### 6.1 System prompt

```
You are Jarvis's Workflow Failure Analyst. Your job is to analyse GitHub notifications and
recent workflow run history for a repository and determine which items require human
attention vs. which can be safely dismissed.

You will receive:
1. NOTIFICATIONS: The list of unread notifications for the repository.
2. WORKFLOW_RUNS: Recent GitHub Actions workflow runs (last 7 days), including job names
   and failure log excerpts where available.
3. LOCAL_REPO: Whether the repository exists as a local clone on disk (informational).

Your analysis task:
- Group related notifications by workflow name / subject.
- For each failing workflow: check whether subsequent runs of the same workflow on the
  same branch succeeded after the failure. If yes, the failure is likely transient.
- Identify recurring patterns: same failing step, same error substring appearing in logs.
- For each group output a structured finding.

OUTPUT FORMAT:
Provide a brief human-readable summary first, then emit exactly one JSON code block
following this schema:

```json
{
  "summary": "Brief overall assessment (1-2 sentences)",
  "findings": [
    {
      "subject": "Name/identifier of the workflow or subject",
      "finding_type": "ignore | investigate | action_required",
      "reason": "Explanation for your conclusion",
      "pattern": "Description of the recurring error pattern or null",
      "action_type": "close_notifications | create_issue | none",
      "action_data": {
        "notification_ids": ["..."],
        "issue_title": "...",
        "issue_body": "...",
        "issue_labels": ["bug", "ci"]
      }
    }
  ]
}
```

IMPORTANT RULES:
- You CANNOT close notifications or create issues yourself.
  Output them only as findings with the appropriate action_type.
  The user will review and approve before any action is taken.
- When a workflow failed but later succeeded from the same branch → finding_type = "ignore",
  action_type = "close_notifications".
- When the same step fails repeatedly with a consistent error → finding_type = "action_required",
  action_type = "create_issue", include a draft issue body.
- Be conservative: when in doubt, use "investigate" rather than "ignore".
- Never fabricate workflow run data not present in the context provided.
```

### 6.2 Context assembly (runner)

```
=== NOTIFICATIONS (repo: {repoFullName}) ===
{notification list: id, title, type, reason, updated_at}

=== WORKFLOW RUNS (last 7 days) ===
{per workflow name:
  Run #{number} | {branch} | {conclusion} | {started_at}
  Jobs: {job_name} → {conclusion}
  Log excerpt: {first 2000 chars of combined failed step logs, if any}
}

=== LOCAL REPO ===
{localPath or "Not cloned locally"}
```

### 6.3 Example result

> **Jarvis:** Here is my analysis of `org/my-repo` (4 notifications):
>
> The `CI / build` workflow failed on `main` on Mon 10 Mar but succeeded again in the next
> 2 runs from the same branch — this appears to be a transient infrastructure issue.
> The `Deploy / staging` workflow has failed 5 times in a row with the same error:
> *"Cannot find module 'aws-cdk'"* — this looks like a dependency not being installed.
>
> **Findings:**
> - ✅ CI / build (3 notifications) — safe to dismiss (transient failure, later succeeded)
> - ⚠️ Deploy / staging (1 notification) — recurring failure, suggest creating an issue
>
> **Proposed actions:**
> - [Dismiss 3 CI/build notifications] — awaiting your approval
> - [Create issue: "Deploy/staging fails: aws-cdk not found"] — awaiting your approval

---

## 7. Ollama Integration

### 7.1 How the agent calls Ollama

The agent runner uses the existing `streamChat` function from `src/services/ollama.ts`.
The agent does **not** use `chatWithTools` (tool-calling) because the data is fully assembled
by the runner before calling Ollama — no back-and-forth tool rounds are needed.

The runner streams tokens directly to the renderer via the IPC event `agent:token`
(same transport as `chat:token`) so the chat panel can display the analysis in real time.

### 7.2 JSON extraction

After the stream completes, the runner scans the full response string for the first
` ```json … ``` ` block. If parsing fails, the session is marked `failed` with the parse
error stored in `raw_result`. The chat panel shows a graceful error message.

### 7.3 Config used

- `selected_ollama_model` — same model the user chose in settings
- System prompt from `agent_definitions.system_prompt`
- No temperature override for now (use Ollama default)

---

## 8. UI Design

### 8.1 Main screen — Analyse button

`NotifRepoPanel` is extended with an **"Analyse with Agent"** button that appears when a
repo has ≥ 2 unread notifications. Clicking it opens the agent selector modal.

### 8.2 Agent selector modal (`AgentSelector.tsx`)

- Dropdown: list of `agent_definitions` (name + description)
- Scope label: "Analysing: `{repoFullName}`"
- **Start Analysis** button → calls `agents:run`
- Closes on confirmation; the chat window opens/focuses

### 8.3 Chat panel — agent mode

When an agent session is in progress, the chat panel shows:
- A sticky header: `🤖 Agent: {agent name} — analysing {scopeValue}…`
- Streamed tokens appear in the assistant bubble, same as regular chat
- A spinner / "thinking" indicator during the Ollama call
- When the session completes, the approval panel is inserted below the final message

### 8.4 Agent approval panel (`AgentApprovalPanel.tsx`)

Rendered inside the chat panel after a session completes. For each finding with a
non-`none` action type, it shows:

```
┌──────────────────────────────────────────────────────────────────┐
│ Finding: CI / build failures (3 notifications)                   │
│ ✅ Finding type: ignore — Subsequent runs succeeded              │
│                                                                  │
│ Proposed action: Dismiss 3 notifications                         │
│                                                                  │
│  [✓ Yes, dismiss them]   [✗ No, keep them]                      │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Finding: Deploy / staging failures                               │
│ ⚠️ Finding type: action_required — Recurring aws-cdk error       │
│                                                                  │
│ Proposed action: Create GitHub issue                             │
│ Title: "Deploy/staging fails: aws-cdk not found"                 │
│ Body: [expandable preview]                                       │
│                                                                  │
│  [✓ Create issue]   [✗ Skip]                                     │
└──────────────────────────────────────────────────────────────────┘
```

Buttons:
- **Yes / Create** → calls `agents:approve-finding` then `agents:execute-finding`
- **No / Skip** → calls `agents:reject-finding`

After execution the button row is replaced with a status badge: `✓ Done` / `✗ Skipped`.

### 8.5 Main screen trigger flow

```
NotifRepoPanel  →  "Analyse" button  →  AgentSelector modal
  →  agents:run  →  chat window opens  →  streaming text
  →  session complete  →  ApprovalPanel inserted in chat
  →  user clicks approve  →  action executed  →  notification dismissed / issue created
```

---

## 9. IPC Channel Catalogue

### New channels added by the agents plugin

| Channel | Direction | Description |
|---------|-----------|-------------|
| `agents:list` | renderer→main | Returns all `agent_definitions` rows |
| `agents:run` | renderer→main | Start an agent session; returns `{ sessionId }` |
| `agents:get-session` | renderer→main | Returns session status + findings array |
| `agents:approve-finding` | renderer→main | Mark a finding as approved |
| `agents:reject-finding` | renderer→main | Mark a finding as rejected |
| `agents:execute-finding` | renderer→main | Execute an approved finding's action |

### New channels added by the workflows plugin

| Channel | Direction | Description |
|---------|-----------|-------------|
| `github:fetch-workflow-runs` | renderer→main | Fetch & cache workflow runs for a repo |
| `github:get-workflow-summary` | renderer→main | Return cached workflow run summary for a repo |

### Push events (main→renderer)

| Event | Description |
|-------|-------------|
| `agent:token` | Streaming token from Ollama during agent run |
| `agent:session-complete` | Agent session finished; payload = `{ sessionId }` |
| `agent:session-error` | Agent session failed; payload = `{ sessionId, error }` |

---

## 10. Implementation Roadmap

### Phase 1 — Data layer (schema + GitHub service)

- [ ] Add 5 new tables to `src/storage/schema.ts`
- [ ] Seed 2 built-in `agent_definitions` rows in schema init
- [ ] Create `src/services/github-workflows.ts`
  - `fetchWorkflowRuns(accessToken, repoFullName, since)`
  - `fetchWorkflowRunJobs(accessToken, repoFullName, runId)`
  - `fetchJobLogExcerpt(accessToken, repoFullName, jobId)` — first 3000 chars
  - `storeWorkflowRuns(db, repoFullName, runs)`
  - `storeWorkflowJobs(db, jobs)`
  - `getWorkflowSummaryForRepo(db, repoFullName, since)` — returns structured summary object
- [ ] Add `createIssue` to a shared GitHub service

### Phase 2 — Agent plugin

- [ ] Create `src/plugins/agents/handler.ts` — registers all IPC channels
- [ ] Create `src/plugins/agents/runner.ts` — context assembly + Ollama call + findings parse/store
- [ ] Register agent plugin in `src/main/ipc-handlers.ts`
- [ ] Extend `window.jarvis` bridge in `src/main/preload.ts` with new channels
- [ ] Add new types to `src/plugins/types.ts` (`AgentDefinition`, `AgentSession`, `AgentFinding`, `WorkflowRun`, `WorkflowJob`)

### Phase 3 — UI

- [ ] Create `src/plugins/agents/AgentSelector.tsx`
- [ ] Create `src/plugins/agents/AgentApprovalPanel.tsx`
- [ ] Update `src/plugins/notifications/NotifRepoPanel.tsx` — add "Analyse" button
- [ ] Update `src/renderer/chat.tsx` — handle `agent:token` / `agent:session-complete` events, render approval panel
- [ ] Import new components in `src/renderer/index.tsx` if needed

### Phase 4 — Hardening

- [ ] Write unit tests for `github-workflows.ts` (mock fetch)
- [ ] Write unit tests for agent runner JSON extraction
- [ ] Update `tests/unit/ipc-registration.test.ts` to include new channels
- [ ] Manual end-to-end test: trigger analysis on a repo with workflow failures

---

*Last updated: 2026-03-15*
