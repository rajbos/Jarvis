"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sql_js_1 = __importDefault(require("sql.js"));
const schema_1 = require("../../src/storage/schema");
const database_1 = require("../../src/storage/database");
(0, vitest_1.describe)('Database Schema', () => {
    let db;
    (0, vitest_1.beforeEach)(async () => {
        const SQL = await (0, sql_js_1.default)();
        db = new SQL.Database();
        db.run((0, schema_1.getSchema)());
    });
    (0, vitest_1.afterEach)(() => {
        db.close();
    });
    (0, vitest_1.it)('should create all required tables', () => {
        const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        const tableNames = result[0].values.map((row) => row[0]);
        (0, vitest_1.expect)(tableNames).toContain('config');
        (0, vitest_1.expect)(tableNames).toContain('onboarding');
        (0, vitest_1.expect)(tableNames).toContain('github_auth');
        (0, vitest_1.expect)(tableNames).toContain('github_orgs');
        (0, vitest_1.expect)(tableNames).toContain('github_repos');
        (0, vitest_1.expect)(tableNames).toContain('local_repos');
        (0, vitest_1.expect)(tableNames).toContain('conversations');
        (0, vitest_1.expect)(tableNames).toContain('task_history');
    });
    (0, vitest_1.it)('should initialize onboarding steps as pending', () => {
        const result = db.exec('SELECT step, status FROM onboarding ORDER BY step');
        const rows = result[0].values.map((row) => ({ step: row[0], status: row[1] }));
        (0, vitest_1.expect)(rows).toHaveLength(3);
        (0, vitest_1.expect)(rows).toContainEqual({ step: 'github_oauth', status: 'pending' });
        (0, vitest_1.expect)(rows).toContainEqual({ step: 'local_repos', status: 'pending' });
        (0, vitest_1.expect)(rows).toContainEqual({ step: 'ollama', status: 'pending' });
    });
    (0, vitest_1.it)('should allow inserting and reading config values', () => {
        db.run("INSERT INTO config (key, value) VALUES (?, ?)", ['test_key', 'test_value']);
        const stmt = db.prepare("SELECT value FROM config WHERE key = ?");
        stmt.bind(['test_key']);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        (0, vitest_1.expect)(row.value).toBe('test_value');
    });
    (0, vitest_1.it)('should allow inserting github_auth with unique login constraint', () => {
        db.run("INSERT INTO github_auth (login, access_token, scopes) VALUES (?, ?, ?)", ['testuser', 'encrypted_token', 'repo,read:org']);
        const stmt = db.prepare('SELECT login, scopes FROM github_auth WHERE login = ?');
        stmt.bind(['testuser']);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        (0, vitest_1.expect)(row.login).toBe('testuser');
        (0, vitest_1.expect)(row.scopes).toBe('repo,read:org');
        // Inserting same login should fail (unique constraint)
        (0, vitest_1.expect)(() => {
            db.run("INSERT INTO github_auth (login, access_token, scopes) VALUES (?, ?, ?)", ['testuser', 'another_token', 'repo']);
        }).toThrow();
    });
    (0, vitest_1.it)('should support foreign key from local_repos to github_repos', () => {
        db.run("PRAGMA foreign_keys = ON");
        // Insert a github_repo first
        db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", ['org/repo', 'repo']);
        const repoResult = db.exec("SELECT id FROM github_repos WHERE full_name = 'org/repo'");
        const repoId = repoResult[0].values[0][0];
        // Insert local_repo referencing it
        db.run("INSERT INTO local_repos (local_path, remote_url, github_repo_id) VALUES (?, ?, ?)", ['C:\\repos\\repo', 'https://github.com/org/repo.git', repoId]);
        const localResult = db.exec("SELECT github_repo_id FROM local_repos WHERE local_path = 'C:\\repos\\repo'");
        (0, vitest_1.expect)(localResult[0].values[0][0]).toBe(repoId);
    });
    (0, vitest_1.it)('getConfigValue returns null for non-existent key', () => {
        (0, vitest_1.expect)((0, database_1.getConfigValue)(db, 'nonexistent')).toBeNull();
    });
    (0, vitest_1.it)('setConfigValue writes and getConfigValue reads back', () => {
        (0, database_1.setConfigValue)(db, 'force_oauth_discovery', '1');
        (0, vitest_1.expect)((0, database_1.getConfigValue)(db, 'force_oauth_discovery')).toBe('1');
        (0, database_1.setConfigValue)(db, 'force_oauth_discovery', '0');
        (0, vitest_1.expect)((0, database_1.getConfigValue)(db, 'force_oauth_discovery')).toBe('0');
        (0, database_1.setConfigValue)(db, 'force_pat_discovery', '1');
        (0, vitest_1.expect)((0, database_1.getConfigValue)(db, 'force_pat_discovery')).toBe('1');
    });
});
//# sourceMappingURL=database.test.js.map