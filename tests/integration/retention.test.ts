import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool } from '@algominutes/db';
// @ts-expect-error: plain ESM route module, no type declarations
import { getRetentionRoute, setRetentionRoute } from '../../services/api/src/routes/compliance.js';
import { pool, resetDb, seedUser } from './helpers';

// The account's retention (RELEASE.md PR 12b): read back on every device, and
// each account's own. (The auth middleware makes a new user's row, and refuses
// a deleted account, before any route: tests/integration/first-writes.test.ts.)
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function call(route: (req: any, res: any) => Promise<unknown>, uid: string, body?: unknown) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
  const noop = () => {};
  await route({ uid, ip: '203.0.113.9', body, log: { warn: noop, info: noop, error: noop } }, res);
  return out;
}

describe("the account's retention", () => {
  it('reads back what was set, and null for keep-until-deleted', async () => {
    await seedUser('u1');
    expect(await call(getRetentionRoute, 'u1')).toEqual({ status: 200, body: { retentionDays: null } });
    expect((await call(setRetentionRoute, 'u1', { retentionDays: 30 })).status).toBe(200);
    expect(await call(getRetentionRoute, 'u1')).toEqual({ status: 200, body: { retentionDays: 30 } });
    expect((await call(setRetentionRoute, 'u1', { retentionDays: null })).status).toBe(200);
    expect(await call(getRetentionRoute, 'u1')).toEqual({ status: 200, body: { retentionDays: null } });
  });

  it("each account reads only its own", async () => {
    await seedUser('u1');
    await seedUser('u2');
    await call(setRetentionRoute, 'u2', { retentionDays: 90 });
    expect((await call(getRetentionRoute, 'u1')).body).toEqual({ retentionDays: null });
    expect((await call(getRetentionRoute, 'u2')).body).toEqual({ retentionDays: 90 });
  });
});
