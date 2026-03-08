# Jarvis Agent — Architecture Specification

> **Status**: Draft — exploring options before implementation  
> **Goal**: A locally-hosted personal assistant agent that runs on Windows, integrates with a local Ollama instance for natural-language understanding, is easy to extend via MCP (Model Context Protocol), and starts with GitHub repository maintenance capabilities.

---

## Table of Contents

1. [Requirements Summary](#1-requirements-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Runtime & Language Options](#3-runtime--language-options)
4. [Windows Startup Strategies](#4-windows-startup-strategies)
5. [Ollama Integration](#5-ollama-integration)
6. [MCP Extensibility](#6-mcp-extensibility)
7. [Local Storage](#7-local-storage)
8. [GitHub Maintenance Module](#8-github-maintenance-module)
9. [Configuration](#9-configuration)
10. [Recommended Approach](#10-recommended-approach)

---

## 1. Requirements Summary

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | Runs locally on Windows | No cloud dependency for core operation |
| R2 | Starts on system startup | Minimal user intervention after install |
| R3 | Natural-language prompt interface | User talks to the agent in plain English |
| R4 | Uses local Ollama for LLM inference | No API keys or cloud LLM costs |
| R5 | Easy to extend over time | Adding new capabilities should be simple |
| R6 | MCP support for tool/service integration | Standardized protocol for connecting tools |
| R7 | Local persistent storage | Agent can store state, indexes, preferences |
| R8 | GitHub repo & org maintenance | First concrete use case |

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Jarvis Agent                          │
│                                                              │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────────┐ │
│  │   Prompt    │   │   Ollama    │   │   Action Executor    │ │
│  │   Input     │──▶│   Router    │──▶│   (MCP Dispatch)     │ │
│  │  (CLI/API)  │   │            │   │                      │ │
│  └────────────┘   └────────────┘   └──────────┬───────────┘ │
│                                                │             │
│                                    ┌───────────┴───────────┐ │
│                                    │     MCP Client Hub    │ │
│                                    │                       │ │
│                                    │  ┌─────┐  ┌────────┐ │ │
│                                    │  │ GitHub│  │ Future │ │ │
│                                    │  │ MCP  │  │ MCP    │ │ │
│                                    │  │Server│  │Servers │ │ │
│                                    │  └─────┘  └────────┘ │ │
│                                    └───────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Local Storage (SQLite)                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐ │  │
│  │  │  Config   │  │  Indexes  │  │  Conversation Log   │ │  │
│  │  └──────────┘  └──────────┘  └─────────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Core Flow

1. **Prompt Input** — User submits a natural-language request (CLI, API, or future GUI).
2. **Ollama Router** — The local Ollama model interprets the prompt and determines which action(s) to invoke, including which MCP tools to call and with what parameters.
3. **Action Executor** — Dispatches tool calls to the appropriate MCP server(s) and collects results.
4. **Response** — Results are optionally summarized by Ollama and returned to the user.

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

## 4. Windows Startup Strategies

### Option 1: Windows Task Scheduler

- Create a scheduled task triggered at user logon.
- Works with any runtime (Python, Node.js, .NET).
- Can be set up via PowerShell script during install.
- **Pros**: Simple, no admin rights needed for per-user tasks, reliable.
- **Cons**: Not a true service (no service manager integration).

### Option 2: Windows Service

- Register as a native Windows service using `sc.exe` or framework helpers.
- Best support in .NET (`BackgroundService` / `Worker Service` template).
- Possible in Node.js via `node-windows`, in Python via `pywin32`.
- **Pros**: Runs before user login; managed by Windows service infrastructure; auto-restart on failure.
- **Cons**: More complex setup; may need admin rights.

### Option 3: Startup Folder / Registry Run Key

- Place a shortcut in `shell:startup` or add a registry entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **Pros**: Simplest approach; easy to understand.
- **Cons**: Only runs after user login; less control over restart behavior.

### Option 4: System Tray Application

- Run as a background app with a system tray icon for quick access.
- Best support in .NET (WinForms `NotifyIcon`) or Electron.
- Python can use `pystray`.
- **Pros**: Visible presence; easy to access; can combine with any startup method.
- **Cons**: Requires a GUI framework.

### Recommendation

Start with **Task Scheduler** (Option 1) for simplicity. Consider adding a **system tray icon** (Option 4) later for visibility. Move to a **Windows Service** (Option 2) only if the agent needs to run before user login or requires service-level reliability.

---

## 5. Ollama Integration

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

## 6. MCP Extensibility

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

## 7. Local Storage

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

-- GitHub organizations being tracked
CREATE TABLE github_orgs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    login      TEXT NOT NULL UNIQUE,
    name       TEXT,
    indexed_at DATETIME,
    metadata   TEXT  -- JSON blob for flexible fields
);

-- GitHub repositories index
CREATE TABLE github_repos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id         INTEGER REFERENCES github_orgs(id),
    full_name      TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    description    TEXT,
    default_branch TEXT,
    language       TEXT,
    archived       INTEGER DEFAULT 0,
    private        INTEGER DEFAULT 0,
    last_pushed_at DATETIME,
    last_updated_at DATETIME,
    indexed_at     DATETIME,
    metadata       TEXT  -- JSON blob for flexible fields
);

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

## 8. GitHub Maintenance Module

### Initial Capabilities

The first concrete use case is GitHub repository maintenance. The agent should support:

#### 8.1 Repository & Organization Indexing

- **Index organizations** — Discover and store all orgs the user belongs to.
- **Index repositories** — For each org, list and store all repositories with metadata.
- **Incremental updates** — Only fetch changes since last index.
- **Search** — Query the local index by name, language, last activity, etc.

#### 8.2 Maintenance Tasks (Future)

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

#### 8.3 Implementation Approach

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

## 9. Configuration

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
  }
}
```

### Environment Variables

Sensitive values (tokens, keys) should come from environment variables, never stored in config files:

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token |
| `JARVIS_CONFIG_DIR` | Override default config directory |
| `OLLAMA_HOST` | Override Ollama URL |

---

## 10. Recommended Approach

Based on the requirements analysis, here is the recommended starting point:

### Language: Python

**Rationale**: Python offers the most mature MCP SDK, the best Ollama integration, and the fastest path to a working prototype. The AI/ML ecosystem is unmatched. For a personal assistant that needs rapid iteration, Python is the strongest choice.

### Initial Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Python 3.12+ | Latest stable, good performance |
| **LLM** | Ollama (local) via `ollama` package | Official SDK, tool calling support |
| **MCP** | `mcp` package (official SDK) | Act as MCP client to connect tools |
| **Storage** | SQLite via `sqlite3` (stdlib) | Zero dependencies, reliable |
| **GitHub** | Pre-built GitHub MCP Server | Quick start, no custom code |
| **CLI** | `click` or `typer` | Clean CLI interface |
| **Startup** | Windows Task Scheduler | Simple, reliable, no admin needed |
| **Config** | JSON files | Human-readable, easy to edit |

### Suggested Project Structure

```
jarvis/
├── src/
│   └── jarvis/
│       ├── __init__.py
│       ├── __main__.py          # Entry point
│       ├── agent.py             # Core agent loop
│       ├── config.py            # Configuration loading
│       ├── llm/
│       │   ├── __init__.py
│       │   └── ollama_client.py # Ollama integration
│       ├── mcp/
│       │   ├── __init__.py
│       │   └── client.py        # MCP client hub
│       ├── storage/
│       │   ├── __init__.py
│       │   ├── database.py      # SQLite operations
│       │   └── models.py        # Data models
│       └── tools/
│           ├── __init__.py
│           └── github.py        # GitHub-specific logic
├── config/
│   └── default.json             # Default configuration
├── tests/
│   └── ...
├── docs/
│   └── ARCHITECTURE.md          # This document
├── pyproject.toml               # Project metadata & dependencies
├── README.md
└── .gitignore
```

### Implementation Phases

| Phase | Scope | Outcome |
|-------|-------|---------|
| **Phase 1** | Core agent + Ollama + CLI | Can send prompts and get LLM responses |
| **Phase 2** | SQLite storage + config | Persistent state and configuration |
| **Phase 3** | MCP client integration | Can connect to MCP servers |
| **Phase 4** | GitHub MCP server + indexing | Index repos and orgs |
| **Phase 5** | Windows startup + packaging | Runs on startup, easy to install |
| **Phase 6** | Maintenance tasks | Stale repo detection, health checks, etc. |

---

## Decision Log

| Decision | Status | Notes |
|----------|--------|-------|
| Language/runtime | **To decide** | Python recommended; TypeScript and C# are viable alternatives |
| Windows startup method | **To decide** | Task Scheduler recommended for Phase 1 |
| Storage engine | **To decide** | SQLite recommended |
| MCP server approach for GitHub | **To decide** | Pre-built server recommended for Phase 1 |
| Ollama model | **To decide** | Depends on available hardware; 7-8B models are a good default |
