# Contributing to Jarvis

Thanks for your interest in Jarvis — a locally-hosted personal assistant agent for
GitHub repository maintenance, built with Electron and TypeScript.

## Prerequisites

- **Node.js 20** (the version CI builds against)
- **Windows** — the app is Windows-first; cross-platform support is not guaranteed
- **[Ollama](https://ollama.com/)** running locally, for the natural-language features

## Getting started

```powershell
npm install
npm run dev
```

`npm run dev` builds once, then runs the TypeScript compiler, the renderer bundler,
and Electron concurrently in watch mode.

You can also run and debug from VS Code: press **F5** and choose
**Jarvis: Debug Electron**. That configuration stores development data under
`.dev-data`, keeping a repository debug session separate from an installed Jarvis.

## Common scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript, build the renderer, copy static files into `dist/` |
| `npm start` | Build and launch the Electron app |
| `npm run dev` | Watch-mode development (TypeScript + renderer + Electron) |
| `npm test` | Run the unit tests with Vitest |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Run tests with a coverage report (written to `coverage/`) |
| `npm run lint` | Lint `src` with ESLint (`npm run lint:fix` to autofix) |

## Before you open a pull request

Run the build **and** the tests — in that order, since the build catches type errors
across the whole project that the tests alone will not:

```powershell
npm run build
npm test
npm run lint
```

Fix all build errors, test failures, and lint errors before pushing. CI
(`.github/workflows/ci.yml`) runs the same steps plus coverage.

## Conventions

- **Strict TypeScript** — all code is type-checked under strict settings.
- **Tests live in `tests/unit/`** and are named `*.test.ts`. New code should come
  with unit tests.
- **New IPC channels**: when adding an `ipcMain.handle` channel, also add its name
  to the `EXPECTED_CHANNELS` array in `tests/unit/ipc-registration.test.ts`.
- **Database schema changes must be backward compatible** — never add a column to a
  `SELECT` that might not exist in an older database. Make changes additive, or
  write a migration.
- **Separation of concerns** — main process, renderer, agent logic, and services
  each live in their own folder under `src/`.
- **No cloud dependencies** — all core features run locally.

See [.github/copilot-instructions.md](.github/copilot-instructions.md) for the full
set of conventions and accumulated gotchas, and `docs/ARCHITECTURE.md` before making
major design changes.

## Don't commit local run artifacts

Generated output from local runs must never be committed. This includes:

- coverage reports and captured test output (`coverage/`, `*coverage*.txt`, `*_output.txt`)
- build output (`dist/`, `out/`, `build/`, `*.tsbuildinfo`)
- local runtime data (`*.db`, `.dev-data/`, `logs/`)
- anything containing secrets (`.env`, `AppData/`)

These are all covered by [`.gitignore`](.gitignore), and CI fails the build if a
known artifact pattern is found tracked in the repository. If you need to capture a
test run to a file, write it somewhere ignored rather than to the repository root.

## Security

Never commit secrets or credentials. Local storage is encrypted by the app. To
report a vulnerability, see [SECURITY.md](SECURITY.md).
