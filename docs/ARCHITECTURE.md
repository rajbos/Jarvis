# Jarvis Agent — Architecture Specification

> **Status**: Draft — exploring options before implementation  
> **Goal**: A locally-hosted personal assistant agent that runs on Windows, integrates with a local Ollama instance for natural-language understanding, is easy to extend via MCP (Model Context Protocol), and starts with GitHub repository maintenance capabilities.

---

## Table of Contents

1. [Requirements Summary](#1-requirements-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Runtime & Language Options](#3-runtime--language-options)
4. [Electron GUI Host](#4-electron-gui-host)
5. [First-Run Onboarding Flow](#5-first-run-onboarding-flow)
6. [Ollama Integration](#6-ollama-integration)
7. [MCP Extensibility](#7-mcp-extensibility)
8. [Local Storage](#8-local-storage)
9. [Container Isolation](#9-container-isolation)
10. [Async Actor Pattern](#10-async-actor-pattern)
11. [Activity Tracking & Weekly Summaries](#11-activity-tracking--weekly-summaries)
12. [GitHub Maintenance Module](#12-github-maintenance-module)
13. [Configuration](#13-configuration)
14. [Recommended Approach](#14-recommended-approach)

---

## 1. Requirements Summary

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | Runs locally on Windows | No cloud dependency for core operation |
| R2 | Starts on system startup | Background process with system tray presence |
| R3 | Natural-language prompt interface | User talks to the agent in plain English |
| R4 | Uses local Ollama for LLM inference | No API keys or cloud LLM costs |
| R5 | Easy to extend over time | Adding new capabilities should be simple |
| R6 | MCP support for tool/service integration | Standardized protocol for connecting tools |
| R7 | Local persistent storage | Agent can store state, indexes, preferences |
| R8 | GitHub repo & org maintenance | First concrete use case |
| R9 | Electron GUI with notifications | System tray app, notification-driven onboarding |
| R10 | GitHub OAuth integration | Discover orgs/repos via active OAuth session |
| R11 | Local repo discovery | Scan local directories, correlate with GitHub remotes |
| R12 | Fast/small unit & integration tests | TypeScript/Node.js for easy test workflow |
| R13 | Advanced GitHub queries | Secrets scanning, fork analysis, upstream sync checks |
| R14 | Container isolation | Run tasks in containers to prevent access to local services |
| R15 | Async actor pattern | Background async checks (rate limits, scheduled tasks) |
| R16 | Cross-repo activity summaries | Find latest PRs/issues across orgs, generate weekly summaries |
| R17 | Work journal / thought capture | Track things the user has been thinking about or working on |
| R18 | Full SQLite encryption | Encrypt sensitive data at rest to prevent exfiltration |

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Electron Shell (System Tray)                   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                       Jarvis Agent                           ││
│  │                                                              ││
│  │  ┌────────────┐   ┌────────────┐   ┌──────────────────────┐ ││
│  │  │   Prompt    │   │   Ollama    │   │   Action Executor    │ ││
│  │  │   Input     │──▶│   Router    │──▶│   (MCP Dispatch)     │ ││
│  │  │ (GUI/CLI)   │   │            │   │                      │ ││
│  │  └────────────┘   └────────────┘   └──────────┬───────────┘ ││
│  │                                                │             ││
│  │  ┌──────────────────┐              ┌───────────┴───────────┐ ││
│  │  │  Async Task       │              │     MCP Client Hub    │ ││
│  │  │  Runner (Actor)   │              │                       │ ││
│  │  │                   │              │  ┌─────┐  ┌────────┐ │ ││
│  │  │  ┌─────────────┐ │              │  │GitHub│  │ Future │ │ ││
│  │  │  │ Scheduled    │ │              │  │ MCP  │  │  MCP   │ │ ││
│  │  │  │ Tasks        │ │              │  │Server│  │Servers │ │ ││
│  │  │  ├─────────────┤ │              │  └─────┘  └────────┘ │ ││
│  │  │  │ Rate Limit   │ │              └───────────────────────┘ ││
│  │  │  │ Monitor      │ │                                       ││
│  │  │  ├─────────────┤ │  ┌──────────────────────────────────┐  ││
│  │  │  │ Weekly       │ │  │  Activity Tracker                │  ││
│  │  │  │ Summary Gen  │ │  │  ┌──────┐ ┌──────┐ ┌─────────┐ │  ││
│  │  │  └─────────────┘ │  │  │ PRs  │ │Issues│ │ Work    │ │  ││
│  │  └──────────────────┘  │  │      │ │      │ │ Journal │ │  ││
│  │                         │  └──────┘ └──────┘ └─────────┘ │  ││
│  │                         └──────────────────────────────────┘  ││
│  │                                                              ││
│  │  ┌────────────────────────────────────────────────────────┐  ││
│  │  │       Local Storage (SQLite — encrypted via sqleet)    │  ││
│  │  │  ┌────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐  │  ││
│  │  │  │ Config │ │Indexes │ │ Local    │ │Conversation │  │  ││
│  │  │  │        │ │        │ │ Repos    │ │    Log      │  │  ││
│  │  │  └────────┘ └────────┘ └──────────┘ └─────────────┘  │  ││
│  │  │  ┌────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐  │  ││
│  │  │  │Activity│ │ Async  │ │ Weekly   │ │  Secrets    │  │  ││
│  │  │  │  Log   │ │ Tasks  │ │Summaries │ │Scan Results │  │  ││
│  │  │  └────────┘ └────────┘ └──────────┘ └─────────────┘  │  ││
│  │  └────────────────────────────────────────────────────────┘  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌────────────────────┐  ┌────────────────────────────────────┐  │
│  │  Notification       │  │  Settings / Onboarding UI          │  │
│  │  Manager            │  │  (Renderer Process)                │  │
│  └────────────────────┘  └────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                │
                │ (optional sandboxed execution)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Container Runtime (Docker)                     │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │  Sandboxed MCP    │  │  Sandboxed Task   │                    │
│  │  Server           │  │  Runner           │                    │
│  └──────────────────┘  └──────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

### Core Flow

1. **Startup** — Electron app launches on system startup, sits in the system tray.
2. **Onboarding** — On first run, notifications guide the user through setup (Ollama discovery, local repos, GitHub OAuth).
3. **Prompt Input** — User submits a natural-language request via the GUI window or CLI.
4. **Ollama Router** — The local Ollama model interprets the prompt and determines which action(s) to invoke, including which MCP tools to call and with what parameters.
5. **Action Executor** — Dispatches tool calls to the appropriate MCP server(s) and collects results. Tasks requiring isolation can be routed to containerized runners.
6. **Async Tasks** — Background actor processes run scheduled tasks (rate-limit checks, weekly summaries, periodic indexing) without blocking the main agent.
7. **Response** — Results are optionally summarized by Ollama and returned to the user.

---

## 3. Runtime & Language Options

### Option A: Python

| Aspect | Details |
|--------|---------|
| **Ollama SDK** | [`ollama-python`](https://github.com/ollama/ollama-python) — mature, official |
| **MCP SDK** | [`mcp`](https://pypi.org/project/mcp/) — official Anthropic SDK for both client and server |
| **GitHub SDK** | [`PyGitHub`](https://github.com/PyGithub/PyGithub) or [`githubkit`](https://github.com/yanyongyu/githubkit) |
| **Storage** | `sqlite3` (stdlib), `sqlmodel`, or `peewee` |
| **Windows startup** | Task Scheduler, `pythonw.exe`, or packaged with PyInstaller |
| **Plugin model** | Dynamic module import, entry-points, or MCP servers as subprocesses |
| **Pros** | Richest AI/ML ecosystem; fastest to prototype; MCP SDK is most mature; huge community |
| **Cons** | Requires Python runtime or packaging step; virtualenv management |

### Option B: TypeScript / Node.js

| Aspect | Details |
|--------|---------|
| **Ollama SDK** | [`ollama-js`](https://github.com/ollama/ollama-js) — official |
| **MCP SDK** | [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — official |
| **GitHub SDK** | [`octokit`](https://github.com/octokit/octokit.js) |
| **Storage** | `better-sqlite3`, `sql.js`, or `lowdb` |
| **Windows startup** | `node-windows` service, Task Scheduler, or bundled with `pkg` |
| **Plugin model** | MCP servers as subprocesses; dynamic `import()` |
| **Pros** | Strong MCP SDK support; good async model; easy to bundle |
| **Cons** | Node.js runtime needed; slightly less mature for AI workloads |

### Option C: C# / .NET

| Aspect | Details |
|--------|---------|
| **Ollama SDK** | [`OllamaSharp`](https://github.com/awaescher/OllamaSharp) |
| **MCP SDK** | [`ModelContextProtocol`](https://github.com/modelcontextprotocol/csharp-sdk) — official C# SDK |
| **GitHub SDK** | [`Octokit.net`](https://github.com/octokit/octokit.net) |
| **Storage** | `Microsoft.Data.Sqlite`, Entity Framework Core |
| **Windows startup** | Windows Service (native), system tray app (WinForms/WPF), Task Scheduler |
| **Plugin model** | Assembly loading, MEF/MAF, or MCP servers as subprocesses |
| **Pros** | First-class Windows citizen; easy Windows Service; strong typing; .NET AOT compilation for fast startup |
| **Cons** | Slightly more ceremony for rapid prototyping |

### Comparison Matrix

| Criteria | Python | TypeScript | C# / .NET |
|----------|--------|------------|-----------|
| Ollama integration maturity | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| MCP SDK maturity | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| Windows service support | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Ease of extensibility | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| Packaging / distribution | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| AI ecosystem breadth | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ |
| Rapid prototyping speed | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |

---

## 4. Electron GUI Host

### Why Electron

Electron provides a cross-platform desktop application shell that combines a Node.js backend with a Chromium-based UI. For Jarvis, it gives us:

- **System tray integration** — Runs in the background with a tray icon.
- **Native notifications** — Windows toast notifications for onboarding and alerts.
- **Bundled Node.js runtime** — No separate Node.js install required for end users.
- **Web-based UI** — Build settings and chat UI with standard HTML/CSS/JS.
- **Auto-updater** — Built-in support for silent updates via `electron-updater`.
- **Single executable** — Package everything into one installer.

### Process Model

Electron uses a multi-process architecture that maps well to Jarvis:

| Process | Role |
|---------|------|
| **Main process** | Agent core, MCP client, Ollama integration, SQLite, system tray management |
| **Renderer process** | Settings UI, onboarding wizard, chat/prompt window |
| **MCP server processes** | Spawned as child processes, managed by the main process |

### System Tray Behavior

- On install / first launch, Jarvis starts and places an icon in the Windows system tray.
- **Left-click** the tray icon → opens the chat / prompt window.
- **Right-click** the tray icon → context menu with options:
  - Open Jarvis
  - Settings
  - View indexed repos
  - Check for updates
  - Quit
- The app continues running in the background when the window is closed (minimizes to tray).

### Startup on Boot

Electron provides `app.setLoginItemSettings()` to register the app to start on user login:

```typescript
app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: true, // start minimized to tray
});
```

This writes to the Windows Registry `Run` key automatically — no Task Scheduler or Windows Service needed.

### Notifications

Electron's `Notification` API maps to native Windows toast notifications:

```typescript
new Notification({
  title: 'Jarvis',
  body: 'Found local Ollama installation. Click to configure models.',
  icon: path.join(__dirname, 'assets/icon.png'),
}).show();
```

Notifications are used for:
- Onboarding steps (see [Section 5](#5-first-run-onboarding-flow))
- Background task completion ("Indexing complete — 47 repos found")
- Alerts ("3 repos have critical security alerts")
- Requesting user input ("Click to approve GitHub access")

### Alternative: Tauri

[Tauri](https://tauri.app/) is a lighter-weight alternative to Electron that uses the system webview instead of bundling Chromium. Trade-offs:

| | Electron | Tauri |
|--|----------|-------|
| Bundle size | ~150 MB | ~10 MB |
| Memory usage | Higher | Lower |
| Backend language | Node.js / TypeScript | Rust (with JS/TS frontend) |
| System tray | ✅ | ✅ |
| Notifications | ✅ | ✅ |
| Ecosystem maturity | ⭐⭐⭐ | ⭐⭐ |
| Node.js compatibility | Native | Via sidecar |

**Recommendation**: Start with **Electron** for maximum Node.js compatibility and ecosystem maturity. Consider migrating to Tauri later if bundle size or memory becomes a concern.

---

## 5. First-Run Onboarding Flow

On first launch, the agent runs a guided onboarding sequence using native notifications and a settings UI. Each step is optional and can be completed later.

### Onboarding Sequence

```
┌─────────────────────────────────────────────────────┐
│                 First Launch                         │
│                                                     │
│  Step 1: Ollama Discovery                           │
│  ├── Probe http://localhost:11434/api/tags           │
│  ├── If found → notification: "Ollama detected!     │
│  │   Click to select which models Jarvis can use."  │
│  ├── If not found → notification: "Ollama not       │
│  │   found. Install it to enable AI features."      │
│  └── User selects model(s) → saved to config        │
│                                                     │
│  Step 2: Local Repository Discovery                 │
│  ├── Notification: "Where are your local GitHub     │
│  │   repos stored? Click to select folder."         │
│  ├── User picks folder (e.g. C:\Users\rob\repos)    │
│  ├── Agent scans for .git directories recursively   │
│  ├── Reads git remote URLs to identify GitHub repos  │
│  └── Indexes found repos into SQLite                │
│                                                     │
│  Step 3: GitHub Account Connection                  │
│  ├── Notification: "Connect your GitHub account     │
│  │   to discover orgs and remote repos."            │
│  ├── Opens GitHub OAuth flow (Device Flow)          │
│  │   or GitHub App installation flow                │
│  ├── On success → discover user's orgs & repos      │
│  ├── Correlate remote repos with local clones       │
│  └── Store everything in SQLite                     │
│                                                     │
│  ✅ Onboarding complete                              │
│  Notification: "Jarvis is ready! You have X local   │
│  repos mapped to Y GitHub repos across Z orgs."     │
└─────────────────────────────────────────────────────┘
```

### Step 1: Ollama Discovery

The agent probes the local Ollama HTTP API:

```typescript
// Check if Ollama is running
const response = await fetch('http://localhost:11434/api/tags');
const { models } = await response.json();
// models = [{ name: "llama3.1:latest", size: 4700000000, ... }, ...]
```

The user is presented with the list of installed models and picks one (or more) for Jarvis to use. The selection is saved to the config and can be changed later.

### Step 2: Local Repository Discovery

The agent scans a user-selected directory tree for Git repositories:

1. Recursively find all `.git` directories up to a configurable depth.
2. For each repo, read `.git/config` to extract remote URLs.
3. Parse remote URLs to identify GitHub repos (match `github.com` host).
4. Store each discovered repo in SQLite with its local path and remote URL.

```typescript
// Pseudocode for local repo discovery
const repos = await scanForGitRepos(selectedFolder, { maxDepth: 4 });
for (const repo of repos) {
  const remotes = await getGitRemotes(repo.path);
  const githubRemote = remotes.find(r => r.url.includes('github.com'));
  await db.upsertLocalRepo({
    localPath: repo.path,
    remoteName: githubRemote?.name,
    remoteUrl: githubRemote?.url,
    owner: githubRemote?.owner,
    repoName: githubRemote?.repo,
  });
}
```

### Step 3: GitHub OAuth Connection

Instead of a Personal Access Token, the agent uses **GitHub OAuth Device Flow** for a frictionless login experience:

1. Agent requests a device code from GitHub.
2. Notification shows the user code and a link to `https://github.com/login/device`.
3. User enters the code in their browser and authorizes the app.
4. Agent polls for the access token.
5. On success, agent fetches the user's orgs and repos.
6. Correlates remote repos with locally discovered clones.

```typescript
// GitHub Device Flow (simplified)
const { device_code, user_code, verification_uri } = await requestDeviceCode(clientId);

new Notification({
  title: 'Jarvis — GitHub Login',
  body: `Enter code ${user_code} at ${verification_uri}`,
}).show();

const token = await pollForToken(clientId, device_code);
await db.saveGitHubToken(token); // encrypted with AES-256-GCM before storage

// Now discover orgs and repos
const orgs = await octokit.orgs.listForAuthenticatedUser();
const repos = await octokit.repos.listForAuthenticatedUser({ per_page: 100 });
```

#### GitHub OAuth vs PAT

| | OAuth Device Flow | Personal Access Token |
|--|-------------------|----------------------|
| User experience | Browser-based, guided | Manual token creation |
| Token rotation | Automatic refresh | Manual renewal |
| Scoping | Fine-grained via OAuth app | Fine-grained via PAT settings |
| Security | Token encrypted locally | User responsible for storage |
| Setup friction | Low (click-through) | Medium (navigate to settings) |

### Onboarding State Machine

The onboarding state is tracked in SQLite so it survives restarts:

```sql
CREATE TABLE onboarding (
    step       TEXT PRIMARY KEY,  -- 'ollama', 'local_repos', 'github_oauth'
    status     TEXT DEFAULT 'pending',  -- 'pending', 'completed', 'skipped'
    completed_at DATETIME
);
```

Each step can be re-triggered from the Settings UI at any time.

---

## 6. Ollama Integration

### How Ollama Fits In

Ollama runs as a local HTTP server (default: `http://localhost:11434`) and provides an OpenAI-compatible API. The agent uses it for:

1. **Intent classification** — Understanding what the user wants to do.
2. **Parameter extraction** — Pulling structured data from natural-language input.
3. **Tool calling / function calling** — Mapping prompts to MCP tool invocations.
4. **Response generation** — Summarizing results back to the user.

### Model Selection

| Model | Size | Best For |
|-------|------|----------|
| `llama3.2` (3B) | ~2 GB | Fast responses, simple routing |
| `llama3.1` (8B) | ~4.7 GB | Good balance of speed and capability |
| `mistral` (7B) | ~4.1 GB | Strong tool-calling support |
| `qwen2.5` (7B) | ~4.7 GB | Good instruction following, tool use |
| `llama3.1` (70B) | ~40 GB | Best quality, needs high-end GPU |

### Tool Calling Approach

Modern Ollama models support structured tool/function calling. The agent should:

1. Define available tools (from connected MCP servers) as a tool schema.
2. Send the user prompt along with the tool definitions to Ollama.
3. Parse the model's tool-call response.
4. Execute the requested tool via MCP.
5. Optionally feed the result back to Ollama for summarization.

```
User: "Show me all repos in my org that haven't been updated in 6 months"
  │
  ▼
Ollama (with tool definitions) ──▶ tool_call: github.list_stale_repos(org="myorg", months=6)
  │
  ▼
MCP GitHub Server executes ──▶ returns list of repos
  │
  ▼
Ollama summarizes ──▶ "Found 12 repos in 'myorg' not updated since Sep 2025: ..."
```

---

## 7. MCP Extensibility

### Why MCP

The [Model Context Protocol](https://modelcontextprotocol.io/) provides a standardized way to connect AI models to external tools and data sources. Benefits:

- **Standardized interface** — Any MCP-compatible tool works with the agent.
- **Growing ecosystem** — Many pre-built MCP servers available (GitHub, filesystem, databases, etc.).
- **Language-agnostic** — MCP servers can be written in any language.
- **Process isolation** — Each MCP server runs as a separate process, improving stability.

### Architecture

The agent acts as an **MCP Client** that connects to one or more **MCP Servers**:

```
┌─────────────┐     stdio/SSE     ┌──────────────────┐
│ Jarvis Agent │◄──────────────────▶│ GitHub MCP Server │
│ (MCP Client) │                    └──────────────────┘
│              │     stdio/SSE     ┌──────────────────┐
│              │◄──────────────────▶│ File System MCP  │
│              │                    └──────────────────┘
│              │     stdio/SSE     ┌──────────────────┐
│              │◄──────────────────▶│ Custom MCP Server│
└─────────────┘                    └──────────────────┘
```

### Connecting MCP Servers

MCP servers are configured in a JSON config file (similar to how Claude Desktop does it):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/rob/projects"]
    }
  }
}
```

### Adding New Capabilities

To extend the agent, a user simply:

1. Writes or installs an MCP server.
2. Adds it to the config file.
3. Restarts the agent (or hot-reloads if supported).

The agent automatically discovers the new tools and makes them available for Ollama to call.

### Pre-built MCP Servers to Consider

| Server | Purpose |
|--------|---------|
| `@modelcontextprotocol/server-github` | GitHub API access |
| `@modelcontextprotocol/server-filesystem` | Local file operations |
| `@modelcontextprotocol/server-sqlite` | SQLite database access |
| `@modelcontextprotocol/server-memory` | Knowledge graph memory |
| Custom server | Agent-specific GitHub maintenance tools |

---

## 8. Local Storage

### Requirements

- Store agent configuration and preferences.
- Store indexed data (repos, orgs, maintenance schedules).
- Store conversation history for context.
- Support querying and updating from both the agent and MCP servers.

### Option A: SQLite

| Aspect | Details |
|--------|---------|
| **Format** | Single file database |
| **Location** | `%APPDATA%/jarvis/jarvis.db` |
| **Query support** | Full SQL |
| **Concurrency** | WAL mode supports concurrent reads |
| **Pros** | Battle-tested; zero-config; queryable; single file backup |
| **Cons** | Needs a library (but available in all languages) |

**Suggested schema (initial)**:

```sql
-- Agent configuration
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Onboarding state
CREATE TABLE onboarding (
    step         TEXT PRIMARY KEY,  -- 'ollama', 'local_repos', 'github_oauth'
    status       TEXT DEFAULT 'pending',  -- 'pending', 'completed', 'skipped'
    completed_at DATETIME
);

-- GitHub OAuth session
-- Tokens are encrypted at the application layer using AES-256-GCM
-- with a key derived from JARVIS_ENCRYPTION_KEY (see Configuration section)
CREATE TABLE github_auth (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    login         TEXT NOT NULL UNIQUE,
    access_token  TEXT NOT NULL,  -- AES-256-GCM encrypted
    refresh_token TEXT,           -- AES-256-GCM encrypted
    scopes        TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at    DATETIME
);

-- GitHub organizations being tracked
CREATE TABLE github_orgs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    login      TEXT NOT NULL UNIQUE,
    name       TEXT,
    indexed_at DATETIME,
    metadata   TEXT  -- JSON blob for flexible fields
);

-- GitHub repositories index (remote)
CREATE TABLE github_repos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          INTEGER REFERENCES github_orgs(id),
    full_name       TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    default_branch  TEXT,
    language        TEXT,
    archived        INTEGER DEFAULT 0,
    fork            INTEGER DEFAULT 0,
    parent_full_name TEXT,           -- upstream repo if this is a fork
    private         INTEGER DEFAULT 0,
    last_pushed_at  DATETIME,
    last_updated_at DATETIME,
    indexed_at      DATETIME,
    metadata        TEXT  -- JSON blob for flexible fields
);

-- Local repository clones
CREATE TABLE local_repos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    local_path     TEXT NOT NULL UNIQUE,
    remote_url     TEXT,
    github_repo_id INTEGER REFERENCES github_repos(id),
    discovered_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_scanned   DATETIME
);
CREATE INDEX idx_local_repos_github_repo_id ON local_repos(github_repo_id);

-- Conversation / interaction log
CREATE TABLE conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
    role       TEXT NOT NULL,  -- 'user' or 'assistant'
    content    TEXT NOT NULL,
    tool_calls TEXT  -- JSON blob of any tool calls made
);

-- Task history
CREATE TABLE task_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    task_type   TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'pending',  -- pending, running, completed, failed
    result      TEXT  -- JSON blob
);

-- Activity log (PRs, issues, commits, reviews across all repos)
CREATE TABLE activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    github_user TEXT NOT NULL,
    activity_type TEXT NOT NULL,  -- 'pr_opened', 'pr_merged', 'issue_opened', 'issue_closed', 'review', 'commit'
    repo_full_name TEXT NOT NULL,
    org_login   TEXT,
    title       TEXT,
    url         TEXT NOT NULL,
    state       TEXT,            -- 'open', 'closed', 'merged'
    created_at  DATETIME,
    updated_at  DATETIME,
    fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata    TEXT             -- JSON blob for extra fields
);
CREATE INDEX idx_activity_log_type ON activity_log(activity_type);
CREATE INDEX idx_activity_log_created ON activity_log(created_at);
CREATE INDEX idx_activity_log_repo ON activity_log(repo_full_name);

-- Work journal (manual or captured thoughts, notes, topics)
CREATE TABLE work_journal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    content     TEXT NOT NULL,
    source      TEXT DEFAULT 'manual',  -- 'manual', 'auto_captured', 'pr_context', 'conversation'
    tags        TEXT,                    -- JSON array of tags
    week_number INTEGER,                -- ISO week number for easy weekly grouping
    year        INTEGER
);

-- Weekly summaries (generated)
CREATE TABLE weekly_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    week_number INTEGER NOT NULL,
    year        INTEGER NOT NULL,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    summary     TEXT NOT NULL,         -- Markdown-formatted summary
    pr_count    INTEGER DEFAULT 0,
    issue_count INTEGER DEFAULT 0,
    repos_touched INTEGER DEFAULT 0,
    metadata    TEXT,                   -- JSON blob for detailed stats
    UNIQUE(week_number, year)
);

-- Async task queue
CREATE TABLE async_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type    TEXT NOT NULL,          -- 'rate_limit_check', 'secrets_scan', 'weekly_summary', 'index_repos'
    schedule     TEXT,                   -- cron expression or 'once'
    status       TEXT DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed', 'scheduled'
    priority     INTEGER DEFAULT 0,
    payload      TEXT,                   -- JSON blob with task parameters
    result       TEXT,                   -- JSON blob with task output
    error        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at   DATETIME,
    completed_at DATETIME,
    next_run_at  DATETIME
);
CREATE INDEX idx_async_tasks_status ON async_tasks(status);
CREATE INDEX idx_async_tasks_next_run ON async_tasks(next_run_at);

-- Secrets scan results
CREATE TABLE secrets_scan_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_full_name  TEXT NOT NULL,
    secret_type     TEXT NOT NULL,       -- 'pat', 'api_key', 'password', 'token', etc.
    secret_name     TEXT,
    location        TEXT,               -- file path or secret name
    alert_state     TEXT,               -- 'open', 'resolved', 'dismissed'
    alert_url       TEXT,
    scanned_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata        TEXT                -- JSON blob
);
CREATE INDEX idx_secrets_scan_repo ON secrets_scan_results(repo_full_name);
```

### Option B: JSON File Storage

| Aspect | Details |
|--------|---------|
| **Format** | JSON files in a directory |
| **Location** | `%APPDATA%/jarvis/data/` |
| **Query support** | Manual parsing |
| **Pros** | Human-readable; no dependencies; easy to edit manually |
| **Cons** | No query language; poor performance at scale; no concurrency control |

### Option C: SQLite + MCP Memory Server

Use SQLite for structured data (repos, config) **and** the MCP Memory server for knowledge-graph style memory (learned preferences, entity relationships).

This hybrid approach gives the best of both worlds:
- SQLite for queryable, structured indexes.
- Memory MCP server for flexible, evolving knowledge.

### Recommendation

**Start with SQLite** (Option A) for all storage. It is simple, requires no external services, and supports the query patterns needed for repo indexing. Consider adding the **MCP Memory server** (Option C) later for more advanced knowledge management.

### Full-Database Encryption

To prevent exfiltration or misuse of the SQLite database (which contains OAuth tokens, repo metadata, activity data, and conversation history), the entire database should be encrypted at rest.

#### Option A: sqleet (recommended)

[`sqleet`](https://github.com/nickolasburr/sqleet) is a transparent encryption layer for SQLite using ChaCha20-Poly1305. The `better-sqlite3` package can be compiled against sqleet to enable transparent encryption:

```typescript
import Database from 'better-sqlite3';

// Open encrypted database — all data is encrypted/decrypted transparently
const db = new Database('%APPDATA%/jarvis/jarvis.db', {
  // better-sqlite3 compiled with sqleet support
});
db.pragma(`key='${encryptionKey}'`);
```

#### Option B: SQLCipher

[SQLCipher](https://www.zetetic.net/sqlcipher/) is the most widely-used SQLite encryption extension, using AES-256-CBC. Available via [`better-sqlite3-sqlcipher`](https://www.npmjs.com/package/@journeyapps/sqlcipher) or similar forks.

```typescript
import Database from 'better-sqlite3';

const db = new Database('%APPDATA%/jarvis/jarvis.db');
db.pragma(`key='${encryptionKey}'`);  // AES-256 encryption
```

#### Comparison

| | sqleet | SQLCipher |
|--|--------|-----------|
| Algorithm | ChaCha20-Poly1305 | AES-256-CBC |
| License | Public domain | BSD (community) / Commercial |
| Performance | Faster on systems without AES-NI | Faster with hardware AES |
| npm integration | Requires custom build | `@journeyapps/sqlcipher` available |
| Maturity | ⭐⭐ | ⭐⭐⭐ |

#### Key Management

The database encryption key is derived from the master key stored in **Windows Credential Manager** (same key used for OAuth token encryption — see [Configuration](#13-configuration)). If no key exists on first run, the agent generates a 256-bit random key and stores it in Credential Manager automatically.

### Storage Location

Use the Windows standard application data directory:

```
%APPDATA%/jarvis/
├── jarvis.db          # SQLite database
├── config.json        # MCP server configuration
└── logs/              # Application logs
```

---

## 9. Container Isolation

### Motivation

Some tasks should run in isolation to prevent accidental or malicious access to local services, filesystems, or credentials. Container isolation is especially important for:

- **MCP servers that execute untrusted code** — e.g., running user-provided scripts or plugins.
- **Secrets scanning** — operations that parse repository contents should not leak data.
- **Network-restricted tasks** — tasks that should only access specific APIs (e.g., GitHub) and nothing else.
- **Multi-tenant safety** — if the agent ever runs tasks on behalf of multiple accounts or orgs.

### Architecture

The agent can optionally launch tasks inside Docker containers instead of running them directly:

```
┌─────────────────────┐
│    Jarvis Agent      │
│    (Host Process)    │
│                      │        ┌─────────────────────────┐
│  ┌────────────────┐  │        │  Docker Container        │
│  │ Task Scheduler  │──┼───────▶│                         │
│  │                 │  │  stdio │  ┌───────────────────┐  │
│  │ decides:        │  │◀───────┤  │  Sandboxed MCP    │  │
│  │ local vs        │  │        │  │  Server / Task    │  │
│  │ containerized   │  │        │  └───────────────────┘  │
│  └────────────────┘  │        │                         │
└─────────────────────┘        │  No access to:          │
                                │  - Host filesystem       │
                                │  - Host network services  │
                                │  - Credential Manager     │
                                └─────────────────────────┘
```

### Container Configuration

Tasks can be tagged with an isolation level in the config:

```json
{
  "taskIsolation": {
    "default": "local",
    "overrides": {
      "secrets_scan": "container",
      "untrusted_mcp_server": "container",
      "code_analysis": "container"
    }
  },
  "container": {
    "runtime": "docker",
    "image": "jarvis-sandbox:latest",
    "networkMode": "none",
    "readOnlyRootfs": true,
    "memoryLimit": "512m",
    "cpuLimit": "1.0",
    "volumes": []
  }
}
```

### Docker Image

A minimal container image with only the required tools:

```dockerfile
FROM node:20-slim
WORKDIR /app
# Install only what's needed for sandboxed tasks
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
USER node
ENTRYPOINT ["node", "dist/sandbox-entry.js"]
```

### When to Containerize

| Task | Default | Can Override |
|------|---------|-------------|
| MCP server execution | Local | ✅ Container |
| Secrets scanning | Container | ✅ Local |
| Code analysis | Container | ✅ Local |
| GitHub API calls | Local | ✅ Container |
| Local repo scanning | Local | ❌ Needs host access |
| Ollama inference | Local | ❌ Needs GPU access |

### Recommendation

Start with **all tasks running locally** (Phase 1-8). Add container isolation as **Phase 9** for security-sensitive operations. Users can opt-in to containerized execution per task type.

---

## 10. Async Actor Pattern

### Motivation

Many tasks are long-running, periodic, or should not block the main agent loop:

- **GitHub API rate limit monitoring** — check remaining rate limits and pause/resume operations.
- **Periodic repo re-indexing** — refresh the local index on a schedule.
- **Weekly summary generation** — aggregate activity data and generate summaries.
- **Secrets scanning** — scan repos for leaked credentials in the background.
- **Upstream fork sync checks** — compare forks to upstream for divergence.

### Actor Model

The agent uses a lightweight actor-style task runner where each background task is:

1. **Registered** with a schedule (cron expression) or triggered on-demand.
2. **Queued** in the `async_tasks` table in SQLite.
3. **Executed** by a worker pool (configurable concurrency).
4. **Monitored** — the agent can check task status, cancel running tasks, or retry failed ones.

```
┌───────────────────────────────────────────────┐
│               Async Task Runner                │
│                                                │
│  ┌──────────┐   ┌──────────┐   ┌────────────┐ │
│  │ Scheduler │   │  Queue   │   │  Worker    │ │
│  │ (cron)    │──▶│ (SQLite) │──▶│  Pool      │ │
│  └──────────┘   └──────────┘   └────────────┘ │
│                                      │         │
│                                      ▼         │
│                               ┌────────────┐   │
│                               │  Results   │   │
│                               │  (SQLite)  │   │
│                               └────────────┘   │
│                                      │         │
│                                      ▼         │
│                               ┌────────────┐   │
│                               │Notification│   │
│                               │  Manager   │   │
│                               └────────────┘   │
└───────────────────────────────────────────────┘
```

### Task Types

| Task Type | Schedule | Description |
|-----------|----------|-------------|
| `rate_limit_check` | Every 15 min | Check GitHub API rate limits, pause operations if low |
| `index_repos` | Daily | Re-index repos and orgs from GitHub API |
| `secrets_scan` | Weekly | Scan repos for secrets/PATs via GitHub secret scanning API |
| `weekly_summary` | Monday 9 AM | Generate weekly activity summary |
| `fork_sync_check` | Daily | Check if forks have diverged from upstream |
| `dependency_audit` | Weekly | Check for outdated dependencies and security alerts |
| `branch_cleanup` | Weekly | Identify stale branches across repos |

### Rate Limit Awareness

The agent monitors GitHub API rate limits and automatically throttles:

```typescript
interface RateLimitState {
  remaining: number;
  limit: number;
  resetAt: Date;
  category: 'core' | 'search' | 'graphql';
}

// Before making GitHub API calls
const rateLimits = await checkRateLimits(octokit);
if (rateLimits.core.remaining < 100) {
  await pauseUntil(rateLimits.core.resetAt);
  notify('GitHub API rate limit low — pausing operations until reset.');
}
```

### GitHub App Rate Limits

For users with GitHub App installations (higher rate limits), the agent can use the App's installation token:

```typescript
// GitHub App installation tokens: 5000 req/hr (or 15000 for GitHub Enterprise Cloud)
// OAuth user tokens: 5000 req/hr — but App tokens can access org-level resources
// the user's OAuth token may not have scope for
const appOctokit = new Octokit({ auth: installationToken });
const rateLimit = await appOctokit.rest.rateLimit.get();
```

### Task Lifecycle

```
Created → Scheduled → Running → Completed
                         ↓
                       Failed → Retry (up to 3x) → Permanently Failed
```

Each task execution is logged to `async_tasks` and the result can trigger notifications.

---

## 11. Activity Tracking & Weekly Summaries

### Motivation

The user wants to:
1. See what they've been working on across all repos and orgs.
2. Generate a weekly summary of PRs, issues, reviews, and commits.
3. Capture ad-hoc thoughts and notes that should feed into the summary.
4. Have context about recent work when chatting with the agent.

### Data Sources

| Source | Data Captured |
|--------|--------------|
| **GitHub API** | PRs opened/merged/reviewed, issues opened/closed, commits pushed |
| **Work journal** | Manual notes, thoughts, topics entered via chat or UI |
| **Conversation history** | Things discussed with the agent (auto-captured) |
| **Local git history** | Commits in local repos (from `git log`) |

### Activity Fetching

The agent periodically fetches activity from GitHub using the Events API and Search API:

```typescript
// Fetch recent PRs authored by the user across all repos
const prs = await octokit.search.issuesAndPullRequests({
  q: `author:${username} type:pr created:>=${oneWeekAgo}`,
  sort: 'created',
  order: 'desc',
  per_page: 100,
});

// Fetch recent issues
const issues = await octokit.search.issuesAndPullRequests({
  q: `author:${username} type:issue created:>=${oneWeekAgo}`,
  sort: 'created',
  order: 'desc',
  per_page: 100,
});

// Fetch reviews the user participated in
const reviews = await octokit.search.issuesAndPullRequests({
  q: `reviewed-by:${username} type:pr updated:>=${oneWeekAgo}`,
  sort: 'updated',
  order: 'desc',
  per_page: 100,
});
```

### Work Journal

The user can capture thoughts and notes at any time via the chat interface or a dedicated UI:

```
User: "Note: I've been thinking about migrating the auth service to OAuth2"
Agent: ✅ Added to your work journal. This will be included in your weekly summary.

User: "Journal: Started investigating rate limit issues on the billing API"
Agent: ✅ Noted. Tagged with #billing #rate-limits.
```

Journal entries are stored in the `work_journal` table with:
- Automatic week/year tagging for grouping.
- Auto-extracted tags from content (via Ollama).
- Source tracking (manual, from conversation, from PR context).

### Weekly Summary Generation

A scheduled async task generates a weekly summary every Monday:

```typescript
async function generateWeeklySummary(weekNumber: number, year: number): Promise<string> {
  // 1. Fetch all activity for the week
  const prs = await db.getActivityByWeek(weekNumber, year, 'pr_opened', 'pr_merged');
  const issues = await db.getActivityByWeek(weekNumber, year, 'issue_opened', 'issue_closed');
  const reviews = await db.getActivityByWeek(weekNumber, year, 'review');
  const journalEntries = await db.getJournalByWeek(weekNumber, year);

  // 2. Use Ollama to generate a natural-language summary
  const prompt = buildSummaryPrompt({ prs, issues, reviews, journalEntries });
  const summary = await ollama.generate({ model: config.model, prompt });

  // 3. Store the summary
  await db.insertWeeklySummary({
    weekNumber, year, summary: summary.response,
    prCount: prs.length, issueCount: issues.length,
    reposTouched: countUniqueRepos([...prs, ...issues]),
  });

  return summary.response;
}
```

### Example Summary Output

```markdown
## Weekly Summary — Week 10, 2026

### Pull Requests (7)
- ✅ Merged: `jarvis/agent#42` — Add container isolation support
- ✅ Merged: `billing-api#128` — Fix rate limit handling
- 🔄 Open: `auth-service#55` — OAuth2 migration (draft)
- ...

### Issues (3)
- 🆕 Opened: `infra#201` — Investigate Docker registry performance
- ✅ Closed: `billing-api#130` — Timeout on large invoices
- ...

### Reviews (5)
- Reviewed `team-dashboard#78` — Approved with comments
- ...

### Notes & Thoughts
- Started investigating OAuth2 migration for auth service
- Rate limit issues on billing API seem related to burst traffic
- Considering moving to GitHub App auth for higher rate limits

### Repos Touched: 5 | PRs: 7 | Issues: 3 | Reviews: 5
```

### Query Examples

```
User: "What did I work on last week?"
Agent: Retrieves weekly summary → displays formatted report

User: "Show me all open PRs I have across all orgs"
Agent: Queries activity_log for open PRs → lists them

User: "Which repos did I contribute to in the last month?"
Agent: Aggregates activity_log by repo → returns unique repos

User: "Add to my journal: considering using Redis for caching in the billing service"
Agent: Inserts journal entry → confirms
```

---

## 12. GitHub Maintenance Module

### Initial Capabilities

The first concrete use case is GitHub repository maintenance. The agent should support:

#### 12.1 Repository & Organization Indexing

- **Index organizations** — Discover and store all orgs the user belongs to via GitHub OAuth.
- **Index repositories** — For each org, list and store all repositories with metadata.
- **Discover local clones** — Scan a user-specified directory for `.git` repos and read remote URLs.
- **Correlate local ↔ remote** — Match local clones to GitHub repos by remote URL.
- **Incremental updates** — Only fetch changes since last index.
- **Search** — Query the local index by name, language, last activity, etc.

#### 12.2 Secrets Scanning

Scan repos for exposed secrets, tokens, and credentials:

- **GitHub Secret Scanning API** — Query the secret scanning alerts endpoint for repos with Advanced Security enabled.
- **Custom pattern matching** — For repos without Advanced Security, scan for common patterns (PATs, API keys, connection strings) in repo content via the GitHub Search API or local clone analysis.
- **Filter by type** — "Find all secrets that have PAT in the name" → queries `secrets_scan_results` filtered by `secret_type` or `secret_name` matching.

```
User: "Check my personal repos for all secrets that have PAT in the name"
Agent: 1. Queries GitHub secret scanning API for each personal repo
       2. Filters alerts where secret_type or name contains 'PAT'
       3. Stores results in secrets_scan_results table
       4. Returns: "Found 3 exposed PATs across 2 repos: ..."
```

#### 12.3 Fork Analysis & Upstream Sync

Analyze forked repos for staleness and upstream divergence:

- **Identify forks** — Filter indexed repos where `fork = true`.
- **Check upstream freshness** — Compare the fork's default branch to the upstream's default branch.
- **Detect unmerged upstream changes** — Use GitHub's compare API to find commits in upstream that haven't been merged into the fork.
- **Staleness detection** — Find forks with no activity since a configurable date.
- **Recommend action** — Suggest syncing, archiving, or deleting stale forks.

```
User: "Check all personal repos that are forks, have not been updated in forever,
       and check if they still have updates not merged upstream"
Agent: 1. Queries local index for repos where fork=true AND last_pushed_at < threshold
       2. For each stale fork, calls GitHub compare API: upstream...fork
       3. Reports: "Found 8 stale forks. 3 have unmerged upstream changes:
          - repo-a: 47 commits behind upstream
          - repo-b: 12 commits behind upstream
          - repo-c: 3 commits behind upstream
          5 forks are up-to-date but inactive — consider archiving."
```

```typescript
// Fork analysis pseudocode
async function analyzeStaleForksWithUpstream(username: string, staleDays: number) {
  const forks = await db.getForkedRepos(username, { staleDays });

  for (const fork of forks) {
    const parent = await octokit.repos.get({ owner: fork.owner, repo: fork.name });
    if (!parent.data.parent) continue;

    const upstream = parent.data.parent;
    const comparison = await octokit.repos.compareCommits({
      owner: upstream.owner.login,
      repo: upstream.name,
      base: `${fork.owner}:${fork.default_branch}`,
      head: `${upstream.owner.login}:${upstream.default_branch}`,
    });

    await db.updateForkAnalysis(fork.id, {
      upstreamFullName: upstream.full_name,
      behindBy: comparison.data.ahead_by,  // commits in upstream not in fork
      aheadBy: comparison.data.behind_by,  // commits in fork not in upstream
      lastUpstreamCommit: comparison.data.commits?.[0]?.commit?.committer?.date,
    });
  }
}
```

#### 12.4 Maintenance Tasks

Once indexing is in place, these maintenance tasks can be added incrementally:

| Task | Description |
|------|-------------|
| Stale repo detection | Find repos with no activity in N months |
| Secrets scanning | Find exposed PATs, API keys, tokens in repos |
| Fork upstream sync | Check if forks have unmerged upstream changes |
| Dependency audit | Check for outdated dependencies or security alerts |
| Branch cleanup | Identify stale branches across repos |
| Action workflow status | Monitor GitHub Actions health across repos |
| License compliance | Verify all repos have appropriate licenses |
| README health | Check for missing or incomplete READMEs |
| Archive suggestions | Suggest repos that could be archived |
| Topic/description gaps | Find repos missing topics or descriptions |

#### 12.5 Implementation Approach

**Option A: Use the pre-built GitHub MCP Server**

The `@modelcontextprotocol/server-github` provides broad GitHub API access. The agent can use it directly for all GitHub operations.

- **Pros**: No custom code needed; maintained by the community; broad API coverage.
- **Cons**: May not have optimized bulk operations; may need API call management.

**Option B: Custom GitHub MCP Server**

Build a custom MCP server tailored to maintenance tasks with bulk operations and local caching.

- **Pros**: Optimized for the specific use case; can batch API calls; can implement caching.
- **Cons**: More code to maintain.

**Option C: Hybrid**

Use the pre-built GitHub MCP server for ad-hoc queries and build a small custom MCP server for bulk indexing and maintenance-specific operations.

- **Pros**: Best of both worlds; minimal custom code; optimized where it matters.
- **Cons**: Two servers to manage.

### Recommendation

Start with **Option A** (pre-built GitHub MCP Server) to get running quickly. Move to **Option C** (hybrid) when bulk operations become a bottleneck.

### Example Interactions

```
User: "Index all my GitHub organizations"
Agent: Calls github.list_user_orgs() → stores results in SQLite

User: "How many repos do I have in the 'myorg' organization?"
Agent: Queries local index → "You have 47 repos in 'myorg'"

User: "Which repos haven't been updated in the last 6 months?"
Agent: Queries local index with date filter → returns list

User: "Check my personal repos for all secrets that have PAT in the name"
Agent: Scans repos via secret scanning API → filters by PAT → returns results

User: "Find all my forks that are behind upstream"
Agent: Identifies forks → compares with upstream → reports divergence

User: "What are my open PRs across all orgs?"
Agent: Queries activity_log → returns list of open PRs with links

User: "Generate my weekly summary"
Agent: Aggregates PRs, issues, reviews, journal entries → generates markdown report

User: "Run a full maintenance check on my repos"
Agent: Executes multiple checks → generates a report
```

---

## 13. Configuration

### Agent Configuration File

A single `config.json` in the app data directory:

```json
{
  "ollama": {
    "host": "http://localhost:11434",
    "model": "llama3.1",
    "timeout": 120
  },
  "storage": {
    "database": "%APPDATA%/jarvis/jarvis.db",
    "encrypted": true
  },
  "localRepos": {
    "scanPaths": ["%USERPROFILE%/repos", "%USERPROFILE%/projects"],
    "maxScanDepth": 4,
    "excludePatterns": ["node_modules", ".git"]
  },
  "github": {
    "oauthClientId": "Iv1.xxxxxxxxxxxxxxxx",
    "scopes": ["repo", "read:org", "read:user"]
  },
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  },
  "agent": {
    "logLevel": "info",
    "conversationHistoryLimit": 50,
    "systemPrompt": "You are Jarvis, a personal assistant for managing GitHub repositories and development tasks."
  },
  "electron": {
    "startMinimized": true,
    "openAtLogin": true
  },
  "asyncTasks": {
    "workerConcurrency": 2,
    "schedules": {
      "rate_limit_check": "*/15 * * * *",
      "index_repos": "0 2 * * *",
      "secrets_scan": "0 3 * * 0",
      "weekly_summary": "0 9 * * 1",
      "fork_sync_check": "0 4 * * *",
      "dependency_audit": "0 5 * * 0",
      "branch_cleanup": "0 6 * * 0"
    }
  },
  "taskIsolation": {
    "default": "local",
    "overrides": {
      "secrets_scan": "container",
      "code_analysis": "container"
    }
  },
  "container": {
    "runtime": "docker",
    "image": "jarvis-sandbox:latest",
    "networkMode": "none",
    "memoryLimit": "512m"
  }
}
```

### Environment Variables

Sensitive values (tokens, keys) should come from environment variables, never stored in plain-text config files:

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | GitHub access token (fallback if OAuth not used) |
| `JARVIS_CONFIG_DIR` | Override default config directory |
| `OLLAMA_HOST` | Override Ollama URL |
| `JARVIS_ENCRYPTION_KEY` | Master key for encrypting the SQLite database and OAuth tokens at rest |

#### Encryption Key Management

`JARVIS_ENCRYPTION_KEY` is used as the master key for full SQLite database encryption (via sqleet/SQLCipher — see [Section 8](#8-local-storage)) and for application-layer encryption of especially sensitive fields. On first run, if no key is set, the agent generates a 256-bit (32-byte) random key and stores it in **Windows Credential Manager** (via `keytar` or `node-keychain`) so the user never has to manage it manually. This keeps the key out of environment variables and config files for most users while allowing advanced users to override via the environment variable.

---

## 14. Recommended Approach

Based on the requirements analysis and feedback, here is the chosen approach:

### Language: TypeScript / Node.js

**Rationale**: TypeScript gives us easy, fast unit and integration testing with established tools (Vitest/Jest). The MCP and Ollama SDKs are both mature for Node.js. Electron provides the GUI shell, system tray, and notifications out of the box.

### Initial Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Node.js 20 LTS (bundled with Electron) | Stable, long-term support |
| **Language** | TypeScript 5.x | Type safety, better DX, refactoring support |
| **GUI shell** | Electron | System tray, notifications, startup on boot, web UI |
| **LLM** | Ollama (local) via `ollama` package | Official SDK, tool calling support |
| **MCP** | `@modelcontextprotocol/sdk` | Official SDK, act as MCP client |
| **Storage** | SQLite via `better-sqlite3` | Synchronous API, fast, reliable |
| **GitHub API** | `octokit` + GitHub OAuth Device Flow | Official SDK, frictionless auth |
| **Testing** | Vitest | Fast, TypeScript-native, good DX |
| **Packaging** | `electron-builder` | Installers, auto-update, code signing |
| **Config** | JSON files | Human-readable, easy to edit |

### Suggested Project Structure

```
jarvis/
├── src/
│   ├── main/                        # Electron main process
│   │   ├── index.ts                 # Electron app entry point
│   │   ├── tray.ts                  # System tray management
│   │   ├── notifications.ts         # Notification helpers
│   │   └── windows.ts               # Window management
│   ├── renderer/                    # Electron renderer (UI)
│   │   ├── index.html
│   │   ├── onboarding/              # Onboarding wizard UI
│   │   ├── settings/                # Settings UI
│   │   ├── chat/                    # Chat / prompt UI
│   │   └── summary/                 # Weekly summary display
│   ├── agent/                       # Core agent logic
│   │   ├── agent.ts                 # Agent loop & orchestration
│   │   ├── config.ts                # Configuration loading
│   │   └── onboarding.ts            # Onboarding state machine
│   ├── llm/
│   │   └── ollama-client.ts         # Ollama integration
│   ├── mcp/
│   │   └── client.ts                # MCP client hub
│   ├── storage/
│   │   ├── database.ts              # SQLite operations (encrypted)
│   │   ├── schema.ts                # Table definitions & migrations
│   │   └── encryption.ts            # Key management (Credential Manager)
│   ├── tasks/                       # Async actor task runner
│   │   ├── runner.ts                # Task queue & worker pool
│   │   ├── scheduler.ts             # Cron-based scheduling
│   │   ├── rate-limit-monitor.ts    # GitHub API rate limit tracking
│   │   └── weekly-summary.ts        # Weekly summary generation
│   ├── services/
│   │   ├── github-oauth.ts          # GitHub Device Flow
│   │   ├── github-indexer.ts        # Org & repo indexing
│   │   ├── local-repo-scanner.ts    # Local .git discovery
│   │   ├── secrets-scanner.ts       # Secrets/PAT scanning
│   │   ├── fork-analyzer.ts         # Fork analysis & upstream sync
│   │   └── activity-tracker.ts      # PR/issue/review tracking
│   └── container/                   # Container isolation
│       ├── docker-manager.ts        # Docker container lifecycle
│       └── sandbox-entry.ts         # Entry point for sandboxed tasks
├── tests/
│   ├── unit/
│   │   ├── agent.test.ts
│   │   ├── ollama-client.test.ts
│   │   ├── database.test.ts
│   │   ├── local-repo-scanner.test.ts
│   │   ├── github-indexer.test.ts
│   │   ├── secrets-scanner.test.ts
│   │   ├── fork-analyzer.test.ts
│   │   ├── activity-tracker.test.ts
│   │   ├── task-runner.test.ts
│   │   └── weekly-summary.test.ts
│   └── integration/
│       ├── onboarding.test.ts
│       ├── mcp-client.test.ts
│       └── container-isolation.test.ts
├── assets/
│   ├── icon.png                     # App icon
│   └── icon.ico                     # Windows icon
├── config/
│   └── default.json                 # Default configuration
├── docs/
│   └── ARCHITECTURE.md              # This document
├── Dockerfile                       # Sandbox container image
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── electron-builder.yml
├── README.md
└── .gitignore
```

### Implementation Phases

| Phase | Scope | Outcome |
|-------|-------|---------|
| **Phase 1** | Electron shell + system tray + startup on boot | App launches silently on login with tray icon |
| **Phase 2** | SQLite storage (encrypted) + config loading | Persistent encrypted state, onboarding tracking |
| **Phase 3** | Ollama discovery + model selection | Detects Ollama, user selects model, notification-driven |
| **Phase 4** | Local repo scanning | Scans directories for `.git` repos, indexes into SQLite |
| **Phase 5** | GitHub OAuth + org/repo indexing | Device Flow login, discover orgs/repos, correlate with local |
| **Phase 6** | MCP client integration | Can connect to MCP servers, expose tools to Ollama |
| **Phase 7** | Chat / prompt UI + Ollama routing | Natural-language prompts dispatched to MCP tools |
| **Phase 8** | Async task runner + scheduling | Background task queue with cron scheduling |
| **Phase 9** | Activity tracking + weekly summaries | Cross-repo PR/issue tracking, work journal, generated summaries |
| **Phase 10** | Secrets scanning + fork analysis | Scan for exposed secrets, analyze fork upstream divergence |
| **Phase 11** | Container isolation | Optional sandboxed execution for security-sensitive tasks |
| **Phase 12** | Advanced maintenance tasks | Stale repo detection, dependency audits, branch cleanup |

---

## Decision Log

| Decision | Status | Notes |
|----------|--------|-------|
| Language/runtime | **TypeScript / Node.js** | Easy unit/integration tests, mature SDKs |
| GUI host | **Electron** | System tray, notifications, startup on boot, web UI |
| Windows startup method | **Electron `openAtLogin`** | Registry-based, no Task Scheduler needed |
| Storage engine | **SQLite** (`better-sqlite3`) | Battle-tested, zero config, queryable |
| Database encryption | **sqleet or SQLCipher** | Full-database encryption to prevent exfiltration |
| GitHub authentication | **OAuth Device Flow** | Frictionless browser-based login |
| MCP server approach | **Pre-built server first** | Quick start, move to hybrid later |
| Ollama model | **User selects at onboarding** | Detected from local Ollama installation |
| Testing framework | **Vitest** | Fast, TypeScript-native |
| Async task execution | **Actor-style task runner** | Background queue with cron scheduling, rate-limit aware |
| Container isolation | **Docker (opt-in)** | Sandboxed execution for security-sensitive tasks |
| Activity summaries | **Weekly generated summaries** | Cross-repo PR/issue/review aggregation + work journal |
