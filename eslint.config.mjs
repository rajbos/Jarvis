// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Files to lint
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Downgrade to warnings for rules that are noisy during early development
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Guard against blank-line bloat (see issue #344)
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
    },
  },
  {
    // Main-process / non-UI code must log via the shared logger (src/services/logger.ts)
    // so setLogLevel() can gate verbosity in packaged builds. Renderer/.tsx code runs in
    // the browser context and is intentionally excluded — it has no access to Electron's
    // packaged/dev distinction and console.* is the normal browser debugging surface there.
    files: [
      'src/main/**/*.ts',
      'src/services/**/*.ts',
      'src/storage/**/*.ts',
      'src/plugins/**/*.ts',
      'src/mcp-server/**/*.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // logger.ts is the one file allowed to call console.* directly — it's the wrapper.
    files: ['src/services/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // IPC handlers must register via safeHandle() (src/plugins/ipc-utils.ts) so error
    // handling (logging + the { ok: false, error } shape) lives in one place.
    files: ['src/**/*.ts'],
    ignores: ['src/plugins/ipc-utils.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='handle']",
          message: 'Register IPC handlers with safeHandle() from src/plugins/ipc-utils.ts instead of calling ipcMain.handle() directly.',
        },
      ],
    },
  },
  {
    // Icon-only buttons (a single glyph/emoji/entity as the only child) need an accessible
    // name: `title` alone is not reliably exposed to screen readers. Use aria-label, or the
    // shared <IconButton> (src/plugins/shared/IconButton.tsx). Scoped to .tsx so it does not
    // clash with the ipcMain rule above, which applies to .ts files only.
    files: ['src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXElement[openingElement.name.name='button'][children.length=1][children.0.type='JSXText'][children.0.value=/^\\s*[^A-Za-z0-9\\s]{1,4}\\s*$/]:not(:has(JSXAttribute[name.name=/^aria-label(ledby)?$/]))",
          message: 'Icon-only <button> needs aria-label (or aria-labelledby). Prefer <IconButton> from src/plugins/shared/IconButton.tsx.',
        },
      ],
    },
  },
  {
    // Ignore build output and test compiled output and browser extension plain JS
    ignores: ['dist/**', 'node_modules/**', 'tests/**', 'src/browser-extension/**'],
  },
);
