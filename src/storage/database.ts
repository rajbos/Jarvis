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
    database.run('PRAGMA user_version = 8');
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
