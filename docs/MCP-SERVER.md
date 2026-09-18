# Jarvis MCP Server

The Jarvis MCP server exposes locally-cached data from the Jarvis SQLite database over the [Model Context Protocol](https://modelcontextprotocol.io/) (stdio transport). Use it with Claude Desktop, GitHub Copilot, or any other MCP-compatible client to query your GitHub repos (remote and local clones), notifications, Ruddr projects and budgets, client groups, and OneNote content without leaving your AI assistant.

## Design principle: cached data only, no credentials

The server is a **read-only reader of the Jarvis database**. It never receives the GitHub token, the Ruddr session or any other credential from the Electron app, and it never calls GitHub or Ruddr itself. Everything it returns is whatever the running Jarvis app last synced: repo discovery, local repo scans, notification polling, and Ruddr budget scraping. Check `fetchedAt` / `indexedAt` style fields in responses when freshness matters.

## Prerequisites

- Jarvis has been started at least once (creates the database at `%APPDATA%\Jarvis\jarvis.db`)
- Node.js 18+

## Running the server

```bash
# One-shot: build + start
npm run mcp

# Or run the pre-built binary directly
node dist/mcp-server/index.js
```

To point at a different database file:

```bash
JARVIS_DB="C:\path\to\custom.db" node dist/mcp-server/index.js
```

## Claude Desktop configuration

Add this to your `claude_desktop_config.json` (usually at `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jarvis": {
      "command": "node",
      "args": ["C:\\path\\to\\Jarvis\\dist\\mcp-server\\index.js"]
    }
  }
}
```

After a Jarvis build (`npm run build`), restart Claude Desktop to pick up changes.

## Available tools

Tools are grouped into families by prefix. `github_*` answers "where is / what happened with" questions across everything GitHub-related; `ruddr_*` answers project and budget questions.

### GitHub tools (cached remote repos, local clones, notifications, workflow runs)

| Tool | Description |
|---|---|
| `github_find` | One-shot search across remote repos, local clones, notifications **and file contents**. Start here when you do not know where something lives (e.g. "azure devops pipeline minutes") |
| `github_search_files` | Full-text search over file paths and contents inside local clones. Best for "where is the script that does X". Options: `repoPath`, `kind` (script/doc/config/source/other), `limit` |
| `github_index_status` | What the file index covers: repos, files, last build time, per-repo counts and skip reasons |
| `github_search_repos` | Search discovered GitHub repos by words in name, description or language; returns metadata plus known local clone paths. Options: `owner`, `includeArchived`, `limit` |
| `github_local_repos` | List git clones found on this machine with paths, remotes and linked GitHub repo; optional `query` filter |
| `github_notifications` | Cached GitHub notifications, newest first. Filters: `query`, `repo` (`owner/repo` or `owner`), `unreadOnly`, `since`, `limit` |
| `github_workflow_runs` | Cached GitHub Actions runs. Filters: `repo`, `conclusion`, `limit` |

Repo-level search terms are ANDed and matched case-insensitively with `LIKE`. File search uses an FTS4 full-text index with prefix matching (all words required).

#### The local file index

`github_search_files` (and the `files` array of `github_find`) read a **separate** database, `jarvis-index.db`, that sits next to `jarvis.db` (override with `JARVIS_INDEX_DB`). The Jarvis app builds it right after every local repo scan (hourly, and on demand via the `local:start-index` IPC channel):

- Files are enumerated with `git ls-files` (tracked + untracked, honouring `.gitignore`), so `node_modules`, `dist` and similar never enter the index. A bounded directory walk is the fallback when git is unavailable.
- Every file is indexed by path. Text is stored for scripts and docs (first 16 KB), config (8 KB) and source files (2 KB); lock files, minified files and binaries are path-only.
- Each repo gets at most 1 MB of text. Files are processed scripts-first and shallow-paths-first so the cap keeps the most useful content; the rest stays searchable by path.
- Re-runs are incremental (size + mtime), and the file is written atomically so the MCP server never reads a half-written index.

The index is kept out of `jarvis.db` on purpose: sql.js persists a database by rewriting the whole file, and the index is tens of megabytes.

### Ruddr tools (projects and budgets)

| Tool | Description |
|---|---|
| `ruddr_customer_budget` | "What is the budget utilization for customer X?" Fuzzy-matches a Jarvis group, returns budget / budget left / actual hours and a computed `utilization` fraction per linked project plus totals. Falls back to matching Ruddr project names directly |
| `ruddr_list_budgets` | Every cached Ruddr budget with parsed utilization |
| `ruddr_list_projects` | List all cached Ruddr projects (name, path, note, cloud folder URL) |
| `ruddr_get_project` | Look up one project by `name` (case-insensitive) or `path` |
| `groups_with_ruddr` | List only groups that have Ruddr project associations |

Budget values are scraped from ruddr.io by the Groups plugin and cached in the `ruddr_budgets` table (schema v29+). Until the app has scraped at least once, `ruddr_customer_budget` still lists the customer's projects but reports `budgetCacheAvailable: false` and null figures.

### Group & OneNote tools

| Tool | Description |
|---|---|
| `groups_list` | List all customer/client groups with their IDs |
| `onenote_list_sections` | List all cached OneNote sections; optionally filter by `groupId` |
| `onenote_search` | Keyword search over page titles + content; returns snippets |
| `onenote_get_page` | Get full content of one page by `groupId`, `relativePath`, `pageIndex` |

### How to navigate OneNote data

1. Call `groups_list` to get group IDs.
2. Call `onenote_list_sections` with a `groupId` to see what sections are cached.
3. Call `onenote_search` to find relevant pages by keyword.
4. Call `onenote_get_page` with the exact `groupId` / `relativePath` / `pageIndex` from search results to retrieve the full content.

## Data freshness

The server reloads the database snapshot on **every tool call**, so it always reflects the latest data written by the Electron app. No server restart is needed after Jarvis syncs new data.
