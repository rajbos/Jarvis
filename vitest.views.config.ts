import { defineConfig } from 'vitest/config';

// Headless-browser integration tests for the renderer views (tests/views).
// Kept separate from the unit suite because they bundle the renderer and drive
// a real Chromium, which is slower and needs a browser installed.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/views/**/*.view.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
