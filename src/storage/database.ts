import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { getSchema } from './schema';

let db: SqlJsDatabase | null = null;
let dbPath: string | null = null;

const SAVE_DEBOUNCE_MS = 500;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

/** Check whether a column exists in a table (safe guard for ALTER TABLE ADD COLUMN). */
function columnExists(database: SqlJsDatabase, table: string, column: string): boolean {
  const result = database.exec(`PRAGMA table_info('${table}')`);
  if (result.length === 0) return false;
  const columns = result[0].values.map((row) => row[1] as string);
  return columns.includes(column);
}

function getDefaultDbPath(): string {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'Jarvis', 'jarvis.db');
}

/**
 * Keep up to 3 daily rotating backups of the database file.
 * Only rotates when the existing DB file is larger than a freshly-created empty DB
 * (empty sql.js DB is ≈ 4–8 KB; anything with real data is significantly larger).
 * Backups: jarvis.db.bak.1 (newest) … jarvis.db.bak.3 (oldest).
 */
function rotateDatabaseBackup(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    // Only bother if the file looks like it contains real rows (> 100 KB).
    const { size } = fs.statSync(filePath);
    if (size < 100_000) return;

    // Skip if we already backed up today.
    const bak1 = filePath + '.bak.1';
    if (fs.existsSync(bak1)) {
      const mtime = fs.statSync(bak1).mtime;
      if (mtime.toDateString() === new Date().toDateString()) return;
    }

    // Rotate: .bak.2 → .bak.3, .bak.1 → .bak.2, current → .bak.1
    const bak2 = filePath + '.bak.2';
    const bak3 = filePath + '.bak.3';
    if (fs.existsSync(bak2)) fs.copyFileSync(bak2, bak3);
    if (fs.existsSync(bak1)) fs.copyFileSync(bak1, bak2);
    fs.copyFileSync(filePath, bak1);
    console.log('[DB] Daily backup rotated →', bak1);
  } catch (err) {
    console.warn('[DB] Backup rotation failed (non-fatal):', (err as Error).message);
  }
}

