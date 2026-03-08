# Jarvis

Rob's personal assistant agent — a locally-hosted AI agent that runs on Windows, uses [Ollama](https://ollama.com/) for natural-language understanding, and is extensible via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

## Status

🔍 **Planning phase** — see the [Architecture Specification](docs/ARCHITECTURE.md) for the full design exploration.

## Goals

- Run locally on Windows with automatic startup
- Accept natural-language prompts routed through a local Ollama instance
- Extend capabilities easily by connecting MCP servers
- Maintain local persistent storage for indexes, config, and conversation history
- Start with GitHub repository and organization maintenance tasks
