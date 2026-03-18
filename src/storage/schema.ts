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
        starred         INTEGER DEFAULT 0,
        collaboration_reason TEXT,
        last_pushed_at  DATETIME,
        last_updated_at DATETIME,
        indexed_at      DATETIME,
        metadata        TEXT
    );

    -- Folders configured for local repo scanning
    CREATE TABLE IF NOT EXISTS local_scan_folders (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        path     TEXT NOT NULL UNIQUE,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Local repository clones
    CREATE TABLE IF NOT EXISTS local_repos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        local_path     TEXT NOT NULL UNIQUE,
        name           TEXT,
        remote_url     TEXT,
        github_repo_id INTEGER REFERENCES github_repos(id),
        discovered_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_scanned   DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_local_repos_github_repo_id ON local_repos(github_repo_id);

    -- Git remotes for local repos (supports multiple remotes per repo)
    CREATE TABLE IF NOT EXISTS local_repo_remotes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        local_repo_id  INTEGER NOT NULL REFERENCES local_repos(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        url            TEXT NOT NULL,
        github_repo_id INTEGER REFERENCES github_repos(id),
        UNIQUE(local_repo_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_local_repo_remotes_local_repo_id ON local_repo_remotes(local_repo_id);

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

    -- GitHub notifications cache
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
    );
    CREATE INDEX IF NOT EXISTS idx_notif_repo ON github_notifications(repo_full_name);
    CREATE INDEX IF NOT EXISTS idx_notif_owner ON github_notifications(repo_owner);

    -- GitHub Actions secrets scanned per repo
    CREATE TABLE IF NOT EXISTS repo_secrets (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        github_repo_id INTEGER NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
        secret_name    TEXT NOT NULL,
        scanned_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(github_repo_id, secret_name)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_secrets_repo_id ON repo_secrets(github_repo_id);

    -- Orgs/repos favorited for extended secrets scanning
    CREATE TABLE IF NOT EXISTS secret_scan_favorites (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL CHECK(target_type IN ('org', 'repo')),
        target_name TEXT NOT NULL UNIQUE,
        added_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;
}
