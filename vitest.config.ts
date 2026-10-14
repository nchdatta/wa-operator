import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    // Never touch the real Credential Manager / Keychain / keyring from tests.
    env: { WAOP_DISABLE_CREDMAN: '1' },
  },
});
