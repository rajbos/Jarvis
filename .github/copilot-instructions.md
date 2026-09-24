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
- **Panel layout — always append, never replace**: The UI is a horizontally-scrolling layout (`width: max-content`). When a user action opens a new sub-panel (e.g. drilling into a folder, opening notifications), render it **to the right** of the current panel — never hide or replace the panel that triggered it. If horizontal space runs out the container scrolls. The only exception is a deliberate "back" navigation where the child panel closes and the parent is already visible.
- **Step mutual exclusivity — close all panels before opening a new step**: Each top-level step tile (GitHub, Local Repos, Secrets, Ollama) acts as a toggle. When a step is opened, **all** other steps' panels — including every sub-panel in their hierarchy — must be closed first. Implement a single `closeAllPanels()` helper that resets every panel-related state variable (including nested sub-panel states and any `localStorage` entries for persistent panels such as chat). Pass the saved `wasOpen` flag to decide whether to re-open the step or leave everything closed. This prevents "sticky" sub-panels that remain visible after switching to a different step.
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
- **Run build AND tests after file changes**: After making any changes to TypeScript or JavaScript files, always run `npm run build` first (to catch TypeScript type errors across the whole project), then `npm test` (to verify unit tests). Fix all build errors and test failures before considering the work complete.
- **IPC catalogue**: When adding a new `ipcMain.handle` channel, also add its name to the `EXPECTED_CHANNELS` array in `tests/unit/ipc-registration.test.ts`
- **Automation**: CI/CD is not configured by default; contributors should run tests locally before PRs

---

## Known Gotchas & Lessons Learned

- **GitHub API: mark notification as read** — Use `PATCH /notifications/threads/{id}` to mark a thread as read. Do **not** use `DELETE`, which unsubscribes from the thread rather than marking it read, causing notifications to reappear on the next sync.
- **Dismiss banners: clear local state immediately** — After a dismiss/bulk-dismiss action, call `setEntries([])` (or equivalent state reset) immediately in addition to triggering the parent refresh callback. Relying solely on the parent `load()` to re-render leaves the banner visible during the async reload.
- **Auto-dismiss scope for PR notifications** — Only offer to auto-dismiss PR notifications for PRs that the user explicitly actioned: Dependabot PRs (identified by `subject_actor_login` containing `"dependabot"` or matching title patterns) and PRs merged or closed by the current authenticated user. Do not auto-dismiss notifications for PRs closed/merged by other contributors — the user may still want to review them.
- **Auto-dismiss scope for issue notifications** — Issues are auto-dismissed when closed by the current user (`closed_issue_me`), closed via a merged PR commit link (`closed_issue_via_pr`), or closed by someone else's merged PR that the user collaborated on as PR author, merger, or commit author/committer (`closed_issue_collab_pr`, detected via the issue timeline's cross-referenced PRs). Issues closed by other people without a user-linked PR are left alone.
- **Database schema changes: always backward compatible** — Never add a column to a `SELECT` query that might not exist in older databases. Either: (1) make schema changes additive-only and handle missing columns gracefully in code, (2) write a database migration script, or (3) use `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL` and ensure existing queries don't break. Adding `g.ruddr_project_paths` to a query will crash for users with old schemas.
- **Dependency hygiene: no orphaned deps** — Every dependency listed in `package.json` must have a real import somewhere in `src/`. When removing a feature or refactoring away from a library, check whether its dependency entry is now orphaned and remove it (e.g. `octokit` and `electron-squirrel-startup` were left in `dependencies` unused for a Squirrel.Windows/GitHub-SDK approach the code never adopted). `npm run check:deps` (knip, configured in `knip.json`) enforces this in CI — it fails the build on any unused or unlisted dependency, so remove or genuinely justify (via `ignoreDependencies`) anything it flags rather than adding it back unused.
- **Main-process code logs via `logger`, never `console.*`** — All non-UI code (`src/main/**`, `src/services/**`, `src/storage/**`, `src/plugins/**/*.ts`, `src/mcp-server/**`) must call `logger.error/warn/info/debug` from `src/services/logger.ts` instead of `console.*`, so `setLogLevel(app.isPackaged ? 'warn' : 'debug')` (set in `src/main/index.ts`) actually gates verbosity in packaged builds. This is enforced by an eslint `no-console: 'error'` rule scoped to those folders (see `eslint.config.mjs`); `src/services/logger.ts` itself is exempt since it's the wrapper. Renderer code (`src/renderer/**`, any `*.tsx`) runs in the browser context, has no access to the packaged/dev distinction, and may keep using `console.*` — it is intentionally excluded from the rule. Never log secrets, tokens, PATs, keys, or full raw API responses — log a redacted summary instead (e.g. `data.access_token ? 'token received' : 'no token'`, not the raw payload).
- **IPC handlers register via `safeHandle()`, never raw `ipcMain.handle`** — Use `safeHandle()` from `src/plugins/ipc-utils.ts` for every IPC channel; it centralizes error handling (logging + the `{ ok: false, error }` failure shape). A `no-restricted-syntax` eslint rule bans `ipcMain.handle(` everywhere under `src/` except inside `ipc-utils.ts` itself.
