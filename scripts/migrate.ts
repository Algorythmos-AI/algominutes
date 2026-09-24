#!/usr/bin/env tsx
/**
 * Apply Postgres migrations from a machine with database access (local dev,
 * the integration harness, or over the Cloud SQL Auth Proxy). Deploys do NOT
 * use this: they run the db-job `migrate` handler inside the VPC before
 * rolling out services (.github/workflows/deploy-staging.yml). Both call the
 * same runner, packages/db/src/migrator.ts.
 *
 *   DATABASE_URL=postgres://... npm run migrate
 *
 * Optional: EXPECTED_MIGRATION_HEAD (fail unless the newest file matches),
 * TRACE_ID (correlate with a deploy), MIGRATION_LOCK_TIMEOUT_MS.
 */
import { randomUUID } from 'node:crypto';
import { runMigrations, type MigrateLogger } from '@algominutes/db/migrator';
import loggerModule from '../packages/ai/src/logger.cjs';

const log = (loggerModule as { logger: { child: (f: Record<string, unknown>) => MigrateLogger } }).logger.child({
  service: 'migrate',
  traceId: process.env.TRACE_ID || randomUUID(),
});

if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  log.error({}, 'migrate_no_database_target');
  process.exit(64);
}

runMigrations({
  log,
  expectedHead: process.env.EXPECTED_MIGRATION_HEAD || undefined,
  lockTimeoutMs: process.env.MIGRATION_LOCK_TIMEOUT_MS ? Number(process.env.MIGRATION_LOCK_TIMEOUT_MS) : undefined,
}).catch((err) => {
  log.error({ err }, 'migrate_failed');
  process.exit(1);
});
