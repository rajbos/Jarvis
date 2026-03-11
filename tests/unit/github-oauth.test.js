"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sql_js_1 = __importDefault(require("sql.js"));
const schema_1 = require("../../src/storage/schema");
const github_oauth_1 = require("../../src/services/github-oauth");
(0, vitest_1.describe)('GitHub OAuth — Token Storage', () => {
    let db;
    (0, vitest_1.beforeEach)(async () => {
        // Set a deterministic encryption key for tests
        process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests';
        const SQL = await (0, sql_js_1.default)();
        db = new SQL.Database();
        db.run((0, schema_1.getSchema)());
    });
    (0, vitest_1.afterEach)(() => {
        db.close();
        delete process.env.JARVIS_ENCRYPTION_KEY;
    });
    (0, vitest_1.it)('should save and load an encrypted token', () => {
        const login = 'testuser';
        const token = 'ghp_real_access_token_12345';
        const scopes = 'repo,read:org';
        (0, github_oauth_1.saveGitHubAuth)(db, login, token, scopes);
        // Verify the token is stored encrypted (not plaintext)
        const stmt = db.prepare('SELECT access_token FROM github_auth WHERE login = ?');
        stmt.bind([login]);
        stmt.step();
        const rawRow = stmt.getAsObject();
        stmt.free();
        (0, vitest_1.expect)(rawRow.access_token).not.toBe(token);
        // Load and decrypt
        const loaded = (0, github_oauth_1.loadGitHubAuth)(db);
        (0, vitest_1.expect)(loaded).not.toBeNull();
        (0, vitest_1.expect)(loaded.login).toBe(login);
        (0, vitest_1.expect)(loaded.accessToken).toBe(token);
        (0, vitest_1.expect)(loaded.scopes).toBe(scopes);
    });
    (0, vitest_1.it)('should return null when no auth exists', () => {
        const loaded = (0, github_oauth_1.loadGitHubAuth)(db);
        (0, vitest_1.expect)(loaded).toBeNull();
    });
    (0, vitest_1.it)('should upsert on conflict (same login)', () => {
        (0, github_oauth_1.saveGitHubAuth)(db, 'user1', 'token_v1', 'repo');
        (0, github_oauth_1.saveGitHubAuth)(db, 'user1', 'token_v2', 'repo,read:org');
        const loaded = (0, github_oauth_1.loadGitHubAuth)(db);
        (0, vitest_1.expect)(loaded.accessToken).toBe('token_v2');
        (0, vitest_1.expect)(loaded.scopes).toBe('repo,read:org');
        // Should only have one row
        const result = db.exec('SELECT COUNT(*) as cnt FROM github_auth');
        (0, vitest_1.expect)(result[0].values[0][0]).toBe(1);
    });
    (0, vitest_1.it)('should save, load, and delete a PAT', () => {
        (0, github_oauth_1.saveGitHubAuth)(db, 'user1', 'token1', 'repo');
        (0, vitest_1.expect)((0, github_oauth_1.loadGitHubPat)(db)).toBeNull();
        (0, github_oauth_1.saveGitHubPat)(db, 'user1', 'ghp_mypat123');
        (0, vitest_1.expect)((0, github_oauth_1.loadGitHubPat)(db)).toBe('ghp_mypat123');
        // Verify stored encrypted
        const stmt = db.prepare('SELECT pat FROM github_auth WHERE login = ?');
        stmt.bind(['user1']);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        (0, vitest_1.expect)(row.pat).not.toBe('ghp_mypat123');
        (0, github_oauth_1.deleteGitHubPat)(db, 'user1');
        (0, vitest_1.expect)((0, github_oauth_1.loadGitHubPat)(db)).toBeNull();
    });
});
//# sourceMappingURL=github-oauth.test.js.map