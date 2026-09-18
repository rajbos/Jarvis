/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { getConfigValue, setConfigValue, initializeSchema } from '../../src/storage/database';

describe('Database Schema', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
  });

  it('should create all required tables', () => {
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = result[0].values.map((row: unknown[]) => row[0] as string);

    expect(tableNames).toContain('config');
    expect(tableNames).toContain('onboarding');
    expect(tableNames).toContain('github_auth');
    expect(tableNames).toContain('github_orgs');
    expect(tableNames).toContain('github_repos');
    expect(tableNames).toContain('local_repos');
    expect(tableNames).toContain('conversations');
    expect(tableNames).toContain('task_history');
  });

  it('should initialize onboarding steps as pending', () => {
    const result = db.exec('SELECT step, status FROM onboarding ORDER BY step');
    const rows = result[0].values.map((row: unknown[]) => ({ step: row[0], status: row[1] }));

    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ step: 'github_oauth', status: 'pending' });
    expect(rows).toContainEqual({ step: 'local_repos', status: 'pending' });
    expect(rows).toContainEqual({ step: 'ollama', status: 'pending' });
  });

  it('should allow inserting and reading config values', () => {
    db.run("INSERT INTO config (key, value) VALUES (?, ?)", ['test_key', 'test_value']);
    const stmt = db.prepare("SELECT value FROM config WHERE key = ?");
    stmt.bind(['test_key']);
    stmt.step();
    const row = stmt.getAsObject() as { value: string };
    stmt.free();
    expect(row.value).toBe('test_value');
  });

  it('should allow inserting github_auth with unique login constraint', () => {
    db.run(
      "INSERT INTO github_auth (login, access_token, scopes) VALUES (?, ?, ?)",
      ['testuser', 'encrypted_token', 'repo,read:org'],
    );

    const stmt = db.prepare('SELECT login, scopes FROM github_auth WHERE login = ?');
    stmt.bind(['testuser']);
    stmt.step();
    const row = stmt.getAsObject() as { login: string; scopes: string };
    stmt.free();
    expect(row.login).toBe('testuser');
    expect(row.scopes).toBe('repo,read:org');

    // Inserting same login should fail (unique constraint)
    expect(() => {
      db.run(
        "INSERT INTO github_auth (login, access_token, scopes) VALUES (?, ?, ?)",
        ['testuser', 'another_token', 'repo'],
      );
    }).toThrow();
  });

  it('should support foreign key from local_repos to github_repos', () => {
    db.run("PRAGMA foreign_keys = ON");
    // Insert a github_repo first
    db.run(
      "INSERT INTO github_repos (full_name, name) VALUES (?, ?)",
      ['org/repo', 'repo'],
    );

    const repoResult = db.exec("SELECT id FROM github_repos WHERE full_name = 'org/repo'");
    const repoId = repoResult[0].values[0][0] as number;

    // Insert local_repo referencing it
    db.run(
      "INSERT INTO local_repos (local_path, remote_url, github_repo_id) VALUES (?, ?, ?)",
      ['C:\\repos\\repo', 'https://github.com/org/repo.git', repoId],
    );

    const localResult = db.exec("SELECT github_repo_id FROM local_repos WHERE local_path = 'C:\\repos\\repo'");
    expect(localResult[0].values[0][0]).toBe(repoId);
  });

  it('getConfigValue returns null for non-existent key', () => {
    expect(getConfigValue(db, 'nonexistent')).toBeNull();
  });

  it('setConfigValue writes and getConfigValue reads back', () => {
    setConfigValue(db, 'force_oauth_discovery', '1');
    expect(getConfigValue(db, 'force_oauth_discovery')).toBe('1');

    setConfigValue(db, 'force_oauth_discovery', '0');
    expect(getConfigValue(db, 'force_oauth_discovery')).toBe('0');

    setConfigValue(db, 'force_pat_discovery', '1');
    expect(getConfigValue(db, 'force_pat_discovery')).toBe('1');
  });

  it('fresh schema gives agent_sessions provider/model/parent_session_id columns', () => {
    db.run(`INSERT INTO agent_definitions (name, system_prompt) VALUES ('a', 'p')`);
    db.run(`INSERT INTO agent_sessions (agent_id, scope_type, scope_value) VALUES (1, 'repo', 'org/repo')`);
    const row = db.exec('SELECT provider, model, parent_session_id FROM agent_sessions')[0].values[0];
    expect(row).toEqual(['ollama', null, null]);
  });
});