export async function getDatabase(customDbPath?: string): Promise<SqlJsDatabase> {
  if (db) return db;

  const resolvedPath = customDbPath || getDefaultDbPath();
  dbPath = resolvedPath;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Rotate a backup before loading — once per day, only if there's data to keep.
  rotateDatabaseBackup(resolvedPath);

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
  // Always apply current schema — CREATE TABLE IF NOT EXISTS is idempotent.
  // This ensures any tables added in new versions are created for existing users
  // without needing a CREATE TABLE in every migration.
  database.run(getSchema());

  const result = database.exec("PRAGMA user_version");
  const userVersion = result.length > 0 ? (result[0].values[0][0] as number) : 0;

  if (userVersion === 0) {
    seedBuiltInAgents(database);
    database.run('PRAGMA user_version = 25');
  }

  if (userVersion === 1) {
    if (!columnExists(database, 'github_orgs', 'discovery_enabled')) {
      database.run('ALTER TABLE github_orgs ADD COLUMN discovery_enabled INTEGER DEFAULT 1');
    }
    database.run('PRAGMA user_version = 2');
  }

  if (userVersion === 2) {
    if (!columnExists(database, 'github_auth', 'avatar_url')) {
      database.run('ALTER TABLE github_auth ADD COLUMN avatar_url TEXT');
    }
    database.run('PRAGMA user_version = 3');
  }

  if (userVersion === 3) {
    if (!columnExists(database, 'github_auth', 'pat')) {
      database.run('ALTER TABLE github_auth ADD COLUMN pat TEXT');
    }
    database.run('PRAGMA user_version = 4');
  }

  if (userVersion === 4) {
    if (!columnExists(database, 'github_repos', 'starred')) {
      database.run('ALTER TABLE github_repos ADD COLUMN starred INTEGER DEFAULT 0');
    }
    database.run('PRAGMA user_version = 5');
  }

  if (userVersion === 5) {
    database.run('PRAGMA user_version = 6');
  }

  if (userVersion === 6) {
    if (!columnExists(database, 'local_repos', 'name')) {
      database.run('ALTER TABLE local_repos ADD COLUMN name TEXT');
    }
    database.run('PRAGMA user_version = 7');
  }

  if (userVersion === 7) {
    if (!columnExists(database, 'github_repos', 'collaboration_reason')) {
      database.run('ALTER TABLE github_repos ADD COLUMN collaboration_reason TEXT');
    }
    database.run('PRAGMA user_version = 8');
  }

  if (userVersion === 8) {
    seedBuiltInAgents(database);
    database.run('PRAGMA user_version = 9');
  }

  if (userVersion === 9) {
    database.run('PRAGMA user_version = 10');
  }

  if (userVersion === 10) {
    database.run('PRAGMA user_version = 11');
  }

  if (userVersion === 11) {
    database.run('PRAGMA user_version = 12');
  }

  if (userVersion === 12) {
    database.run('PRAGMA user_version = 13');
  }

  if (userVersion === 14) {
    database.run('PRAGMA user_version = 15');
  }

  if (userVersion === 15) {
    database.run('PRAGMA user_version = 16');
  }

  if (userVersion === 15 || userVersion === 16) {
    if (!columnExists(database, 'github_notifications', 'subject_actor_login')) {
      database.run('ALTER TABLE github_notifications ADD COLUMN subject_actor_login TEXT');
      database.run('ALTER TABLE github_notifications ADD COLUMN subject_actor_type TEXT');
    }
    database.run('PRAGMA user_version = 17');
  }

  if (userVersion === 17) {
    if (!columnExists(database, 'github_workflow_runs', 'workflow_path')) {
      database.run('ALTER TABLE github_workflow_runs ADD COLUMN workflow_path TEXT');
    }
    database.run('PRAGMA user_version = 18');
  }

  if (userVersion === 18) {
    if (!columnExists(database, 'groups', 'ruddr_project_name')) {
      database.run('ALTER TABLE groups ADD COLUMN ruddr_project_name TEXT');
    }
    database.run('PRAGMA user_version = 19');
  }

  if (userVersion === 19) {
    database.run('PRAGMA user_version = 20');
  }

  if (userVersion === 20) {
    if (!columnExists(database, 'ruddr_projects', 'cloud_folder_url')) {
      database.run('ALTER TABLE ruddr_projects ADD COLUMN cloud_folder_url TEXT');
    }
    database.run('PRAGMA user_version = 21');
  }

  if (userVersion === 21) {
    if (!columnExists(database, 'ruddr_projects', 'discovered_at')) {
      database.run('ALTER TABLE ruddr_projects ADD COLUMN discovered_at DATETIME DEFAULT NULL');
    }
    database.run('PRAGMA user_version = 22');
  }

  if (userVersion === 22) {
    database.run('PRAGMA user_version = 23');
  }

  if (userVersion === 23) {
    database.run('PRAGMA user_version = 24');
  }

  if (userVersion === 24) {
    // Migration v24 → v25: add index on page_last_modified
    // (column was already included in the v23→v24 CREATE TABLE)
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_onenote_cache_modified
      ON onedrive_onenote_cache(page_last_modified)
    `);
    if (!columnExists(database, 'onedrive_onenote_cache', 'page_last_modified')) {
      database.run('ALTER TABLE onedrive_onenote_cache ADD COLUMN page_last_modified TEXT');
    }
    database.run('PRAGMA user_version = 25');
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

/** Synchronously write the database to disk (no debounce). */
function writeDatabase(): void {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

/**
 * Persist the database to disk with debounce (default 500ms).
 * Rapid successive calls are coalesced into a single write.
 * Use flushDatabase() to force a synchronous write when data must be
 * durable immediately (e.g. before app exit, after auth token save).
 */
export function saveDatabase(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(writeDatabase, SAVE_DEBOUNCE_MS);
}

/** Force an immediate synchronous write. Call before close/exit/important ops. */
export function flushDatabase(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  writeDatabase();
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
    flushDatabase();
    db.close();
    db = null;
    dbPath = null;
  }
}
