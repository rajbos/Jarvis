import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { getSchema } from './schema';

let db: SqlJsDatabase | null = null;
let dbPath: string | null = null;

function getDefaultDbPath(): string {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'Jarvis', 'jarvis.db');
}

export async function getDatabase(customDbPath?: string): Promise<SqlJsDatabase> {
  if (db) return db;

  const resolvedPath = customDbPath || getDefaultDbPath();
  dbPath = resolvedPath;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(resolvedPath)) {
    const fileBuffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initializeSchema(db);
  saveDatabase(); // persist after schema init
  return db;
}

/**
 * Creates an in-memory database (for testing).
 */
export async function createMemoryDatabase(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  const memDb = new SQL.Database();
  initializeSchema(memDb);
  return memDb;
}

function initializeSchema(database: SqlJsDatabase): void {
  const result = database.exec("PRAGMA user_version");
  const userVersion = result.length > 0 ? (result[0].values[0][0] as number) : 0;

  if (userVersion === 0) {
    database.run(getSchema());
    seedBuiltInAgents(database);
    database.run('PRAGMA user_version = 12');
  }

  if (userVersion === 1) {
    // Migration v1 → v2: add discovery_enabled to github_orgs
    database.run('ALTER TABLE github_orgs ADD COLUMN discovery_enabled INTEGER DEFAULT 1');
    database.run('PRAGMA user_version = 2');
  }

  if (userVersion === 2) {
    // Migration v2 → v3: add avatar_url to github_auth
    database.run('ALTER TABLE github_auth ADD COLUMN avatar_url TEXT');
    database.run('PRAGMA user_version = 3');
  }

  if (userVersion === 3) {
    // Migration v3 → v4: add pat (Personal Access Token) to github_auth
    database.run('ALTER TABLE github_auth ADD COLUMN pat TEXT');
    database.run('PRAGMA user_version = 4');
  }

  if (userVersion === 4) {
    // Migration v4 → v5: add starred flag to github_repos
    database.run('ALTER TABLE github_repos ADD COLUMN starred INTEGER DEFAULT 0');
    database.run('PRAGMA user_version = 5');
  }

  if (userVersion === 5) {
    // Migration v5 → v6: add github_notifications cache table
    database.run(`
      CREATE TABLE IF NOT EXISTS github_notifications (
        id             TEXT PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        repo_owner     TEXT NOT NULL,
        subject_type   TEXT,
        subject_title  TEXT,
        subject_url    TEXT,
        reason         TEXT,
        unread         INTEGER DEFAULT 1,
        updated_at     TEXT,
        fetched_at     DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_notif_repo ON github_notifications(repo_full_name)');
    database.run('CREATE INDEX IF NOT EXISTS idx_notif_owner ON github_notifications(repo_owner)');
    database.run('PRAGMA user_version = 6');
  }

  if (userVersion === 6) {
    // Migration v6 → v7: add local repo scanning tables
    database.run('ALTER TABLE local_repos ADD COLUMN name TEXT');
    database.run(`
      CREATE TABLE IF NOT EXISTS local_scan_folders (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        path     TEXT NOT NULL UNIQUE,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS local_repo_remotes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        local_repo_id  INTEGER NOT NULL REFERENCES local_repos(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        url            TEXT NOT NULL,
        github_repo_id INTEGER REFERENCES github_repos(id),
        UNIQUE(local_repo_id, name)
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_local_repo_remotes_local_repo_id ON local_repo_remotes(local_repo_id)');
    database.run('PRAGMA user_version = 7');
  }

  if (userVersion === 7) {
    // Migration v7 → v8: add collaboration_reason to github_repos
    database.run('ALTER TABLE github_repos ADD COLUMN collaboration_reason TEXT');
    database.run('PRAGMA user_version = 8');
  }

  if (userVersion === 8) {
    // Migration v8 → v9: add workflow run cache + agent framework tables
    database.run(`
      CREATE TABLE IF NOT EXISTS github_workflow_runs (
        id              TEXT PRIMARY KEY,
        repo_full_name  TEXT NOT NULL,
        workflow_name   TEXT,
        workflow_id     TEXT,
        head_branch     TEXT,
        head_sha        TEXT,
        event           TEXT,
        status          TEXT,
        conclusion      TEXT,
        run_number      INTEGER,
        run_started_at  DATETIME,
        updated_at      DATETIME,
        html_url        TEXT,
        fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_wf_runs_repo ON github_workflow_runs(repo_full_name)');
    database.run('CREATE INDEX IF NOT EXISTS idx_wf_runs_conclusion ON github_workflow_runs(repo_full_name, conclusion)');
    database.run(`
      CREATE TABLE IF NOT EXISTS github_workflow_jobs (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        repo_full_name  TEXT NOT NULL,
        name            TEXT,
        status          TEXT,
        conclusion      TEXT,
        started_at      DATETIME,
        completed_at    DATETIME,
        log_excerpt     TEXT,
        fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_wf_jobs_run ON github_workflow_jobs(run_id)');
    database.run(`
      CREATE TABLE IF NOT EXISTS agent_definitions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE,
        description   TEXT,
        system_prompt TEXT NOT NULL,
        tools_allowed TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id      INTEGER NOT NULL REFERENCES agent_definitions(id),
        scope_type    TEXT NOT NULL,
        scope_value   TEXT,
        status        TEXT DEFAULT 'pending',
        started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at  DATETIME,
        summary       TEXT,
        raw_result    TEXT
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id)');
    database.run(`
      CREATE TABLE IF NOT EXISTS agent_findings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        finding_type    TEXT NOT NULL,
        subject         TEXT,
        reason          TEXT,
        pattern         TEXT,
        action_type     TEXT,
        action_data     TEXT,
        approved        INTEGER,
        approved_at     DATETIME,
        executed_at     DATETIME,
        execution_error TEXT
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_findings_session ON agent_findings(session_id)');

    // Seed built-in agent definitions
    seedBuiltInAgents(database);

    database.run('PRAGMA user_version = 9');
  }

  if (userVersion === 9) {
    // Migration v9 → v10: add repo_secrets table for GitHub Actions secret names
    database.run(`
      CREATE TABLE IF NOT EXISTS repo_secrets (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        github_repo_id INTEGER NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
        secret_name    TEXT NOT NULL,
        scanned_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(github_repo_id, secret_name)
      )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_repo_secrets_repo_id ON repo_secrets(github_repo_id)');
    database.run('PRAGMA user_version = 10');
  }

  if (userVersion === 10) {
    // Migration v10 → v11: add secret_scan_favorites table
    database.run(`
      CREATE TABLE IF NOT EXISTS secret_scan_favorites (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL CHECK(target_type IN ('org', 'repo')),
        target_name TEXT NOT NULL UNIQUE,
        added_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run('PRAGMA user_version = 11');
  }

  if (userVersion === 11) {
    // Migration v11 → v12: add groups tables for grouped source configuration
    database.run(`
      CREATE TABLE IF NOT EXISTS groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS group_local_repos (
        group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        local_repo_id INTEGER NOT NULL REFERENCES local_repos(id) ON DELETE CASCADE,
        added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, local_repo_id)
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS group_github_repos (
        group_id       INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        github_repo_id INTEGER NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, github_repo_id)
      )
    `);
    database.run('PRAGMA user_version = 12');
  }
}

const WORKFLOW_FAILURE_ANALYST_PROMPT = `You are Jarvis's Workflow Failure Analyst. You have been given raw GitHub Actions log excerpts and workflow run history for a repository. Your job is to perform deep root-cause analysis — not simply re-summarise the data provided.

You will receive:
1. NOTIFICATIONS: Unread GitHub notifications.
2. WORKFLOW_RUNS: Recent runs (last 7 days) grouped by workflow, including per-job outcomes and log excerpts where available.
3. LOCAL_REPO: Whether the repo is cloned locally (informational).

ANALYSIS STEPS — work through each in order before writing output:

1. **Log pattern scan** — Read every log excerpt. Extract the exact error string, failing step name, and file/line if present. Note which error strings appear in more than one run.

2. **Timeline regression** — Look at run dates and branch names. Was this workflow succeeding before? Identify approximately when failures started. If a later run on the same branch passed, mark the failure as transient/self-healed.

3. **Cross-run correlation** — Group runs by the failing step name. If the same step fails across multiple runs and branches, it is a systematic issue. If it fails only on one branch, it may be a branch-specific regression.

4. **Root cause hypothesis** — Based on log content, state the most likely root cause: dependency version change, test logic bug, infrastructure issue, permissions problem, etc. Quote the specific log line(s) that support your conclusion. If no log is available, say so explicitly.

5. **Actionability** — Decide for each workflow: the failure is noise (self-healed), needs investigation (insufficient data), or requires action (persistent, reproducible failure with clear evidence).

OUTPUT FORMAT:
Write your full analysis as plain text first. Use a heading per workflow. Be specific: quote log lines verbatim, name failing step names, reference run numbers and dates. After the analysis, emit exactly ONE JSON block:

\`\`\`json
{
  "summary": "2-3 sentence overall assessment mentioning the primary failure pattern and your confidence level",
  "findings": [
    {
      "subject": "Workflow name / job name",
      "finding_type": "ignore | investigate | action_required",
      "reason": "Evidence-based explanation quoting specific log lines or run numbers",
      "pattern": "Exact recurring error string, or null if no pattern found",
      "action_type": "close_notifications | create_issue | none",
      "action_data": {
        "notification_ids": ["..."],
        "issue_title": "Concise, actionable title",
        "issue_body": "Markdown body: what fails, when it started, log evidence quoted, suggested investigation steps",
        "issue_labels": ["bug", "ci"]
      }
    }
  ]
}
\`\`\`

RULES:
- You CANNOT act autonomously. All actions require user approval through findings.
- NEVER fabricate log lines or run data not present in the context. Write "no log available" when absent.
- Self-healed (later run passed on same branch) → finding_type = "ignore", action_type = "close_notifications".
- Same step fails across 2+ runs with a consistent error → finding_type = "action_required", action_type = "create_issue". Include a detailed draft issue body quoting the failing log lines.
- Single failure or insufficient log data → finding_type = "investigate", action_type = "none".
- The "reason" field must reference specific evidence, not generic statements.`;

const NOTIFICATION_TRIAGE_PROMPT = `You are Jarvis's Notification Triage agent. Your job is to review all unread GitHub notifications for a repository and classify them.

For each notification, determine:
- Is this likely noise that can be safely dismissed (e.g. automated dependency bumps, CI runs that self-resolved)?
- Does this require investigation (unexpected failures, security alerts, direct mentions)?
- Is action required (a PR waiting for your review, a failing CI block)?

OUTPUT FORMAT:
Provide a brief summary, then emit exactly one JSON code block:

\`\`\`json
{
  "summary": "Brief overall assessment",
  "findings": [
    {
      "subject": "Notification title or group description",
      "finding_type": "ignore | investigate | action_required",
      "reason": "Why you classified it this way",
      "pattern": null,
      "action_type": "close_notifications | none",
      "action_data": { "notification_ids": ["..."] }
    }
  ]
}
\`\`\`

IMPORTANT: You cannot dismiss notifications yourself. Output them as findings with action_type = "close_notifications" for the user to approve.`;

function seedBuiltInAgents(database: SqlJsDatabase): void {
  database.run(
    `INSERT OR IGNORE INTO agent_definitions (name, description, system_prompt, tools_allowed) VALUES (?, ?, ?, ?)`,
    [
      'Workflow Failure Analyst',
      "Analyses repos with multiple CheckSuite/WorkflowRun notifications. Detects recurring failures, post-failure successes, and common error patterns.",
      WORKFLOW_FAILURE_ANALYST_PROMPT,
      '["github:get-workflow-summary","github:list-notifications-for-repo"]',
    ],
  );
  database.run(
    `INSERT OR IGNORE INTO agent_definitions (name, description, system_prompt, tools_allowed) VALUES (?, ?, ?, ?)`,
    [
      'Notification Triage',
      'Reviews all unread notifications for a repo and recommends which are safe to dismiss vs. need investigation.',
      NOTIFICATION_TRIAGE_PROMPT,
      '["github:list-notifications-for-repo"]',
    ],
  );
}

export function saveDatabase(): void {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

export function getConfigValue(database: SqlJsDatabase, key: string): string | null {
  const stmt = database.prepare('SELECT value FROM config WHERE key = ?');
  stmt.bind([key]);
  const value = stmt.step() ? (stmt.getAsObject().value as string) : null;
  stmt.free();
  return value;
}

export function setConfigValue(database: SqlJsDatabase, key: string, value: string): void {
  database.run(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
    dbPath = null;
  }
}
