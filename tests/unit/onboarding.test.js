"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sql_js_1 = __importDefault(require("sql.js"));
const schema_1 = require("../../src/storage/schema");
const onboarding_1 = require("../../src/agent/onboarding");
(0, vitest_1.describe)('Onboarding', () => {
    let db;
    (0, vitest_1.beforeEach)(async () => {
        const SQL = await (0, sql_js_1.default)();
        db = new SQL.Database();
        db.run((0, schema_1.getSchema)());
    });
    (0, vitest_1.afterEach)(() => {
        db.close();
    });
    (0, vitest_1.it)('should return all steps as pending initially', () => {
        const status = (0, onboarding_1.getOnboardingStatus)(db);
        (0, vitest_1.expect)(status.ollama).toBe('pending');
        (0, vitest_1.expect)(status.local_repos).toBe('pending');
        (0, vitest_1.expect)(status.github_oauth).toBe('pending');
    });
    (0, vitest_1.it)('should mark a step as completed', () => {
        (0, onboarding_1.completeOnboardingStep)(db, 'github_oauth');
        const status = (0, onboarding_1.getOnboardingStatus)(db);
        (0, vitest_1.expect)(status.github_oauth).toBe('completed');
        (0, vitest_1.expect)(status.ollama).toBe('pending');
        (0, vitest_1.expect)(status.local_repos).toBe('pending');
    });
    (0, vitest_1.it)('should mark a step as skipped', () => {
        (0, onboarding_1.skipOnboardingStep)(db, 'ollama');
        const status = (0, onboarding_1.getOnboardingStatus)(db);
        (0, vitest_1.expect)(status.ollama).toBe('skipped');
        (0, vitest_1.expect)(status.github_oauth).toBe('pending');
    });
    (0, vitest_1.it)('should set completed_at when completing a step', () => {
        (0, onboarding_1.completeOnboardingStep)(db, 'local_repos');
        const stmt = db.prepare('SELECT completed_at FROM onboarding WHERE step = ?');
        stmt.bind(['local_repos']);
        stmt.step();
        const row = stmt.getAsObject();
        stmt.free();
        (0, vitest_1.expect)(row.completed_at).not.toBeNull();
    });
});
//# sourceMappingURL=onboarding.test.js.map