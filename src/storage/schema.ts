export function getSchema(): string {
  return `
    -- Agent configuration
    CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- Onboarding state
    CREATE TABLE IF NOT EXISTS onboarding (
        step         TEXT PRIMARY KEY,
        status       TEXT DEFAULT 'pending',
        completed_at DATETIME
    );

    -- Initialize onboarding steps
    INSERT OR IGNORE INTO onboarding (step, status) VALUES ('ollama', 'pending');
    INSERT OR IGNORE INTO onboarding (step, status) VALUES ('local_repos', 'pending');
    INSERT OR IGNORE INTO onboarding (step, status) VALUES ('github_oauth', 'pending');

    -- GitHub OAuth session
    CREATE TABLE IF NOT EXISTS github_auth (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT NOT NULL UNIQUE,
        access_token  TEXT NOT NULL,
        refresh_token TEXT,
        scopes        TEXT,
        avatar_url    TEXT,
        pat           TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at    DATETIME
    );

    -- GitHub organizations being tracked
    CREATE TABLE IF NOT EXISTS github_orgs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        login             TEXT NOT NULL UNIQUE,
        name              TEXT,
        discovery_enabled INTEGER DEFAULT 1,
        indexed_at        DATETIME,
        metadata          TEXT
    );

    -- GitHub repositories index (remote)
    CREATE TABLE IF NOT EXISTS github_repos (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id          INTEGER REFERENCES github_orgs(id),
        full_name       TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        description     TEXT,
        default_branch  TEXT,
        language        TEXT,
        archived        INTEGER DEFAULT 0,
        fork            INTEGER DEFAULT 0,
        parent_full_name TEXT,
        private         INTEGER DEFAULT 0,
        last_pushed_at  DATETIME,
        last_updated_at DATETIME,
        indexed_at      DATETIME,
        metadata        TEXT
    );

    -- Local repository clones
    CREATE TABLE IF NOT EXISTS local_repos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        local_path     TEXT NOT NULL UNIQUE,
        remote_url     TEXT,
        github_repo_id INTEGER REFERENCES github_repos(id),
        discovered_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_scanned   DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_local_repos_github_repo_id ON local_repos(github_repo_id);

    -- Conversation / interaction log
    CREATE TABLE IF NOT EXISTS conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        tool_calls TEXT
    );

    -- Task history
    CREATE TABLE IF NOT EXISTS task_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
        task_type   TEXT NOT NULL,
        description TEXT,
        status      TEXT DEFAULT 'pending',
        result      TEXT
    );
  `;
}
