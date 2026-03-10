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
    database.run('PRAGMA user_version = 3');
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
}

export function saveDatabase(): void {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
    dbPath = null;
  }
}
