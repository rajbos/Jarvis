import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Keep the suite away from the real %APPDATA%\Jarvis: without these, code that
    // needs an encryption key writes keystore.fallback.bin next to the user's
    // real database (and parallel workers race to create it). Tests that probe
    // the key lookup or config directory set their own values.
    env: {
      JARVIS_ENCRYPTION_KEY: 'vitest-only-encryption-key',
      JARVIS_CONFIG_DIR: path.join(os.tmpdir(), 'jarvis-vitest-config'),
    },
    include: ['tests/**/*.test.ts'],
    // Headless-browser view tests run separately via `npm run test:views`.
    exclude: ['tests/views/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        // Renderer and executable entry points require their host runtime
        'src/renderer/**',
        'src/main/**',
        'src/mcp-server/index.ts',
        // IPC handler files require Electron's ipcMain — not unit-testable
        'src/plugins/*/handler.ts',
        // Pure type declarations — no executable code
        'src/plugins/types.ts',
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
