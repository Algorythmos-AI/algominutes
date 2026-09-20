import { defineConfig } from 'vitest/config';

// Root vitest config for the monorepo's fast, no-network, no-DB unit tests.
// Node environment; picks up *.test.ts across tests/, packages/, and services/.
// The two existing node:test .mjs suites (transcoder providers, diarisation DER)
// run separately via `npm run test:node` — they use the node:test runner.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'services/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
    passWithNoTests: false,
  },
});
