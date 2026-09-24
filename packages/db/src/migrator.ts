/**
 * The one Postgres migration runner. `scripts/migrate.ts` (local dev + the
 * integration harness) and the db-job `migrate` handler (the deploy pipeline,
 * inside the VPC) both call runMigrations(), so what the harness proves on a
 * real Postgres is exactly what a deploy runs against Cloud SQL.
 *
 * Forward-only: packages/db/migrations/NNN_*.sql in lexical order, each applied
 * at most once and recorded in schema_migrations with its sha256.
 *
 * Safety properties (each covered by tests/integration/migrator.test.ts):
 *   - Serialized. A session advisory lock means two overlapping deploys cannot
 *     interleave; the second waits, then finds nothing to do.
 *   - Atomic bookkeeping. The schema_migrations row is written in the same
 *     transaction as the file's DDL, even for files that carry their own
 *     BEGIN/COMMIT (the house convention for 001-006): a failure before that
 *     COMMIT rolls back both, so a file is never half-applied yet recorded,
 *     nor applied yet unrecorded (which a re-run would apply twice).
 *   - Bounded lock waits. lock_timeout caps how long DDL may queue behind live
 *     traffic: an ALTER waiting for ACCESS EXCLUSIVE blocks every later query
 *     on that table, which is an outage. Failing fast and retrying is not.
 *   - Drift detection. An applied file whose bytes changed fails the run
 *     (never edit a committed migration, CLAUDE.md §6). Rows recorded before
 *     checksums existed are backfilled once.
 *   - Head check. With expectedHead set, the run fails unless the newest
 *     migration shipped in this image is the one the deploying commit expects,
 *     and every migration on disk is recorded afterwards.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgConfigModule from '@algominutes/ai/pg-config.cjs';

const { buildPgConfig, attachPoolErrorLogger } = pgConfigModule as {
  buildPgConfig: (opts?: { max?: number }) => PoolConfig;
  attachPoolErrorLogger: (pool: Pool, logger: MigrateLogger, fields?: Record<string, unknown>) => Pool;
};

export interface MigrateLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  log: MigrateLogger;
  migrationsDir?: string;
  /** Newest migration filename the deploying commit ships; mismatch fails the run. */
  expectedHead?: string;
  /** How long DDL may wait for a table lock before failing (ms). */
  lockTimeoutMs?: number;
  /** How long to wait for another runner's advisory lock (ms). */
  advisoryLockTimeoutMs?: number;
  /** Connection override (tests target throwaway databases); default: the shared config. */
  pgConfig?: PoolConfig;
}

export interface MigrateResult {
  head: string;
  applied: string[];
  alreadyApplied: number;
  checksumsBackfilled: number;
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Arbitrary but fixed: every runner, in every service image, contends on this key.
const ADVISORY_LOCK_KEY = 72_140_901;

// Numbered migrations only. seed-*.sql / retire-*.sql are operator tools that are
// deliberately re-runnable and are not schema history.
const MIGRATION_FILE = /^\d{3}_[\w.-]+\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function listMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(dir, filename), 'utf-8');
      return { filename, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function ensureExtensions(client: PoolClient, log: MigrateLogger): Promise<void> {
  // Cloud SQL's built-in users can create these; a role without the privilege
  // relies on 000_extensions.sql having been bootstrapped by one that has it.
  for (const ext of ['vector', 'pg_trgm', '"uuid-ossp"']) {
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    } catch (err) {
      // Only a genuine privilege error is expected; anything else is real.
      if ((err as { code?: string }).code !== '42501') throw err;
      log.warn({ extension: ext }, 'migrate_extension_skipped_no_privilege');
    }
  }
}

async function readApplied(client: PoolClient): Promise<Map<string, string | null>> {
  const { rows } = await client.query<{ filename: string; checksum: string | null }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

export async function runMigrations(opts: MigrateOptions): Promise<MigrateResult> {
  const { log } = opts;
  const files = listMigrations(opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const head = files.at(-1)?.filename;
  if (!head) throw new MigrationError('no migrations found on disk');
  if (opts.expectedHead && opts.expectedHead !== head) {
    // The image is older (or newer) than the commit being deployed. Rolling
    // out services against a schema they don't expect is how a column-missing
    // 500 reaches users; stop before touching the database.
    throw new MigrationError(
      `migration head mismatch: this image ships ${head}, the deploy expects ${opts.expectedHead} ` +
        '(rebuild db-job at the deploying commit)',
    );
  }

  const pool = attachPoolErrorLogger(new Pool({ ...(opts.pgConfig ?? buildPgConfig()), max: 1 }), log, { pool: 'migrate' });
  const client = await pool.connect();
  const result: MigrateResult = { head, applied: [], alreadyApplied: 0, checksumsBackfilled: 0 };
  let locked = false;
  try {
    await client.query(`SET lock_timeout = ${Math.trunc(opts.advisoryLockTimeoutMs ?? 300_000)}`);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    locked = true;
    await client.query(`SET lock_timeout = ${Math.trunc(opts.lockTimeoutMs ?? 15_000)}`);

    log.info({ head, onDisk: files.length }, 'migrate_started');
    await ensureExtensions(client, log);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

    const applied = await readApplied(client);

    // Drift first, before applying anything new on top of a history that lies.
    const drifted = files.filter((f) => {
      const recorded = applied.get(f.filename);
      return recorded != null && recorded !== f.checksum;
    });
    if (drifted.length) {
      throw new MigrationError(
        `applied migration(s) changed on disk: ${drifted.map((f) => f.filename).join(', ')} ` +
          '(never edit a committed migration; add a new one)',
      );
    }

    for (const file of files) {
      if (applied.has(file.filename)) {
        result.alreadyApplied += 1;
        if (applied.get(file.filename) == null) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE filename = $1', [
            file.filename,
            file.checksum,
          ]);
          result.checksumsBackfilled += 1;
        }
        continue;
      }
      const startMs = Date.now();
      await client.query('BEGIN');
      try {
        // Bookkeeping row first: a file with its own BEGIN/COMMIT then commits
        // it together with its DDL, and a failure before that rolls both back.
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file.filename,
          file.checksum,
        ]);
        await client.query(file.sql);
        await client.query('COMMIT');
      } catch (err) {
        log.error({ err, filename: file.filename, wallMs: Date.now() - startMs }, 'migration_failed');
        await client
          .query('ROLLBACK')
          .catch((rollbackErr) => log.error({ err: rollbackErr, filename: file.filename }, 'migrate_rollback_failed'));
        throw err;
      }
      result.applied.push(file.filename);
      log.info({ filename: file.filename, wallMs: Date.now() - startMs }, 'migration_applied');
    }

    // Prove the end state from the database, not from the loop above.
    const after = await readApplied(client);
    const missing = files.filter((f) => !after.has(f.filename)).map((f) => f.filename);
    if (missing.length) {
      throw new MigrationError(`migrations on disk but not recorded after the run: ${missing.join(', ')}`);
    }
    log.info(
      {
        head,
        applied: result.applied,
        alreadyApplied: result.alreadyApplied,
        checksumsBackfilled: result.checksumsBackfilled,
      },
      'migrate_at_head',
    );
    return result;
  } finally {
    if (locked) {
      await client
        .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
        .catch((err) => log.error({ err }, 'migrate_advisory_unlock_failed'));
    }
    client.release();
    await pool.end();
  }
}
