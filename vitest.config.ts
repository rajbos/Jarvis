import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        // Renderer and main entry points require Electron runtime
        'src/renderer/**',
        'src/main/**',
        // IPC handler files require Electron's ipcMain — not unit-testable
        'src/plugins/*/handler.ts',
        // Agent runner uses ipcMain and requires the full Electron environment
        'src/plugins/agents/runner.ts',
        // Pure type declarations — no executable code
        'src/plugins/types.ts',
        // Ollama service requires an external Ollama process
        'src/services/ollama.ts',
        // Database module uses better-sqlite3 (filesystem); tested via schema + in-memory sql.js
        'src/storage/database.ts',
        // Pure type declaration files
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
