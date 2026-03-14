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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Ignore build output and test compiled output
    ignores: ['dist/**', 'node_modules/**', 'tests/**'],
  },
);
