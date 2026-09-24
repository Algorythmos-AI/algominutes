import { execFileSync } from 'node:child_process';

// Apply every migration (packages/db/migrations) to the test database once,
// through the same runner production uses — so a migration that breaks on a
// real Postgres fails here, not at deploy.
export default function setup(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for integration tests (Postgres 16 + pgvector). ' +
        'See vitest.integration.config.ts.',
    );
  }
  execFileSync('npx', ['tsx', 'scripts/migrate.ts'], { stdio: 'inherit', env: process.env });
}
