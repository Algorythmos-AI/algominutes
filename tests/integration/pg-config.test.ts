import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import pg from 'pg';

// The shared config against a real server: the readiness probe succeeds on a
// reachable database and fails fast (bounded) on an unreachable one.
const { buildPgConfig, pingPool } = createRequire(import.meta.url)('@algominutes/ai/pg-config.cjs');

const live = new pg.Pool(buildPgConfig({ max: 1 }));
// 10.255.255.1 is non-routable: the connect hangs, so only the timeout ends it.
const dead = new pg.Pool({ ...buildPgConfig({ max: 1 }, { PGHOST: '10.255.255.1', PGSSLMODE: 'disable' }), connectionTimeoutMillis: 60_000 });

afterAll(async () => {
  await live.end();
  await dead.end().catch((err: Error) => expect(err).toBeInstanceOf(Error));
});

describe('pingPool', () => {
  it('resolves against a reachable Postgres', async () => {
    await expect(pingPool(live, 2000)).resolves.toBeUndefined();
  });

  it('rejects within its timeout when Postgres is unreachable, never hangs', async () => {
    const started = Date.now();
    await expect(pingPool(dead, 500)).rejects.toThrow(/timed out after 500ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
