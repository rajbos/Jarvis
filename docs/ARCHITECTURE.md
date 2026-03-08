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
9. [GitHub Maintenance Module](#9-github-maintenance-module)
10. [Configuration](#10-configuration)
11. [Recommended Approach](#11-recommended-approach)

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
│  │                                    ┌───────────┴───────────┐ ││
│  │                                    │     MCP Client Hub    │ ││
│  │                                    │                       │ ││
│  │                                    │  ┌─────┐  ┌────────┐ │ ││
│  │                                    │  │GitHub│  │ Future │ │ ││
│  │                                    │  │ MCP  │  │  MCP   │ │ ││
│  │                                    │  │Server│  │Servers │ │ ││
│  │                                    │  └─────┘  └────────┘ │ ││
│  │                                    └───────────────────────┘ ││
│  │                                                              ││
│  │  ┌────────────────────────────────────────────────────────┐  ││
│  │  │              Local Storage (SQLite)                    │  ││
│  │  │  ┌────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐  │  ││
│  │  │  │ Config │ │Indexes │ │ Local    │ │Conversation │  │  ││
│  │  │  │        │ │        │ │ Repos    │ │    Log      │  │  ││
│  │  │  └────────┘ └────────┘ └──────────┘ └─────────────┘  │  ││
│  │  └────────────────────────────────────────────────────────┘  ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌────────────────────┐  ┌────────────────────────────────────┐  │
│  │  Notification       │  │  Settings / Onboarding UI          │  │
│  │  Manager            │  │  (Renderer Process)                │  │
│  └────────────────────┘  └────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Core Flow

1. **Startup** — Electron app launches on system startup, sits in the system tray.
2. **Onboarding** — On first run, notifications guide the user through setup (Ollama discovery, local repos, GitHub OAuth).
3. **Prompt Input** — User submits a natural-language request via the GUI window or CLI.
4. **Ollama Router** — The local Ollama model interprets the prompt and determines which action(s) to invoke, including which MCP tools to call and with what parameters.
5. **Action Executor** — Dispatches tool calls to the appropriate MCP server(s) and collects results.
6. **Response** — Results are optionally summarized by Ollama and returned to the user.

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

### Storage Location

Use the Windows standard application data directory:

```
%APPDATA%/jarvis/
├── jarvis.db          # SQLite database
├── config.json        # MCP server configuration
└── logs/              # Application logs
```

---

## 9. GitHub Maintenance Module

### Initial Capabilities

The first concrete use case is GitHub repository maintenance. The agent should support:

#### 9.1 Repository & Organization Indexing

- **Index organizations** — Discover and store all orgs the user belongs to via GitHub OAuth.
- **Index repositories** — For each org, list and store all repositories with metadata.
- **Discover local clones** — Scan a user-specified directory for `.git` repos and read remote URLs.
- **Correlate local ↔ remote** — Match local clones to GitHub repos by remote URL.
- **Incremental updates** — Only fetch changes since last index.
- **Search** — Query the local index by name, language, last activity, etc.

#### 9.2 Maintenance Tasks (Future)

Once indexing is in place, these maintenance tasks can be added incrementally:

| Task | Description |
|------|-------------|
| Stale repo detection | Find repos with no activity in N months |
| Dependency audit | Check for outdated dependencies or security alerts |
| Branch cleanup | Identify stale branches across repos |
| Action workflow status | Monitor GitHub Actions health across repos |
| License compliance | Verify all repos have appropriate licenses |
| README health | Check for missing or incomplete READMEs |
| Archive suggestions | Suggest repos that could be archived |
| Topic/description gaps | Find repos missing topics or descriptions |

#### 9.3 Implementation Approach

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

User: "Run a full maintenance check on my repos"
Agent: Executes multiple checks → generates a report
```

---

## 10. Configuration

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
    "database": "%APPDATA%/jarvis/jarvis.db"
  },
  "localRepos": {
    "scanPaths": ["%USERPROFILE%/repos", "%USERPROFILE%/projects"],
    "maxScanDepth": 4,
    "excludePatterns": ["node_modules", ".git"]
  },
  "github": {
    "oauthClientId": "Iv1.xxxxxxxxxxxxxxxx",  // GitHub OAuth App client ID — see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
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
| `JARVIS_ENCRYPTION_KEY` | AES-256 key for encrypting OAuth tokens at rest |

#### Encryption Key Management

`JARVIS_ENCRYPTION_KEY` should be a 256-bit (32-byte) random key, base64-encoded. On first run, if no key is set, the agent can generate one and store it in **Windows Credential Manager** (via `keytar` or `node-keychain`) so the user never has to manage it manually. This keeps the key out of environment variables and config files for most users while allowing advanced users to override via the environment variable.

---

## 11. Recommended Approach

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
│   │   └── chat/                    # Chat / prompt UI
│   ├── agent/                       # Core agent logic
│   │   ├── agent.ts                 # Agent loop & orchestration
│   │   ├── config.ts                # Configuration loading
│   │   └── onboarding.ts            # Onboarding state machine
│   ├── llm/
│   │   └── ollama-client.ts         # Ollama integration
│   ├── mcp/
│   │   └── client.ts                # MCP client hub
│   ├── storage/
│   │   ├── database.ts              # SQLite operations
│   │   └── schema.ts                # Table definitions & migrations
│   └── services/
│       ├── github-oauth.ts          # GitHub Device Flow
│       ├── github-indexer.ts        # Org & repo indexing
│       └── local-repo-scanner.ts    # Local .git discovery
├── tests/
│   ├── unit/
│   │   ├── agent.test.ts
│   │   ├── ollama-client.test.ts
│   │   ├── database.test.ts
│   │   ├── local-repo-scanner.test.ts
│   │   └── github-indexer.test.ts
│   └── integration/
│       ├── onboarding.test.ts
│       └── mcp-client.test.ts
├── assets/
│   ├── icon.png                     # App icon
│   └── icon.ico                     # Windows icon
├── config/
│   └── default.json                 # Default configuration
├── docs/
│   └── ARCHITECTURE.md              # This document
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
| **Phase 2** | SQLite storage + config loading | Persistent state, onboarding tracking |
| **Phase 3** | Ollama discovery + model selection | Detects Ollama, user selects model, notification-driven |
| **Phase 4** | Local repo scanning | Scans directories for `.git` repos, indexes into SQLite |
| **Phase 5** | GitHub OAuth + org/repo indexing | Device Flow login, discover orgs/repos, correlate with local |
| **Phase 6** | MCP client integration | Can connect to MCP servers, expose tools to Ollama |
| **Phase 7** | Chat / prompt UI + Ollama routing | Natural-language prompts dispatched to MCP tools |
| **Phase 8** | Maintenance tasks | Stale repo detection, health checks, notifications |

---

## Decision Log

| Decision | Status | Notes |
|----------|--------|-------|
| Language/runtime | **TypeScript / Node.js** | Easy unit/integration tests, mature SDKs |
| GUI host | **Electron** | System tray, notifications, startup on boot, web UI |
| Windows startup method | **Electron `openAtLogin`** | Registry-based, no Task Scheduler needed |
| Storage engine | **SQLite** (`better-sqlite3`) | Battle-tested, zero config, queryable |
| GitHub authentication | **OAuth Device Flow** | Frictionless browser-based login |
| MCP server approach | **Pre-built server first** | Quick start, move to hybrid later |
| Ollama model | **User selects at onboarding** | Detected from local Ollama installation |
| Testing framework | **Vitest** | Fast, TypeScript-native |
