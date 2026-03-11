# copilot-instructions.md

## Repository Overview

This project is **Jarvis**: a locally-hosted personal assistant agent for GitHub repository maintenance, built with Electron and TypeScript, running on Windows. It integrates with [Ollama](https://ollama.com/) for natural language understanding and is extensible via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

### Key Features

- Electron desktop app with system tray presence
- Local LLM (Ollama) integration for prompt handling
- Extensible via MCP for new tools/services
- GitHub OAuth and repo discovery
- Encrypted local SQLite storage
- Automated repo maintenance tasks

---

## Folder Structure

- **src/**
  - **agent/**: Agent configuration and onboarding logic
  - **main/**: Electron main process (entry point, IPC, tray, window management)
  - **renderer/**: Frontend (HTML, TSX, CSS) for onboarding and settings
  - **services/**: Integrations (e.g., GitHub discovery, OAuth)
  - **storage/**: Local database, encryption, and schema definitions
  - **types/**: TypeScript type declarations (e.g., for sql.js)
- **assets/**: (Currently empty) — for static assets
- **docs/**: Documentation (see ARCHITECTURE.md for design/requirements)
- **scripts/**: Node scripts for building and watching Electron/renderer
- **tests/unit/**: Unit tests for all major modules

---

## Key Scripts

- **npm run build**: Compile TypeScript, build renderer, copy static files
- **npm start**: Build and launch the Electron app
- **npm run dev**: Concurrently run TypeScript, renderer, and Electron in watch mode for development
- **npm test**: Run all unit tests with Vitest
- **npm run test:watch**: Watch mode for tests

Scripts for development:
- **dev:tsc**: TypeScript compiler in watch mode
- **dev:esbuild**: Renderer build in watch mode
- **dev:electron**: Electron main process in watch mode

---

## Build & Test

- **Build output**: Compiled files go to `dist/`
- **Renderer static files**: Copied from `src/renderer/*.html` to `dist/renderer/`
- **Tests**: All test files are in `tests/unit/` and use Vitest (`*.test.ts`)
- **TypeScript config**: See `tsconfig.json` (strict mode, ES2022, declaration maps)

---

## Conventions

- **Strict TypeScript**: All code is type-checked with strict settings
- **Separation of concerns**: Main process, renderer, agent logic, and services are in separate folders
- **No cloud dependencies**: All core features run locally
- **Extensibility**: New features should be added as modules/services, following the MCP protocol where possible

---

## Contributor & Automation Notes

- **Windows-first**: The app is designed for Windows; cross-platform support is not guaranteed
- **Ollama required**: Local Ollama instance must be running for natural language features
- **GitHub OAuth**: For repo discovery/maintenance, connect your GitHub account via the onboarding flow
- **Sensitive data**: All local storage is encrypted; do not commit secrets
- **Scripts**: Use the provided npm scripts for all build/test/dev workflows
- **Documentation**: See `docs/ARCHITECTURE.md` for design and requirements before contributing major changes

---

## Special Instructions

- **First run**: Use onboarding flow to configure Ollama and GitHub
- **Extending**: Add new MCP integrations in `src/services/` or as new modules
- **Testing**: All new code should include unit tests in `tests/unit/`
- **Automation**: CI/CD is not configured by default; contributors should run tests locally before PRs