describe('Migration v26 → v27 (agent_sessions escalation columns)', () => {
  it('adds provider, model, and parent_session_id to an existing v26 database', async () => {
    const SQL = await initSqlJs();
    const oldDb = new SQL.Database();
    // Minimal v26-shape agent_sessions — no provider/model/parent_session_id yet.
    oldDb.run(`
      CREATE TABLE agent_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT,
        system_prompt TEXT NOT NULL, tools_allowed TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agent_definitions(id),
        scope_type TEXT NOT NULL, scope_value TEXT, status TEXT DEFAULT 'pending',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME, summary TEXT, raw_result TEXT
      );
    `);
    oldDb.run('PRAGMA user_version = 26');

    initializeSchema(oldDb);

    expect(oldDb.exec('PRAGMA user_version')[0].values[0][0]).toBe(27);

    oldDb.run(`INSERT INTO agent_definitions (name, system_prompt) VALUES ('a', 'p')`);
    oldDb.run(`INSERT INTO agent_sessions (agent_id, scope_type, scope_value) VALUES (1, 'repo', 'org/repo')`);
    const row = oldDb.exec('SELECT provider, model, parent_session_id FROM agent_sessions')[0].values[0];
    expect(row).toEqual(['ollama', null, null]);

    oldDb.close();
  });

  it('is a no-op when called again on an already-migrated database (idempotent init)', async () => {
    const SQL = await initSqlJs();
    const freshDb = new SQL.Database();
    initializeSchema(freshDb);
    const latestVersion = freshDb.exec('PRAGMA user_version')[0].values[0][0];
    expect(() => initializeSchema(freshDb)).not.toThrow();
    expect(freshDb.exec('PRAGMA user_version')[0].values[0][0]).toBe(latestVersion);
    freshDb.close();
  });
});

describe('Migration v28 -> v29', () => {
  it('creates the ruddr_budgets table and bumps user_version', async () => {
    const SQL = await initSqlJs();
    const oldDb = new SQL.Database();
    oldDb.run('PRAGMA user_version = 28');

    initializeSchema(oldDb);

    expect(oldDb.exec('PRAGMA user_version')[0].values[0][0]).toBe(29);

    const tables = oldDb
      .exec("SELECT name FROM sqlite_master WHERE type='table'")[0]
      .values.map((row: unknown[]) => row[0] as string);
    expect(tables).toContain('ruddr_budgets');

    const columns = oldDb
      .exec('PRAGMA table_info(ruddr_budgets)')[0]
      .values.map((row: unknown[]) => row[1] as string);
    expect(columns).toContain('project_name');
    expect(columns).toContain('budget_left');
    expect(columns).toContain('fetched_at');

    oldDb.close();
  });
});

describe('Migration v25 -> v26', () => {
  it('adds failing_step_name and error_highlights to github_workflow_jobs and bumps user_version', async () => {
    const SQL = await initSqlJs();
    const oldDb = new SQL.Database();
    oldDb.run(`
      CREATE TABLE github_workflow_jobs (
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
    oldDb.run('PRAGMA user_version = 25');

    initializeSchema(oldDb);

    const version = oldDb.exec('PRAGMA user_version');
    expect(version[0].values[0][0]).toBe(26);

    const columns = oldDb
      .exec('PRAGMA table_info(github_workflow_jobs)')[0]
      .values.map((row: unknown[]) => row[1] as string);
    expect(columns).toContain('failing_step_name');
    expect(columns).toContain('error_highlights');

    oldDb.close();
  });

  it('is a no-op when called again after reaching the latest version', async () => {
    const SQL = await initSqlJs();
    const referenceDb = new SQL.Database();
    initializeSchema(referenceDb);
    const latestVersion = referenceDb.exec('PRAGMA user_version')[0].values[0][0];
    referenceDb.close();

    const db2 = new SQL.Database();
    db2.run(getSchema());
    db2.run(`PRAGMA user_version = ${latestVersion}`);

    expect(() => initializeSchema(db2)).not.toThrow();
    const version = db2.exec('PRAGMA user_version');
    expect(version[0].values[0][0]).toBe(latestVersion);

    db2.close();
  });
});
