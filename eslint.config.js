import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'drizzle/**', 'node_modules/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Operator code talks to the owner only through the channel interface.
    files: ['src/operator/**/*.ts', 'src/approvals/**/*.ts', 'src/inbound.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/meta/**', '**/channels/whatsapp.js', '**/channels/telegram.js'], message: 'Use the Channel interface.' }] },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['src/bin/cli.ts', 'src/bin/uninstall.ts'],
    rules: { 'no-console': 'off' },
  },
);
