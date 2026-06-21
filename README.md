# Jarvis

Jarvis is a desktop productivity assistant designed to streamline your workflow by integrating automation, secure storage, and seamless access to your favorite services. Built with Electron and React, Jarvis provides a user-friendly interface and robust backend to help you manage tasks, credentials, and integrations efficiently.

## Main Features

- **Automated Workflows:** Trigger and manage custom workflows to automate repetitive tasks.
- **Secure Storage:** Store sensitive data securely using built-in encryption and a local database.
- **GitHub Integration:** Connect to GitHub for repository discovery and OAuth-based authentication.
- **Customizable Agent:** Extend Jarvis with your own agent logic and onboarding flows.
- **Settings & Onboarding UI:** Intuitive onboarding and settings screens for easy configuration.
- **Cross-Platform Support:** Runs on Windows, macOS, and Linux.

## Intended Use

Jarvis is intended for developers, power users, and teams who want a local, extensible assistant to automate tasks, manage credentials, and integrate with cloud services—without relying on third-party servers. It is ideal for those seeking a customizable, privacy-focused productivity tool.

## Getting Started

See below for installation and usage instructions.

# Jarvis

Rob's personal assistant agent — a locally-hosted AI agent built with Electron and TypeScript that runs on Windows, uses [Ollama](https://ollama.com/) for natural-language understanding, and is extensible via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

## Status

🔍 **Planning phase** — see the [Architecture Specification](docs/ARCHITECTURE.md) for the full design exploration.

## Goals

- Run as an Electron app with system tray presence, starting automatically on boot
- Guided onboarding: discover Ollama models, scan local repos, connect GitHub via OAuth
- Accept natural-language prompts routed through a local Ollama instance
- Extend capabilities easily by connecting MCP servers
- Maintain local persistent storage (encrypted SQLite) for indexes, config, and conversation history
- GitHub repository maintenance: secrets scanning, fork analysis, stale repo detection, dependency audits
- Cross-repo activity tracking with weekly summary generation and work journal
- Async background tasks with rate-limit awareness and cron scheduling
- Optional container isolation for security-sensitive operations

## MCP Server

Jarvis exposes cached data (Ruddr projects, customer groups, OneNote pages) via a [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio. Any MCP-compatible client (VS Code, Claude Desktop, Copilot, etc.) can connect.

### Setup

```bash
# Build the MCP server
npm run build:mcp

# Or build everything
npm run build
```

The server reads from the Jarvis SQLite database at `%APPDATA%\Jarvis\jarvis.db` (override with `JARVIS_DB` env var). Jarvis must have been started at least once to create the database.

### Connecting from an editor

Configure your editor's MCP client to spawn the server. Examples:

**VS Code** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "jarvis": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/mcp-server/index.js"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "jarvis": {
      "command": "node",
      "args": ["C:\\path\\to\\jarvis\\dist\\mcp-server\\index.js"]
    }
  }
}
```

### Available tools

After connecting, the following tools are available:

| Tool | Description |
|---|---|
| `ruddr_list_projects` | List all cached Ruddr projects |
| `ruddr_get_project` | Look up a project by name or path |
| `groups_list` | List all customer/client groups |
| `groups_with_ruddr` | Groups that have Ruddr associations |
| `onenote_list_sections` | List cached OneNote sections (filterable by group) |
| `onenote_search` | Keyword search over page titles + content |
| `onenote_get_page` | Get full page content |

See [docs/MCP-SERVER.md](docs/MCP-SERVER.md) for detailed usage.
