import { defineConfig } from 'vitest/config';

// `npm run screenshots`: renders every window / tab headless from the view-test
// fixtures and writes PNGs (tests/views/screenshots.ts). Separate from
// vitest.views.config.ts so the screenshot run is opt-in and never part of CI's
// `npm run test:views`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/views/screenshots.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One harness (bundle + browser) per file; the shots run sequentially inside it.
    fileParallelism: false,
  },
});
