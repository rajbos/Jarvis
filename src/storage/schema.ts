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
        subject_actor_login TEXT,
        subject_actor_type  TEXT,
        reason         TEXT,
        unread         INTEGER DEFAULT 1,
        updated_at     TEXT,
        fetched_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notif_repo ON github_notifications(repo_full_name);
    CREATE INDEX IF NOT EXISTS idx_notif_owner ON github_notifications(repo_owner);

    -- Cached GitHub Actions workflow runs
    CREATE TABLE IF NOT EXISTS github_workflow_runs (
        id              TEXT PRIMARY KEY,
        repo_full_name  TEXT NOT NULL,
        workflow_name   TEXT,
        workflow_id     TEXT,
        head_branch     TEXT,
        head_sha        TEXT,
        event           TEXT,
        status          TEXT,
        conclusion      TEXT,
        run_number      INTEGER,
        run_started_at  DATETIME,
        updated_at      DATETIME,
        html_url        TEXT,
        fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wf_runs_repo ON github_workflow_runs(repo_full_name);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_conclusion ON github_workflow_runs(repo_full_name, conclusion);

    -- Per-job details for a workflow run (identifies failing step + log excerpt)
    CREATE TABLE IF NOT EXISTS github_workflow_jobs (
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
    );
    CREATE INDEX IF NOT EXISTS idx_wf_jobs_run ON github_workflow_jobs(run_id);

    -- Configurable LLM agent use cases
    CREATE TABLE IF NOT EXISTS agent_definitions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE,
        description   TEXT,
        system_prompt TEXT NOT NULL,
        tools_allowed TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Agent run sessions
    CREATE TABLE IF NOT EXISTS agent_sessions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id      INTEGER NOT NULL REFERENCES agent_definitions(id),
        scope_type    TEXT NOT NULL,
        scope_value   TEXT,
        status        TEXT DEFAULT 'pending',
        started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at  DATETIME,
        summary       TEXT,
        raw_result    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);

    -- Structured findings emitted by an agent session
    CREATE TABLE IF NOT EXISTS agent_findings (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        finding_type  TEXT NOT NULL,
        subject       TEXT,
        reason        TEXT,
        pattern       TEXT,
        action_type   TEXT,
        action_data   TEXT,
        approved      INTEGER,
        approved_at   DATETIME,
        executed_at   DATETIME,
        execution_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_findings_session ON agent_findings(session_id);

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

    -- Source groups: named collections of local and/or remote repos
    CREATE TABLE IF NOT EXISTS groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Local repos that belong to a group
    CREATE TABLE IF NOT EXISTS group_local_repos (
        group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        local_repo_id INTEGER NOT NULL REFERENCES local_repos(id) ON DELETE CASCADE,
        added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, local_repo_id)
    );

    -- Remote GitHub repos that belong to a group
    CREATE TABLE IF NOT EXISTS group_github_repos (
        group_id       INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        github_repo_id INTEGER NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, github_repo_id)
    );

    -- OneDrive root folders (one per entity/company)
    CREATE TABLE IF NOT EXISTS onedrive_roots (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        path     TEXT NOT NULL UNIQUE,
        label    TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Customer folder discovery result per (group × root)
    CREATE TABLE IF NOT EXISTS onedrive_customer_folders (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        root_id       INTEGER NOT NULL REFERENCES onedrive_roots(id) ON DELETE CASCADE,
        folder_path   TEXT,
        status        TEXT NOT NULL DEFAULT 'not_found',
        discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        scanned_at    DATETIME,
        UNIQUE(group_id, root_id)
    );
    CREATE INDEX IF NOT EXISTS idx_onedrive_cf_group ON onedrive_customer_folders(group_id);

    -- File metadata only (no content) — linked to a customer folder
    CREATE TABLE IF NOT EXISTS onedrive_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id     INTEGER NOT NULL REFERENCES onedrive_customer_folders(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        extension     TEXT,
        relative_path TEXT NOT NULL,
        last_modified DATETIME,
        size_bytes    INTEGER,
        scanned_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(folder_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_onedrive_files_folder ON onedrive_files(folder_id);

    -- Browser companion: reusable automation skills
    CREATE TABLE IF NOT EXISTS browser_skills (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT NOT NULL UNIQUE,
        description       TEXT,
        start_url         TEXT NOT NULL,
        instructions      TEXT NOT NULL,
        extract_selector  TEXT,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Browser companion: history of skill execution runs
    CREATE TABLE IF NOT EXISTS browser_skill_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id        INTEGER NOT NULL REFERENCES browser_skills(id) ON DELETE CASCADE,
        status          TEXT DEFAULT 'pending',
        started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at    DATETIME,
        extracted_data  TEXT,
        error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_skill_runs_skill ON browser_skill_runs(skill_id);
  `;
}
