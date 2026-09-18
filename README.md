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

```powershell
npm install
npm run dev
```

### Run and debug from VS Code

Open the repository in VS Code and press **F5**, then choose **Jarvis: Debug Electron**. The launch configuration builds the app, starts Electron with the main-process debugger attached, and stores development data under `.dev-data` while using browser bridge port `35790`. This keeps a repository debug session separate from an installed Jarvis instance.

Use **Terminal → Run Task → Jarvis: Development** for the watch/reload development workflow. Renderer DevTools remain available with `Ctrl+Shift+I`.

### Install and start with Windows

Create a Windows installer:

```powershell
npm run dist:win
```

Run the installer generated under `release`. In the installed app, open **Settings → Windows Startup** to choose whether Jarvis starts when you sign in and whether it starts minimized to the system tray. Login registration is intentionally disabled for repository development runs.

### Publish updates

Installed builds check the latest public GitHub Release 15 seconds after startup and every six hours, using [`electron-updater`](https://www.electron.build/auto-update). When a newer version is found, Jarvis downloads it in the background and shows a Windows notification once it's ready — click it to restart Jarvis and finish installing. You can also trigger a check any time via **Jarvis → Check for Updates…** from the application menu.

To publish an update, note that `main` requires pull requests, so releasing is a two-step flow. First raise the version bump as a pull request:

```powershell
git switch -c chore/release-v0.1.2        # use the version you are releasing
npm version patch --no-git-tag-version    # or minor / major
git commit -am "chore: release v0.1.2"
git push --set-upstream origin chore/release-v0.1.2
gh pr create --base main --fill
```

Once that pull request is merged, tag the merged commit on `main`:

```powershell
git switch main
git pull --ff-only origin main
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2
```

Always tag a commit that is already on `main`. The tag is what the release is built from, so tagging anything else ships source that was never merged.

Pushing a tag such as `v0.1.2` runs `.github/workflows/release.yml` on a `windows-latest` runner. The workflow verifies that the tag matches `package.json`, runs the test suite, builds the NSIS installer, and publishes `Jarvis-Setup-<version>.exe`, its block map, and `latest.yml` to the GitHub Release for that tag (creating the release with generated notes if it does not exist yet). The same three files are also uploaded as a `windows-installer` workflow artifact. For a local authenticated publish, use `npm run publish:win` with `GH_TOKEN` set.

The workflow builds with `electron-builder --publish never` and uploads assets in a separate step using the built-in `github.token`. No personal access token is required. Removing `--publish never` makes electron-builder try to publish during the build, which fails with a misleading "GitHub Personal Access Token is not set" error.

The installer is currently unsigned, so Windows SmartScreen may warn until a code-signing certificate is configured.

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
