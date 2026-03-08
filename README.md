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
