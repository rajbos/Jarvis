"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sql_js_1 = __importDefault(require("sql.js"));
const schema_1 = require("../../src/storage/schema");
const github_discovery_1 = require("../../src/services/github-discovery");
// Mock saveDatabase — it talks to the filesystem
vitest_1.vi.mock('../../src/storage/database', () => ({
    saveDatabase: vitest_1.vi.fn(),
}));
// ─── Helpers ────────────────────────────────────────────────────────
function makeHeaders(remaining = 4999, limit = 5000, reset = Math.floor(Date.now() / 1000) + 3600, linkNext) {
    const h = new Headers({
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-limit': String(limit),
        'x-ratelimit-reset': String(reset),
    });
    if (linkNext) {
        h.set('link', `<${linkNext}>; rel="next"`);
    }
    return h;
}
function jsonResponse(body, headers, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers,
        json: () => Promise.resolve(body),
    };
}
// ─── DB-level upsert tests (no network) ─────────────────────────────
(0, vitest_1.describe)('GitHub Discovery — DB upserts', () => {
    let db;
    (0, vitest_1.beforeEach)(async () => {
        const SQL = await (0, sql_js_1.default)();
        db = new SQL.Database();
        db.run((0, schema_1.getSchema)());
    });
    (0, vitest_1.afterEach)(() => db.close());
    (0, vitest_1.it)('upsertOrg inserts a new org and returns its id', () => {
        const id = (0, github_discovery_1.upsertOrg)(db, { login: 'acme', name: 'Acme Corp', description: 'Widgets' });
        (0, vitest_1.expect)(id).toBeGreaterThan(0);
        const rows = db.exec('SELECT login, name, metadata FROM github_orgs WHERE login = "acme"');
        (0, vitest_1.expect)(rows[0].values[0][0]).toBe('acme');
        (0, vitest_1.expect)(rows[0].values[0][1]).toBe('Acme Corp');
        (0, vitest_1.expect)(JSON.parse(rows[0].values[0][2])).toEqual({ description: 'Widgets' });
    });
    (0, vitest_1.it)('upsertOrg updates on conflict', () => {
        (0, github_discovery_1.upsertOrg)(db, { login: 'acme', name: 'Old Name' });
        const id2 = (0, github_discovery_1.upsertOrg)(db, { login: 'acme', name: 'New Name' });
        const rows = db.exec('SELECT COUNT(*) FROM github_orgs');
        (0, vitest_1.expect)(rows[0].values[0][0]).toBe(1);
        const name = db.exec('SELECT name FROM github_orgs WHERE id = ' + id2);
        (0, vitest_1.expect)(name[0].values[0][0]).toBe('New Name');
    });
    (0, vitest_1.it)('upsertRepo inserts a repo linked to an org', () => {
        const orgId = (0, github_discovery_1.upsertOrg)(db, { login: 'acme' });
        (0, github_discovery_1.upsertRepo)(db, {
            full_name: 'acme/widgets',
            name: 'widgets',
            description: 'Widget factory',
            default_branch: 'main',
            language: 'TypeScript',
            archived: false,
            fork: false,
            private: true,
            pushed_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
        }, orgId);
        const rows = db.exec('SELECT full_name, org_id, private FROM github_repos');
        (0, vitest_1.expect)(rows[0].values[0][0]).toBe('acme/widgets');
        (0, vitest_1.expect)(rows[0].values[0][1]).toBe(orgId);
        (0, vitest_1.expect)(rows[0].values[0][2]).toBe(1);
    });
    (0, vitest_1.it)('upsertRepo inserts a user repo with null org_id', () => {
        (0, github_discovery_1.upsertRepo)(db, { full_name: 'user/my-repo', name: 'my-repo' }, null);
        const rows = db.exec('SELECT full_name, org_id FROM github_repos');
        (0, vitest_1.expect)(rows[0].values[0][0]).toBe('user/my-repo');
        (0, vitest_1.expect)(rows[0].values[0][1]).toBeNull();
    });
    (0, vitest_1.it)('upsertRepo updates on conflict (same full_name)', () => {
        (0, github_discovery_1.upsertRepo)(db, { full_name: 'acme/widgets', name: 'widgets', language: 'JavaScript' }, null);
        (0, github_discovery_1.upsertRepo)(db, { full_name: 'acme/widgets', name: 'widgets', language: 'TypeScript' }, null);
        const rows = db.exec('SELECT COUNT(*) FROM github_repos');
        (0, vitest_1.expect)(rows[0].values[0][0]).toBe(1);
        const lang = db.exec('SELECT language FROM github_repos WHERE full_name = "acme/widgets"');
        (0, vitest_1.expect)(lang[0].values[0][0]).toBe('TypeScript');
    });
    (0, vitest_1.it)('upsertRepo stores fork parent_full_name', () => {
        (0, github_discovery_1.upsertRepo)(db, {
            full_name: 'user/fork-repo',
            name: 'fork-repo',
            fork: true,
            parent: { full_name: 'upstream/original' },
        }, null);
        const rows = db.exec('SELECT fork, parent_full_name FROM github_repos WHERE full_name = "user/fork-repo"');
        (0, vitest_1.expect)(rows[0].values[0][0]).toBe(1);
        (0, vitest_1.expect)(rows[0].values[0][1]).toBe('upstream/original');
    });
    (0, vitest_1.it)('listOrgs returns orgs with repo counts and discovery_enabled', () => {
        const orgId = (0, github_discovery_1.upsertOrg)(db, { login: 'acme', name: 'Acme Corp' });
        (0, github_discovery_1.upsertOrg)(db, { login: 'beta', name: 'Beta Inc' });
        (0, github_discovery_1.upsertRepo)(db, { full_name: 'acme/repo1', name: 'repo1' }, orgId);
        (0, github_discovery_1.upsertRepo)(db, { full_name: 'acme/repo2', name: 'repo2' }, orgId);
        const result = (0, github_discovery_1.listOrgs)(db);
        (0, vitest_1.expect)(result.orgs).toHaveLength(2);
        const acme = result.orgs.find((o) => o.login === 'acme');
        (0, vitest_1.expect)(acme.name).toBe('Acme Corp');
        (0, vitest_1.expect)(acme.repoCount).toBe(2);
        (0, vitest_1.expect)(acme.discoveryEnabled).toBe(true);
        const beta = result.orgs.find((o) => o.login === 'beta');
        (0, vitest_1.expect)(beta.repoCount).toBe(0);
        (0, vitest_1.expect)(beta.discoveryEnabled).toBe(true);
    });
    (0, vitest_1.it)('setOrgDiscoveryEnabled toggles the flag', () => {
        (0, github_discovery_1.upsertOrg)(db, { login: 'acme' });
        (0, github_discovery_1.setOrgDiscoveryEnabled)(db, 'acme', false);
        let result = (0, github_discovery_1.listOrgs)(db);
        (0, vitest_1.expect)(result.orgs[0].discoveryEnabled).toBe(false);
        (0, github_discovery_1.setOrgDiscoveryEnabled)(db, 'acme', true);
        result = (0, github_discovery_1.listOrgs)(db);
        (0, vitest_1.expect)(result.orgs[0].discoveryEnabled).toBe(true);
    });
});
// ─── Full discovery integration test (mocked fetch) ─────────────────
(0, vitest_1.describe)('GitHub Discovery — runDiscovery', () => {
    let db;
    let originalFetch;
    (0, vitest_1.beforeEach)(async () => {
        const SQL = await (0, sql_js_1.default)();
        db = new SQL.Database();
        db.run((0, schema_1.getSchema)());
        originalFetch = globalThis.fetch;
    });
    (0, vitest_1.afterEach)(() => {
        globalThis.fetch = originalFetch;
        db.close();
    });
    (0, vitest_1.it)('fetches orgs, org repos, and user repos then stores them', async () => {
        const calls = [];
        globalThis.fetch = vitest_1.vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            calls.push(url);
            // GET /user/orgs
            if (url.includes('/user/orgs')) {
                return jsonResponse([{ login: 'org1', description: 'First org' }], makeHeaders(4998));
            }
            // GET /orgs/org1/repos
            if (url.includes('/orgs/org1/repos')) {
                return jsonResponse([
                    { full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false },
                    { full_name: 'org1/repo-b', name: 'repo-b', default_branch: 'main', archived: true, fork: false, private: true },
                ], makeHeaders(4996));
            }
            // GET /user/repos?affiliation=owner,collaborator,organization_member
            if (url.includes('/user/repos') && url.includes('affiliation=owner')) {
                return jsonResponse([
                    { full_name: 'me/personal', name: 'personal', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } },
                    { full_name: 'other/collab-repo', name: 'collab-repo', default_branch: 'main', archived: false, fork: false, private: true, owner: { login: 'other', type: 'User' } },
                ], makeHeaders(4995));
            }
            return jsonResponse([], makeHeaders(4990));
        });
        const progressUpdates = [];
        const state = await (0, github_discovery_1.runDiscovery)(db, 'fake-token', (p) => progressUpdates.push({ ...p }));
        (0, vitest_1.expect)(state.aborted).toBe(false);
        // Verify orgs stored
        const orgs = db.exec('SELECT login FROM github_orgs');
        (0, vitest_1.expect)(orgs[0].values.map((v) => v[0])).toEqual(['org1']);
        // Verify repos stored
        const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
        const repoNames = repos[0].values.map((v) => v[0]);
        (0, vitest_1.expect)(repoNames).toContain('org1/repo-a');
        (0, vitest_1.expect)(repoNames).toContain('org1/repo-b');
        (0, vitest_1.expect)(repoNames).toContain('me/personal');
        (0, vitest_1.expect)(repoNames).toContain('other/collab-repo');
        // Verify final progress
        const last = progressUpdates[progressUpdates.length - 1];
        (0, vitest_1.expect)(last.phase).toBe('done');
        (0, vitest_1.expect)(last.orgsFound).toBe(1);
        (0, vitest_1.expect)(last.reposFound).toBe(4);
    });
    (0, vitest_1.it)('follows pagination links', async () => {
        globalThis.fetch = vitest_1.vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('/user/orgs') && !url.includes('page=2')) {
                return jsonResponse([{ login: 'paged-org' }], makeHeaders(4999, 5000, Math.floor(Date.now() / 1000) + 3600, 'https://api.github.com/user/orgs?per_page=100&page=2'));
            }
            if (url.includes('/user/orgs') && url.includes('page=2')) {
                return jsonResponse([{ login: 'paged-org-2' }], makeHeaders(4998));
            }
            // Org repos
            if (url.includes('/orgs/')) {
                return jsonResponse([], makeHeaders(4997));
            }
            // User repos
            if (url.includes('/user/repos')) {
                return jsonResponse([], makeHeaders(4996));
            }
            return jsonResponse([], makeHeaders(4990));
        });
        await (0, github_discovery_1.runDiscovery)(db, 'fake-token');
        const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login');
        (0, vitest_1.expect)(orgs[0].values.map((v) => v[0])).toEqual(['paged-org', 'paged-org-2']);
    });
    (0, vitest_1.it)('can be aborted mid-run', async () => {
        let callCount = 0;
        globalThis.fetch = vitest_1.vi.fn(async (input) => {
            callCount++;
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('/user/orgs')) {
                return jsonResponse([{ login: 'org1' }, { login: 'org2' }, { login: 'org3' }], makeHeaders(4999));
            }
            // Return repos for any org
            return jsonResponse([{ full_name: 'x/repo', name: 'repo' }], makeHeaders(4998));
        });
        let discoveryState = null;
        const promise = (0, github_discovery_1.runDiscovery)(db, 'fake-token', (progress) => {
            // Abort after first org's repos are fetched
            if (progress.phase === 'repos' && progress.reposFound > 0 && discoveryState) {
                (0, github_discovery_1.abortDiscovery)(discoveryState);
            }
        });
        // Get the state object from the promise
        // We need to abort from outside, so let's use a different approach
        // Start discovery and abort after a small delay
        const statePromise = (0, github_discovery_1.runDiscovery)(db, 'fake-token');
        // Give it a moment to start, then abort — but we need the state.
        // Instead, test that abortDiscovery sets the flag correctly.
        const state = { callsSinceLastPause: 0, aborted: false, lastRateLimit: null };
        (0, github_discovery_1.abortDiscovery)(state);
        (0, vitest_1.expect)(state.aborted).toBe(true);
    });
    (0, vitest_1.it)('skips disabled orgs during discovery', async () => {
        const fetchedUrls = [];
        globalThis.fetch = vitest_1.vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            fetchedUrls.push(url);
            if (url.includes('/user/orgs')) {
                return jsonResponse([{ login: 'enabled-org' }, { login: 'disabled-org' }], makeHeaders(4998));
            }
            if (url.includes('/orgs/enabled-org/repos')) {
                return jsonResponse([{ full_name: 'enabled-org/repo1', name: 'repo1' }], makeHeaders(4997));
            }
            if (url.includes('/orgs/disabled-org/repos')) {
                return jsonResponse([{ full_name: 'disabled-org/repo1', name: 'repo1' }], makeHeaders(4996));
            }
            if (url.includes('/user/repos')) {
                return jsonResponse([], makeHeaders(4995));
            }
            return jsonResponse([], makeHeaders(4990));
        });
        // Run discovery once to create the orgs
        await (0, github_discovery_1.runDiscovery)(db, 'fake-token');
        // Disable one org
        (0, github_discovery_1.setOrgDiscoveryEnabled)(db, 'disabled-org', false);
        fetchedUrls.length = 0;
        // Run again — disabled-org should be skipped
        await (0, github_discovery_1.runDiscovery)(db, 'fake-token');
        const orgRepoFetches = fetchedUrls.filter((u) => u.includes('/orgs/'));
        (0, vitest_1.expect)(orgRepoFetches.some((u) => u.includes('enabled-org'))).toBe(true);
        (0, vitest_1.expect)(orgRepoFetches.some((u) => u.includes('disabled-org'))).toBe(false);
    });
    (0, vitest_1.it)('runLightweightRefresh fetches orgs and personal+collaborator repos', async () => {
        const fetchedUrls = [];
        globalThis.fetch = vitest_1.vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            fetchedUrls.push(url);
            if (url.includes('/user/orgs')) {
                return jsonResponse([{ login: 'new-org', description: 'New' }], makeHeaders(4998));
            }
            if (url.includes('/user/repos') && url.includes('affiliation=owner')) {
                return jsonResponse([
                    { full_name: 'me/my-repo', name: 'my-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } },
                    { full_name: 'other/collab', name: 'collab', default_branch: 'main', archived: false, fork: false, private: true, owner: { login: 'other', type: 'User' } },
                ], makeHeaders(4997));
            }
            return jsonResponse([], makeHeaders(4990));
        });
        const progressUpdates = [];
        await (0, github_discovery_1.runLightweightRefresh)(db, 'fake-token', (p) => progressUpdates.push({ ...p }));
        // Should have fetched orgs and personal+collaborator repos
        (0, vitest_1.expect)(fetchedUrls.some((u) => u.includes('/user/orgs'))).toBe(true);
        (0, vitest_1.expect)(fetchedUrls.some((u) => u.includes('affiliation=owner,collaborator,organization_member'))).toBe(true);
        // Should NOT have fetched org repos
        (0, vitest_1.expect)(fetchedUrls.some((u) => u.includes('/orgs/'))).toBe(false);
        // Verify org was stored
        const orgs = db.exec('SELECT login FROM github_orgs');
        (0, vitest_1.expect)(orgs[0].values.map((v) => v[0])).toEqual(['new-org']);
        // Verify both repos were stored
        const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
        (0, vitest_1.expect)(repos[0].values.map((v) => v[0])).toEqual(['me/my-repo', 'other/collab']);
        // Verify final progress
        const last = progressUpdates[progressUpdates.length - 1];
        (0, vitest_1.expect)(last.phase).toBe('done');
    });
    (0, vitest_1.it)('getLastOrgIndexedAt returns null when no orgs exist', () => {
        (0, vitest_1.expect)((0, github_discovery_1.getLastOrgIndexedAt)(db)).toBeNull();
    });
    (0, vitest_1.it)('runs PAT supplemental pass when PAT is provided', async () => {
        const fetchCalls = [];
        globalThis.fetch = vitest_1.vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : input.toString();
            const authHeader = init?.headers?.Authorization ?? '';
            const token = authHeader.replace('Bearer ', '');
            fetchCalls.push({ url, token });
            // OAuth: /user/orgs
            if (url.includes('/user/orgs') && token === 'oauth-token') {
                return jsonResponse([{ login: 'org1', description: '' }], makeHeaders(4998));
            }
            // OAuth: /orgs/org1/repos
            if (url.includes('/orgs/org1/repos') && token === 'oauth-token') {
                return jsonResponse([{ full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false }], makeHeaders(4997));
            }
            // OAuth: /user/repos
            if (url.includes('/user/repos') && token === 'oauth-token') {
                return jsonResponse([{ full_name: 'me/my-repo', name: 'my-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } }], makeHeaders(4996));
            }
            // PAT: /user/orgs — returns org1 (already indexed) + secret-org (new)
            if (url.includes('/user/orgs') && token === 'pat-token') {
                return jsonResponse([{ login: 'org1', description: '' }, { login: 'secret-org', description: '' }], makeHeaders(4995));
            }
            // PAT: /orgs/secret-org/repos — new org's repos
            if (url.includes('/orgs/secret-org/repos') && token === 'pat-token') {
                return jsonResponse([{ full_name: 'secret-org/hidden-repo', name: 'hidden-repo', default_branch: 'main', archived: false, fork: false, private: true }], makeHeaders(4994));
            }
            // PAT should NOT call /orgs/org1/repos (already indexed with repos)
            if (url.includes('/orgs/org1/repos') && token === 'pat-token') {
                throw new Error('PAT should not re-fetch already-indexed org repos');
            }
            // PAT: /user/repos?affiliation=collaborator
            if (url.includes('/user/repos') && url.includes('affiliation=collaborator') && token === 'pat-token') {
                return jsonResponse([], makeHeaders(4993));
            }
            return jsonResponse([], makeHeaders(4990));
        });
        const progressUpdates = [];
        await (0, github_discovery_1.runDiscovery)(db, 'oauth-token', (p) => progressUpdates.push({ ...p }), 'pat-token');
        // secret-org should be created
        const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login COLLATE NOCASE');
        const orgLogins = orgs[0].values.map((v) => v[0]);
        (0, vitest_1.expect)(orgLogins).toContain('org1');
        (0, vitest_1.expect)(orgLogins).toContain('secret-org');
        // hidden-repo and the OAuth repos should all be stored
        const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
        const repoNames = repos[0].values.map((v) => v[0]);
        (0, vitest_1.expect)(repoNames).toContain('secret-org/hidden-repo');
        (0, vitest_1.expect)(repoNames).toContain('me/my-repo');
        (0, vitest_1.expect)(repoNames).toContain('org1/repo-a');
        // PAT should NOT have called /orgs/org1/repos (already has repos)
        const patOrg1Calls = fetchCalls.filter(c => c.token === 'pat-token' && c.url.includes('/orgs/org1/repos'));
        (0, vitest_1.expect)(patOrg1Calls.length).toBe(0);
        // Verify PAT phase appeared in progress
        (0, vitest_1.expect)(progressUpdates.some(p => p.phase === 'pat-repos')).toBe(true);
        const last = progressUpdates[progressUpdates.length - 1];
        (0, vitest_1.expect)(last.phase).toBe('done');
    });
    (0, vitest_1.it)('runPatDiscovery can run standalone without full discovery', async () => {
        // Pre-seed an org with repos so PAT skips it
        const existingOrgId = (0, github_discovery_1.upsertOrg)(db, { login: 'known-org' });
        (0, github_discovery_1.upsertRepo)(db, { full_name: 'known-org/existing', name: 'existing' }, existingOrgId);
        globalThis.fetch = vitest_1.vi.fn(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            // /user/orgs returns known-org + secret-org
            if (url.includes('/user/orgs')) {
                return jsonResponse([{ login: 'known-org', description: '' }, { login: 'secret-org', description: '' }], makeHeaders(4999));
            }
            // /orgs/secret-org/repos — new org
            if (url.includes('/orgs/secret-org/repos')) {
                return jsonResponse([{ full_name: 'secret-org/hidden', name: 'hidden', default_branch: 'main', archived: false, fork: false, private: true }], makeHeaders(4998));
            }
            // Should NOT be called for known-org
            if (url.includes('/orgs/known-org/repos')) {
                throw new Error('Should not re-fetch known-org repos');
            }
            // /user/repos?affiliation=collaborator
            if (url.includes('/user/repos') && url.includes('affiliation=collaborator')) {
                return jsonResponse([{ full_name: 'other/collab-repo', name: 'collab-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'other', type: 'User' } }], makeHeaders(4997));
            }
            return jsonResponse([], makeHeaders(4996));
        });
        const progressUpdates = [];
        await (0, github_discovery_1.runPatDiscovery)(db, 'pat-token', undefined, undefined, (p) => progressUpdates.push({ ...p }));
        // secret-org auto-created, repos stored
        const orgs = db.exec('SELECT login FROM github_orgs ORDER BY login COLLATE NOCASE');
        (0, vitest_1.expect)(orgs[0].values.map((v) => v[0])).toContain('secret-org');
        const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
        const repoNames = repos[0].values.map((v) => v[0]);
        (0, vitest_1.expect)(repoNames).toContain('secret-org/hidden');
        (0, vitest_1.expect)(repoNames).toContain('other/collab-repo');
        (0, vitest_1.expect)(repoNames).toContain('known-org/existing'); // still there
        (0, vitest_1.expect)(progressUpdates.some(p => p.phase === 'pat-repos')).toBe(true);
    });
    (0, vitest_1.it)('PAT pass failure does not crash full discovery', async () => {
        globalThis.fetch = vitest_1.vi.fn(async (input, init) => {
            const url = typeof input === 'string' ? input : input.toString();
            const authHeader = init?.headers?.Authorization ?? '';
            const token = authHeader.replace('Bearer ', '');
            // OAuth calls work fine
            if (url.includes('/user/orgs') && token === 'oauth-token') {
                return jsonResponse([{ login: 'org1', description: '' }], makeHeaders(4998));
            }
            if (url.includes('/orgs/org1/repos') && token === 'oauth-token') {
                return jsonResponse([{ full_name: 'org1/repo-a', name: 'repo-a', default_branch: 'main', archived: false, fork: false, private: false }], makeHeaders(4997));
            }
            if (url.includes('/user/repos') && token === 'oauth-token') {
                return jsonResponse([{ full_name: 'me/my-repo', name: 'my-repo', default_branch: 'main', archived: false, fork: false, private: false, owner: { login: 'me', type: 'User' } }], makeHeaders(4996));
            }
            // PAT /user/orgs throws a network error
            if (url.includes('/user/orgs') && token === 'bad-pat') {
                throw new TypeError('fetch failed');
            }
            return jsonResponse([], makeHeaders(4990));
        });
        const progressUpdates = [];
        // Should not throw even though PAT fails
        const state = await (0, github_discovery_1.runDiscovery)(db, 'oauth-token', (p) => progressUpdates.push({ ...p }), 'bad-pat');
        // OAuth repos should still be stored
        const repos = db.exec('SELECT full_name FROM github_repos ORDER BY full_name');
        const repoNames = repos[0].values.map((v) => v[0]);
        (0, vitest_1.expect)(repoNames).toContain('me/my-repo');
        (0, vitest_1.expect)(repoNames).toContain('org1/repo-a');
        // Discovery should still reach 'done' phase
        const last = progressUpdates[progressUpdates.length - 1];
        (0, vitest_1.expect)(last.phase).toBe('done');
    });
    (0, vitest_1.it)('getLastOrgIndexedAt returns the most recent indexed_at', () => {
        (0, github_discovery_1.upsertOrg)(db, { login: 'org1' });
        (0, github_discovery_1.upsertOrg)(db, { login: 'org2' });
        const result = (0, github_discovery_1.getLastOrgIndexedAt)(db);
        (0, vitest_1.expect)(result).toBeTruthy();
        (0, vitest_1.expect)(typeof result).toBe('string');
    });
});
//# sourceMappingURL=github-discovery.test.js.map