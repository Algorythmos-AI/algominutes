import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// One connection config for every Postgres pool. The TLS policy is the part
// that must never silently downgrade to plaintext against Cloud SQL.
const require = createRequire(import.meta.url);
const { buildPgConfig, resolveSsl, attachPoolErrorLogger } = require('@algominutes/ai/pg-config.cjs') as typeof import('../packages/ai/src/pg-config.cjs');

const ENCRYPTED = { rejectUnauthorized: false };

describe('resolveSsl', () => {
  it('encrypts by default for a remote host (Cloud SQL private IP)', () => {
    expect(resolveSsl({ PGHOST: '10.20.0.3' })).toEqual(ENCRYPTED);
    expect(resolveSsl({ DATABASE_URL: 'postgres://u:p@10.20.0.3:5432/algominutes' })).toEqual(ENCRYPTED);
  });

  it('stays plaintext for a local dev / CI server', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '/tmp']) expect(resolveSsl({ PGHOST: host })).toBe(false);
    expect(resolveSsl({ DATABASE_URL: 'postgres://postgres@127.0.0.1:55432/algominutes' })).toBe(false);
  });

  it('honours an explicit PGSSLMODE either way', () => {
    expect(resolveSsl({ PGHOST: '10.20.0.3', PGSSLMODE: 'disable' })).toBe(false);
    expect(resolveSsl({ PGHOST: 'localhost', PGSSLMODE: 'require' })).toEqual(ENCRYPTED);
    expect(resolveSsl({ PGHOST: 'localhost', PGSSLMODE: 'verify-full' })).toEqual(ENCRYPTED);
  });

  it('refuses a malformed DATABASE_URL rather than guessing plaintext', () => {
    expect(() => resolveSsl({ DATABASE_URL: 'not a url' })).toThrow(/not a valid URL/);
  });
});

describe('buildPgConfig', () => {
  it('uses discrete PG* fields, defaulting the database to algominutes', () => {
    const cfg = buildPgConfig({ max: 8 }, { PGHOST: '10.20.0.3', PGUSER: 'app', PGPASSWORD: 'x' });
    expect(cfg).toMatchObject({ host: '10.20.0.3', port: 5432, database: 'algominutes', user: 'app', max: 8, ssl: ENCRYPTED });
  });

  it('strips sslmode from DATABASE_URL so it cannot override the policy', () => {
    const cfg = buildPgConfig({}, { DATABASE_URL: 'postgres://u:p@10.20.0.3:5432/algominutes?sslmode=disable', PGSSLMODE: 'require' });
    expect(cfg.connectionString).not.toMatch(/sslmode/);
    expect(cfg.ssl).toEqual(ENCRYPTED);
  });
});

describe('attachPoolErrorLogger', () => {
  it('logs an idle-client error instead of swallowing it', () => {
    const handlers: Record<string, (e: Error) => void> = {};
    const pool = { on: (ev: string, fn: (e: Error) => void) => void (handlers[ev] = fn) };
    const logged: Array<{ obj: unknown; msg: string }> = [];
    attachPoolErrorLogger(pool as never, { error: (obj: unknown, msg: string) => logged.push({ obj, msg }) }, { pool: 'repo' });
    handlers.error!(new Error('terminating connection due to administrator command'));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toBe('pg_pool_idle_client_error');
    expect(logged[0]!.obj).toMatchObject({ pool: 'repo' });
  });
});
