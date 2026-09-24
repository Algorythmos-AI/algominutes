#!/usr/bin/env tsx
/**
 * Forward-only Postgres migration runner. Reads files from
 * db/migrations/*.sql in lexical order and applies any that are not
 * already recorded in the schema_migrations table.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run db:migrate
 *
 * Idempotent. Safe to run multiple times. Each migration runs in a
 * single transaction (the file may include its own BEGIN/COMMIT, but
 * the runner wraps the whole apply in one as well to keep
 * schema_migrations consistent).
 */
import { Pool, type PoolConfig } from 'pg';
import pgConfigModule from '../packages/ai/src/pg-config.cjs';

const pgConfig = pgConfigModule as { buildPgConfig: (opts?: { max?: number }) => PoolConfig };
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'packages', 'db', 'migrations');

async function ensureExtensions(pool: Pool) {
  // These require superuser on Cloud SQL — bootstrap them once via
  // `gcloud sql import sql` against db/migrations/000_extensions.sql.
  // The app user lacks CREATE privilege so this is best-effort: if it
  // fails, we assume the bootstrap import already ran and continue.
  for (const ext of ['vector', 'pg_trgm', '"uuid-ossp"']) {
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    } catch (err) {
      // Only a genuine privilege error is expected (the app role on Cloud SQL
      // cannot CREATE EXTENSION; 000_extensions.sql is bootstrapped by a
      // privileged role). Anything else — e.g. connection refused — is real.
      if ((err as { code?: string }).code !== '42501') throw err;
      console.log(`SKIP   extension ${ext} (lacks CREATE privilege; expected for app role)`);
    }
  }
}

async function ensureMigrationsTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedSet(pool: Pool): Promise<Set<string>> {
  const res = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(res.rows.map((r) => r.filename));
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE before running migrations.');
  }
  // Same connection config (TLS policy) as every service pool.
  const pool = new Pool(pgConfig.buildPgConfig({ max: 2 }));
  try {
    await ensureExtensions(pool);
    await ensureMigrationsTable(pool);
    const applied = await appliedSet(pool);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`SKIP   ${filename}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf-8');
      console.log(`APPLY  ${filename}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr) => console.error('ROLLBACK failed:', rollbackErr));
        throw err;
      } finally {
        client.release();
      }
    }
    console.log('Migrations up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
