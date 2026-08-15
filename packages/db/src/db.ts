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

let pool: Pool | null = null;

export function isPostgresEnabled(): boolean {
  return String(process.env.WRITE_POSTGRES || '').toLowerCase() === 'true';
}

function buildConfig(): PoolConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, max: 8, idleTimeoutMillis: 30_000 };
  }
  return {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE || 'algominutes',
    user: process.env.PGUSER || 'app',
    password: process.env.PGPASSWORD,
    max: 8,
    idleTimeoutMillis: 30_000,
  };
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildConfig());
    pool.on('error', (err) => {
      // Don't crash the process on a stale idle client; pg-pool reconnects.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ severity: 'ERROR', msg: 'pg_pool_error', err: { message: err.message } }));
    });
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
    await client.query('ROLLBACK').catch(() => undefined);
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
