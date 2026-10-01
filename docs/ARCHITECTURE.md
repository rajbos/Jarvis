# Jarvis Agent — Architecture Specification

> **Status**: Living document — describes the shipped architecture. Sections marked **Not implemented** (§9, §10) are deferred ideas, not current behaviour. Where this document and the source disagree, the source wins.  
> **Last verified against source**: 2026-10-01 (storage, encryption, GitHub client, container isolation and task-queue claims; `LATEST_SCHEMA_VERSION = 31`)  
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
15. [Claude Rate Limit Awareness](#15-claude-rate-limit-awareness)
16. [Copilot AI Credit Budget Tracking](#16-copilot-ai-credit-budget-tracking)
17. [Active Agent Sessions & PR Review Readiness](#17-active-agent-sessions--pr-review-readiness)

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
| R14 | Container isolation | **Not implemented** (deferred, see §9) |
| R15 | Async actor pattern | **Not implemented** (deferred, see §10) |
| R16 | Cross-repo activity summaries | Find latest PRs/issues across orgs, generate weekly summaries |
| R17 | Work journal / thought capture | Track things the user has been thinking about or working on |
| R18 | Encrypt sensitive data at rest | Field-level AES-256-GCM for tokens/credentials; the database file itself is not encrypted (see §8) |
| R19 | Claude rate limit awareness | Reuse local Claude Code OAuth credentials to track Pro/Max subscription usage limits, with a status-bar countdown when limited |
| R20 | Copilot AI credit budget tracking | Show this month's GitHub Copilot AI credit usage against a user-set monthly budget |
| R21 | Active agent sessions & PR review readiness | List running Copilot / Claude sessions (local + cloud), link them to their PRs and signal when a PR is ready for human review |

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
│  │  │       Local Storage (sql.js, AES-256-GCM fields)      │  ││
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

> **Not implemented:** the `Async Tasks` box and the Container Runtime (Docker) block in this diagram are deferred designs (§9, §10). Neither exists in `src/`.

---

## 3. Runtime & Language implementation in TypeScript / Node.js

| Aspect | Details |
|--------|---------|
| **Ollama SDK** | [`ollama-js`](https://github.com/ollama/ollama-js) — official |
| **MCP SDK** | [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — official |
| **GitHub client** | Native `fetch` against the GitHub REST API plus a hand-written OAuth Device Flow (`src/services/github-oauth.ts`, `src/services/github-discovery.ts`); no `octokit` dependency |
| **Storage** | [`sql.js`](https://github.com/sql-js/sql.js) (SQLite compiled to WASM, persisted to `jarvis.db`) |
| **Windows startup** | `node-windows` service, Task Scheduler, or bundled with `pkg` |
| **Plugin model** | MCP servers as subprocesses; dynamic `import()` |
| **Pros** | Strong MCP SDK support; good async model; easy to bundle |
| **Cons** | Node.js runtime needed; slightly less mature for AI workloads |


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

### IPC Handler Error Contract

All new `ipcMain.handle` registrations should use `safeHandle` from `src/plugins/ipc-utils.ts`. It preserves successful return values and converts synchronous exceptions or rejected promises into a resolved `{ error: string }` payload, giving renderer callers one predictable failure shape. Handlers may still perform input validation and return domain-specific error objects when appropriate.

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

---

## 5. First-Run Onboarding Flow

On first launch, the agent runs a guided onboarding sequence using native notifications and a settings UI. Each step is optional and can be completed later.

### Onboarding Sequence

```
┌─────────────────────────────────────────────────────┐
│                 First Launch                        │
│                                                     │
│  Step 3: Ollama Discovery                           │
│  ├── Probe http://localhost:11434/api/tags          │
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
│  ├── Reads git remote URLs to identify GitHub repos │
│  └── Indexes found repos into SQLite                │
│                                                     │
│  Step 1: GitHub Account Connection                  │
│  ├── Notification: "Connect your GitHub account     │
│  │   to discover orgs and remote repos."            │
│  ├── Opens GitHub OAuth flow (Device Flow)          │
│  ├── On success → discover user's orgs & repos      │
│  ├── Correlate remote repos with local clones       │
│  └── Store everything in SQLite                     │
│                                                     │
│  ✅ Onboarding complete                             │
│  Notification: "Jarvis is ready! You have X local   │
│  repos mapped to Y GitHub repos across Z orgs."     │
└─────────────────────────────────────────────────────┘
```

### Step 3: Ollama Discovery

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

### Step 1: GitHub OAuth Connection

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

// Now discover orgs and repos with plain fetch calls (see src/services/github-discovery.ts)
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
const orgs = await (await fetch('https://api.github.com/user/orgs', { headers })).json();
const repos = await (await fetch('https://api.github.com/user/repos?per_page=100', { headers })).json();
```

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
- Store indexed data (repos, orgs, notifications, workflow runs, agent sessions, and so on).
- Store conversation history for context.
- Protect secrets (OAuth tokens, PATs, Claude credentials) at rest.

### Implementation: sql.js

Jarvis uses [`sql.js`](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly), not `better-sqlite3`. This avoids native module rebuilds for Electron. The whole database is held in memory and written back to disk as a single file by `saveDatabase()` (`src/storage/database.ts`).

| Aspect | Details |
|--------|---------|
| **Engine** | `sql.js` (in-memory SQLite, serialized to a file) |
| **Location** | `%APPDATA%\Jarvis\jarvis.db` (config directory overridable with `JARVIS_CONFIG_DIR`) |
| **Schema** | Base schema in `src/storage/schema.ts` (`getSchema()`); forward-only migrations in `initializeSchema()` in `src/storage/database.ts`, tracked with `PRAGMA user_version` |
| **Current version** | `LATEST_SCHEMA_VERSION = 31` |
| **Tests** | `createMemoryDatabase()` provides an in-memory database |

The database is **not** encrypted as a whole: there is no sqleet or SQLCipher. Anyone with read access to `jarvis.db` can read non-secret data such as repo metadata and conversation history.

### Schema

The schema in `src/storage/schema.ts` is the source of truth; do not copy table definitions into this document. The main table groups are:

| Area | Tables |
|------|--------|
| Core | `config`, `onboarding`, `conversations`, `task_history` |
| GitHub | `github_auth`, `github_orgs`, `github_repos`, `github_notifications`, `github_workflow_runs`, `github_workflow_jobs` |
| Local repos | `local_scan_folders`, `local_repos`, `local_repo_remotes` |
| Agents and sessions | `agent_definitions`, `agent_sessions`, `agent_findings`, `pr_readiness` |
| Secrets | `repo_secrets`, `secret_scan_favorites` |
| Groups | `groups`, `group_local_repos`, `group_github_repos` |
| OneDrive / OneNote | `onedrive_roots`, `onedrive_customer_folders`, `onedrive_files`, `onedrive_onenote_cache` |
| Other | `ruddr_projects`, `ruddr_budgets`, `browser_skills`, `browser_skill_runs`, `auto_dismiss_log` |

There is no `async_tasks`, `activity_log` or weekly-summary table; those designs (§10, §11) were not built.

### Field-Level Encryption (AES-256-GCM)

Sensitive values are encrypted by the application before they are written to a column or to `config` (`src/storage/encryption.ts`):

- `encrypt(plaintext, key)` uses AES-256-GCM with a random 16-byte IV and returns base64 of `IV + ciphertext + auth tag`; `decrypt()` reverses it.
- Encrypted values today: GitHub OAuth access token (`github_auth.access_token`), GitHub PAT (`github_auth.pat`), and Claude OAuth credentials (stored in `config`; `src/plugins/claude/handler.ts`).
- If decryption fails (for example the key changed), the loaders return `null` and the user is asked to re-authenticate.
- The key comes from `getEncryptionKey()`; see [Encryption Key Management](#encryption-key-management) in §13.

### Storage Location

```
%APPDATA%\Jarvis\
├── jarvis.db               # sql.js database file
├── keystore.bin            # Encryption key, protected by Electron safeStorage
└── keystore.fallback.bin   # CSPRNG key used when safeStorage is unavailable
```

---

## 9. Container Isolation

> **Not implemented — deferred.** There is no Dockerfile, container manager or sandbox code in this repository. Everything below is a design idea, kept for reference only. Do not plan work as if any of it exists.

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

> **Not implemented — deferred.** There is no task queue, scheduler, worker pool or `async_tasks` table. Periodic work today is done by individual plugins using their own timers (for example the rate-limit, Copilot usage and PR readiness checks). Everything below is a design idea, kept for reference only.

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
const rateLimits = await checkRateLimits(token); // wraps GET /rate_limit via fetch
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
const res = await fetch('https://api.github.com/rate_limit', {
  headers: { Authorization: `Bearer ${installationToken}` },
});
const rateLimit = await res.json();
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
// Illustrative helper: GET https://api.github.com/search/issues?... via fetch
// (there is no octokit dependency)
const search = (q: string, sort: string) =>
  githubGet(`/search/issues?${new URLSearchParams({ q, sort, order: 'desc', per_page: '100' })}`);

// Fetch recent PRs authored by the user across all repos
const prs = await search(`author:${username} type:pr created:>=${oneWeekAgo}`, 'created');

// Fetch recent issues
const issues = await search(`author:${username} type:issue created:>=${oneWeekAgo}`, 'created');

// Fetch reviews the user participated in
const reviews = await search(`reviewed-by:${username} type:pr updated:>=${oneWeekAgo}`, 'updated');
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
    const parent = await githubGet(`/repos/${fork.owner}/${fork.name}`); // illustrative fetch wrapper
    if (!parent.data.parent) continue;

    const upstream = parent.data.parent;
    const comparison = await githubGet(
      `/repos/${upstream.owner.login}/${upstream.name}/compare/` +
      `${fork.owner}:${fork.default_branch}...${upstream.owner.login}:${upstream.default_branch}`,
    );

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
| `JARVIS_ENCRYPTION_KEY` | Optional override for the field-encryption key (used by tests and CI); a scrypt-derived 256-bit key |

#### Encryption Key Management

Sensitive fields (OAuth tokens, PAT, Claude credentials) are encrypted with AES-256-GCM at the application layer; the database file itself is not encrypted (see [Section 8](#8-local-storage)). `getEncryptionKey()` in `src/storage/encryption.ts` resolves the 32-byte key in this order:

1. **`JARVIS_ENCRYPTION_KEY` environment variable**: if set, the key is derived from it with scrypt. Intended for tests and CI.
2. **Electron `safeStorage`**: when `safeStorage.isEncryptionAvailable()` is true, a random key is generated once, encrypted by the OS credential store (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and persisted as `keystore.bin` in the config directory.
3. **File fallback**: outside Electron, or when `safeStorage` is unavailable, a CSPRNG key is persisted unencrypted as `keystore.fallback.bin` (mode `0o600`). This is weaker, because protection relies on file permissions only.

If a key file is unreadable or corrupted, a new key is generated and previously encrypted values fail to decrypt, so the user must re-authenticate. There is no `keytar` or `node-keychain` dependency and Windows Credential Manager is not used.

---

## 14. Initial Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Node.js 20 LTS (bundled with Electron) | Stable, long-term support |
| **Language** | TypeScript 5.x | Type safety, better DX, refactoring support |
| **GUI shell** | Electron | System tray, notifications, startup on boot, web UI |
| **LLM** | Ollama (local) via `ollama` package | Official SDK, tool calling support |
| **MCP** | `@modelcontextprotocol/sdk` | Official SDK, act as MCP client |
| **Storage** | SQLite via `sql.js` (WASM) | No native module rebuilds for Electron; persisted to a single file |
| **GitHub API** | Native `fetch` + hand-written GitHub OAuth Device Flow | No SDK dependency, frictionless auth |
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
│   │   ├── database.ts              # sql.js database, migrations
│   │   ├── schema.ts                # Table definitions & migrations
│   │   └── encryption.ts            # AES-256-GCM + key management (safeStorage)
│   ├── tasks/                       # NOT IMPLEMENTED (deferred, §10)
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
│   └── container/                   # NOT IMPLEMENTED (deferred, §9)
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
├── Dockerfile                       # NOT IMPLEMENTED (deferred, §9)
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
| **Phase 2** | sql.js storage + field-level encryption + config loading | Persistent state, encrypted secrets, onboarding tracking |
| **Phase 3** | Ollama discovery + model selection | Detects Ollama, user selects model, notification-driven |
| **Phase 4** | Local repo scanning | Scans directories for `.git` repos, indexes into SQLite |
| **Phase 5** | GitHub OAuth + org/repo indexing | Device Flow login, discover orgs/repos, correlate with local |
| **Phase 6** | MCP client integration | Can connect to MCP servers, expose tools to Ollama |
| **Phase 7** | Chat / prompt UI + Ollama routing | Natural-language prompts dispatched to MCP tools |
| **Phase 8** | Async task runner + scheduling (**not implemented**) | Background task queue with cron scheduling |
| **Phase 9** | Activity tracking + weekly summaries | Cross-repo PR/issue tracking, work journal, generated summaries |
| **Phase 10** | Secrets scanning + fork analysis | Scan for exposed secrets, analyze fork upstream divergence |
| **Phase 11** | Container isolation (**not implemented**) | Optional sandboxed execution for security-sensitive tasks |
| **Phase 12** | Advanced maintenance tasks | Stale repo detection, dependency audits, branch cleanup |

---

## 15. Claude Rate Limit Awareness

Jarvis can track the user's Claude **subscription** (Pro/Max) usage limits — not to be confused with Anthropic Console API keys, which have separate pay-as-you-go limits.

### Credential Source

Two ways to connect:

1. **Direct OAuth sign-in (PKCE)** — a "Sign in with Claude" button in the Claude panel opens `claude.ai/oauth/authorize` with the public Claude Code OAuth client; the user pastes the displayed code back into Jarvis. Tokens are stored encrypted in the Jarvis config store.
2. **Claude Code credentials fallback** — reuses `~/.claude/.credentials.json` (`claudeAiOauth.*`) when present. Tokens with missing/zero expiry are tried anyway; a 401 from the probe triggers refresh + retry. Refreshed tokens are cached encrypted in Jarvis — Claude Code's file is never modified.

### Probing the Limit

A minimal `POST /v1/messages` probe (`max_tokens: 1`, cheapest Haiku model, `anthropic-beta: oauth-2025-04-20`) returns the unified rate-limit headers:

- `anthropic-ratelimit-unified-5h-utilization` / `-5h-reset` — rolling 5-hour window
- `anthropic-ratelimit-unified-7d-utilization` / `-7d-reset` — rolling 7-day window
- HTTP 429 + `retry-after` when a window is exhausted (rejected probes don't consume quota)

When both windows are exhausted the binding reset is the *later* of the two — both must lift before the account is usable again.

### UI

- **Setup tab**: a "Claude AI" step tile (plugin: `src/plugins/claude/`) shows connection status and opens a detail panel with per-window utilization and reset times.
- **Status bar**: a ticker badge next to the GitHub rate-limit badges. Green with 5h utilization when healthy; pulsing red countdown (`⏳ Claude limited · resets in …`) while limited. Polled every 2 minutes, tightening to 30s while limited.

---

## 16. Copilot AI Credit Budget Tracking

Since June 2026 GitHub Copilot bills usage in **AI credits** (1 AIC = $0.01). Usage is metered per calendar month (UTC) and resets on the 1st.

### Data Sources

**1. Internal quota endpoint (preferred)** — `GET /copilot_internal/user`, the call VS Code and the Copilot CLI make. Its `quota_snapshots.premium_interactions` block gives `credits_used`, `entitlement`, `remaining` and `unlimited`, plus `quota_reset_date_utc` and `copilot_plan` at the top level. It reports the quota of **any** seat, including seats billed through an organization or enterprise. GitHub only answers it for tokens minted by its own OAuth apps (VS Code, `gh`); the Jarvis OAuth app's token is refused, so Jarvis reuses the GitHub CLI's token via `gh auth token` (`getGhCliToken()`, 10s timeout, silently skipped when `gh` is missing or logged out). No special scope or user agent is needed.

**2. Public billing report (fallback)** — `GET /users/{username}/settings/billing/ai_credit/usage?year=YYYY&month=M` (enhanced billing platform) returns usage line items per model. Jarvis sums them:

- `grossQuantity` → total credits consumed this month
- `discountQuantity` → credits covered by the plan's included allowance
- `netQuantity` / `netAmount` → billed credits / USD

Only the user's **personal** plan usage is reported here; seats billed through an organization or enterprise show 0.

### Authentication

Order: GitHub CLI token → linked OAuth token (device flow) → PAT. The billing report needs the classic `user` scope, so `user` replaced `read:user` in the default scopes and `resolveGitHubScopes()` forces it onto older `config.json` scope lists. Existing sign-ins get a **Re-authorize GitHub** button in Settings when the fallback returns 403/404 (and the CLI route was unavailable). The PAT is used last (classic PAT with `user`, or fine-grained PAT with the *Plan* read permission).

### Budget

GitHub has no REST endpoint for personal budgets, so the monthly budget (in AI credits) is a Jarvis setting (`config` key `copilot_aic_monthly_budget`), edited under **Settings → GitHub Copilot AI Credits**. A desktop notification fires once per month at 80% and at 100% of the budget.

### Scheduling & UI

- **Background task** `copilot-ai-credit-usage` (main process) runs 20s after startup and then every 30 minutes, caches the result and pushes `copilot-usage:updated` to the renderer.
- **Status bar**: `◈ Copilot used/limit AIC` badge (green / orange at ≥80% or projected overrun / red at ≥100%), where the limit is the user's budget or, when none is set, the plan's included credits from the quota endpoint. Hovering shows month-to-date usage, remaining budget, included vs entitlement (or billed) credits, the month-end projection at the current pace, top models (billing report only), the time until the reset, and which token produced the data.

---

## 17. Active Agent Sessions & PR Review Readiness

The **🤖 Agent Sessions** tab lists every AI coding session that is running right now — GitHub Copilot (CLI, Copilot app, cloud agent) and Claude Code — together with the pull request it works on, and answers one question per PR: *is it ready for a human review yet?*

### Session sources

| Source | Where | Liveness / activity |
|--------|-------|---------------------|
| Copilot CLI / Copilot app (local) | `~/.copilot/session-state/<id>/` — `workspace.yaml` (cwd, name, client, `mc_task_id`), `events.jsonl` | Live while an `inuse.<pid>.lock` belongs to a running process that started before the lock was written (lock files survive crashes and Windows reuses pids, so a live pid alone is not enough). Activity from the tail of `events.jsonl` (64 KB, widened up to 4 MB when the tail holds no decisive event — permission prompts can carry large diffs): open `permission.requested` / `ask_user` → *needs input*; turn/tool/model events → *working*; `assistant.turn_end` (>20 s ago), `session.task_complete`, `session.start/resume` → *idle*. Only dirs touched in the last 3 days are inspected. |
| Claude Code (local) | `~/.claude/sessions/<pid>.json` + transcript `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | Live while the pid runs and started before the pid file was written. *Idle* when the last assistant message has `stop_reason: end_turn` or the transcript is untouched for 2 min. |
| Copilot cloud agent | `GET /agents/tasks` (`X-GitHub-Api-Version: 2026-03-10`, user token) | Task `state`; every active task (queued / in progress / idle / waiting for user, any age, all pages) plus finished tasks with a PR from the last 24 h. Tasks mirrored from a *running* local Copilot app session (`mc_task_id`) are skipped to avoid duplicates; mirrored sessions whose process is gone are listed as "Copilot app (idle)". The endpoint allows 60 requests/hour, so a full listing runs every 15 min with incremental `since` fetches in between, and task details are only re-fetched when a task changes. |

These are the same stores the [ai-engineering-fluency](https://github.com/rajbos/ai-engineering-fluency) project reads for usage analytics. Its npm package is CLI-only and reports aggregate stats (no per-session listing or liveness), so Jarvis reads the stores directly in `src/services/local-agent-sessions.ts`; that module can be swapped for the package once it exposes a per-session listing.

### Linking sessions to PRs

- Local sessions: the session `cwd` is resolved to repo + branch by reading `.git` metadata (`src/services/git-context.ts`, worktree-aware). The PR is matched on the *local* branch name — not the tracked upstream, which is `main` for worktrees created from `origin/main` and the parent branch for stacked branches. The branch's open PR is looked up in the push remote first, then `upstream` (filtered by head owner for fork branches). Default branches (`main`, `master`, `develop`, `trunk`) are skipped.
- Cloud tasks: PR node ids from the task's `pull` artifacts, else the task's head branch.
- All lookups are resolved in batched, aliased GraphQL queries (10 lookups per request, per-alias error isolation) in `src/services/pr-readiness.ts`.

### Readiness rules (evaluated on the PR's head commit)

| Light | Green | Amber (blocks review) | Red (does not block) | Grey |
|-------|-------|------------------------|----------------------|------|
| **Agent** (informational, never blocks) | Idle / done | Working, queued, needs input | Failed / timed out | Unknown |
| **Checks** | All passed | Any check run / status still pending, or no checks yet on a commit pushed < 5 min ago | Finished, some failed | No checks reported |
| **Copilot review** | Copilot reviewed the head commit | Review running, requested, or only older commits reviewed (*stale*) | Review run errored | No Copilot review attached |

A PR is **ready for review** when it is open and neither *Checks* nor *Copilot review* is blocking. Failed checks do not block — the checks have *completed*, which is the gate; the red light tells the reviewer what to expect. Draft PRs can be ready (labelled "(draft)"). The Copilot reviewer is detected by its `copilot-pull-request-reviewer` check run (via `checkSuites`, as it isn't part of `statusCheckRollup`), pending review requests and reviews by the Copilot bot logins.

### Background check & notifications

The `active-sessions-readiness` background task (`src/main/background-tasks.ts`) sweeps every 2 minutes (first run 20 s after start). Each sweep upserts the `pr_readiness` table (schema v30) and raises a desktop notification when a PR becomes ready — once per head commit, tracked in `ready_notified_sha`. The notification is held while a linked agent is still *working* or *queued* (it may push more commits) and fires on the first sweep after it settles. The renderer receives each snapshot via `active-sessions:updated`; `active-sessions:get` returns the latest snapshot and `active-sessions:refresh` forces a sweep. Concurrent refreshes share one in-flight sweep.

### Not covered yet

- Claude Code on the web / cloud sessions (no public listing API).
- VS Code Copilot Chat sessions (no liveness signal in the chat session store).

---

## Decision Log

| Decision | Status | Notes |
|----------|--------|-------|
| Language/runtime | **TypeScript / Node.js** | Easy unit/integration tests, mature SDKs |
| GUI host | **Electron** | System tray, notifications, startup on boot, web UI |
| Windows startup method | **Electron `openAtLogin`** | Registry-based, no Task Scheduler needed |
| Storage engine | **SQLite via `sql.js`** | Zero config, queryable, no native rebuilds |
| Secret encryption | **AES-256-GCM field encryption, key in Electron `safeStorage`** | Protects tokens at rest; whole-database encryption was not adopted |
| GitHub authentication | **OAuth Device Flow** (native `fetch`, no `octokit`) | Frictionless browser-based login |
| MCP server approach | **Pre-built server first** | Quick start, move to hybrid later |
| Ollama model | **User selects at onboarding** | Detected from local Ollama installation |
| Testing framework | **Vitest** | Fast, TypeScript-native |
| Async task execution | **Deferred (not implemented)** | Actor-style task runner idea, see §10 |
| Container isolation | **Deferred (not implemented)** | Docker sandboxing idea, see §9 |
| Activity summaries | **Weekly generated summaries** | Cross-repo PR/issue/review aggregation + work journal |
| Agent session discovery | **Read local session stores directly** | ai-engineering-fluency npm package has no per-session/liveness output yet; swap in when it does |
| PR review readiness | **Checks completed + Copilot review on head commit** | Failed checks don't block; stale Copilot review does; agent activity is informational |

---

_Last verified against source: 2026-10-01 (origin/main 4056acc)._
