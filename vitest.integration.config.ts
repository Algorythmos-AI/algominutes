import { defineConfig } from 'vitest/config';

// Integration tests against a REAL Postgres 16 + pgvector (never mocked).
// Needs DATABASE_URL; the global setup applies every migration first.
//   CI:     .github/workflows/ci.yml `integration` job (pgvector/pgvector:pg16 service)
//   Local:  DATABASE_URL=postgres://postgres@127.0.0.1:55432/algominutes npm run test:integration
// Files run serially: they share one database and reset it between tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    // The repo layer is a no-op unless this is 'true' (packages/db/src/db.ts).
    env: { WRITE_POSTGRES: 'true' },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
