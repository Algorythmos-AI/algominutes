import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations, listMigrations, type MigrateLogger } from '@algominutes/db/migrator';
import { pool } from './helpers';

// The runner the deploy pipeline uses (db-job `migrate`) — each safety property
// proven on a throwaway database so the shared harness schema is never touched.
const { buildPgConfig } = createRequire(import.meta.url)('@algominutes/ai/pg-config.cjs');

const events: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
const log: MigrateLogger = {
  info: (obj, msg) => events.push({ msg, obj }),
  warn: (obj, msg) => events.push({ msg, obj }),
  error: (obj, msg) => events.push({ msg, obj }),
};

let dbName: string;
let dbConfig: pg.PoolConfig;
let db: pg.Pool;
let dir: string;

function configFor(name: string): pg.PoolConfig {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return buildPgConfig({ max: 2 }, { ...process.env, DATABASE_URL: url.toString() });
}

beforeEach(async () => {
  dbName = `mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await pool.query(`CREATE DATABASE ${dbName}`);
  dbConfig = configFor(dbName);
  db = new pg.Pool(dbConfig);
  dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  events.length = 0;
});

afterEach(async () => {
  await db.end();
  await pool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => pool.end());

const recorded = async () =>
  (await db.query<{ filename: string; checksum: string | null }>('SELECT filename, checksum FROM schema_migrations ORDER BY filename')).rows;

describe('migrator (db-job migrate) on a real Postgres 16', () => {
  it('serializes overlapping runs: every file applied exactly once', async () => {
    const [a, b] = await Promise.all([
      runMigrations({ log, pgConfig: dbConfig }),
      runMigrations({ log, pgConfig: dbConfig }),
    ]);
    const all = listMigrations().map((f) => f.filename);
    // One runner did the work; the other waited on the advisory lock and found nothing.
    expect([...a.applied, ...b.applied].sort()).toEqual(all);
    expect([a.applied.length, b.applied.length].sort((x, y) => x - y)).toEqual([0, all.length]);
    const rows = await recorded();
    expect(rows.map((r) => r.filename)).toEqual(all);
    expect(rows.every((r) => r.checksum && r.checksum.length === 64)).toBe(true);
  });

  it('rolls back the file AND its bookkeeping row when a migration fails (even with its own BEGIN/COMMIT)', async () => {
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE t_ok (id int);');
    writeFileSync(join(dir, '002_bad.sql'), 'BEGIN;\nCREATE TABLE t_half (id int);\nSELECT 1/0;\nCOMMIT;');
    await expect(runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir })).rejects.toThrow(/division by zero/);
    expect((await recorded()).map((r) => r.filename)).toEqual(['001_ok.sql']);
    const { rows } = await db.query(`SELECT to_regclass('t_half') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('fails a run whose applied migration was edited on disk, before applying anything new', async () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE t_a (id int);');
    await runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir });
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE t_a (id bigint);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE t_b (id int);');
    await expect(runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir })).rejects.toThrow(
      /changed on disk: 001_a\.sql/,
    );
    expect((await recorded()).map((r) => r.filename)).toEqual(['001_a.sql']);
  });

  it('backfills checksums for history recorded before checksums existed', async () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE t_a (id int);');
    await runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir });
    await db.query('UPDATE schema_migrations SET checksum = NULL');
    const res = await runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir });
    expect(res.checksumsBackfilled).toBe(1);
    expect((await recorded())[0]!.checksum).toHaveLength(64);
  });

  it('refuses a head mismatch without touching the database', async () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE t_a (id int);');
    await expect(
      runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir, expectedHead: '002_newer.sql' }),
    ).rejects.toThrow(/head mismatch: this image ships 001_a\.sql, the deploy expects 002_newer\.sql/);
    const { rows } = await db.query(`SELECT to_regclass('schema_migrations') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('fails fast instead of queueing DDL behind a live lock (no outage, nothing recorded)', async () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE t_a (id int);');
    await runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir });
    writeFileSync(join(dir, '002_alter.sql'), 'ALTER TABLE t_a ADD COLUMN extra text;');

    // A long-running reader holds a lock the ALTER must wait for.
    const holder = await db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE t_a IN ACCESS SHARE MODE');
      const started = Date.now();
      await expect(
        runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir, lockTimeoutMs: 300 }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await recorded()).map((r) => r.filename)).toEqual(['001_a.sql']);
    // …and a retry once the lock is gone succeeds.
    const retry = await runMigrations({ log, pgConfig: dbConfig, migrationsDir: dir });
    expect(retry.applied).toEqual(['002_alter.sql']);
  });
});
