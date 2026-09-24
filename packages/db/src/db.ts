/**
 * Postgres connection pool + helpers shared by the dev server, Cloud
 * Functions, and the Cloud Run worker services. The pool is lazily
 * constructed so importing this module is free when the WRITE_POSTGRES
 * flag is off.
 *
 * Environment variables (read at first connect):
 *   DATABASE_URL                  — full Postgres URI (preferred)
 *   PGHOST, PGPORT, PGDATABASE,
 *   PGUSER, PGPASSWORD            — discrete fields if URL is absent
 *   WRITE_POSTGRES                — 'true' to enable dual-write paths
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import loggerModule from '@algominutes/ai/logger.cjs';
import pgConfigModule from '@algominutes/ai/pg-config.cjs';

// Structured logger (CLAUDE.md §1 Logging) — never console.*.
const log = (loggerModule as { logger: { error: (o: unknown, m?: string) => void } }).logger;

// The single connection config shared by every pool (TLS policy lives there).
const { buildPgConfig, attachPoolErrorLogger } = pgConfigModule as {
  buildPgConfig: (opts?: { max?: number }) => PoolConfig;
  attachPoolErrorLogger: (pool: Pool, logger: typeof log, fields?: Record<string, unknown>) => Pool;
};

let pool: Pool | null = null;

export function isPostgresEnabled(): boolean {
  return String(process.env.WRITE_POSTGRES || '').toLowerCase() === 'true';
}

export function getPool(): Pool {
  if (!pool) {
    pool = attachPoolErrorLogger(new Pool(buildPgConfig({ max: 8 })), log, { pool: 'repo' });
  }
  return pool;
}

/** Run `fn` in a transaction; auto-rollback on throw. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client
      .query('ROLLBACK')
      .catch((rollbackErr) => log.error({ err: rollbackErr }, 'pg_rollback_failed'));
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience for fire-and-forget queries from callers that don't want a client. */
export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }> {
  const res = await getPool().query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount };
}
