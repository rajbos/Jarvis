# Jarvis MCP Server

The Jarvis MCP server exposes locally-cached data from the Jarvis SQLite database over the [Model Context Protocol](https://modelcontextprotocol.io/) (stdio transport). Use it with Claude Desktop, GitHub Copilot, or any other MCP-compatible client to query your Ruddr projects, client groups, and OneNote content without leaving your AI assistant.

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
      "args": ["C:\\Users\\<YOU>\\.copilot\\copilot-worktrees\\Jarvis\\rajbos-upgraded-broccoli\\dist\\mcp-server\\index.js"]
    }
  }
}
```

After a Jarvis build (`npm run build`), restart Claude Desktop to pick up changes.

## Available tools

### Ruddr tools (Phase 1)

| Tool | Description |
|---|---|
| `ruddr_list_projects` | List all cached Ruddr projects (name, path, note, cloud folder URL) |
| `ruddr_get_project` | Look up one project by `name` (case-insensitive) or `path` |
| `groups_with_ruddr` | List only groups that have Ruddr project associations |

### Group & OneNote tools (Phase 2)

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
