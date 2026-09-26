import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pool } from './helpers';

const MIGRATIONS = readdirSync(resolve(__dirname, '../../packages/db/migrations'))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

afterAll(() => pool.end());

describe('migrations on a real Postgres 16', () => {
  it('records every numbered migration exactly once', async () => {
    const { rows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toEqual(MIGRATIONS);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const out = execFileSync('npx', ['tsx', join('scripts', 'migrate.ts')], { env: process.env }).toString();
    const events = out.trim().split('\n').map((l) => JSON.parse(l) as { msg: string; applied?: string[] });
    expect(events.filter((e) => e.msg === 'migration_applied')).toEqual([]);
    expect(events.find((e) => e.msg === 'migrate_at_head')?.applied).toEqual([]);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBe(MIGRATIONS.length);
  });

  it('installs the extensions the schema depends on', async () => {
    const { rows } = await pool.query<{ extname: string }>('SELECT extname FROM pg_extension');
    const names = rows.map((r) => r.extname);
    for (const ext of ['vector', 'pg_trgm', 'uuid-ossp']) expect(names).toContain(ext);
  });
});
