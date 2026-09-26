import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, count, quietLog } from './helpers';

// Internal testers get minutes through a manual grant (migration 019). Without
// one, a user on the free floor (FREE_FLOOR_MINUTES unset = 0) is refused
// every metered action, which is what a TestFlight build with no trial hit.
const {
  getPool, resolveEntitlement, assertCanMeter, grantEntitlement, revokeEntitlement, deleteAccountData,
  currentBillingPeriod, ensureTrial,
} = repo;
const require = createRequire(import.meta.url);
const grantTester = require('../../services/db-job/src/handlers/grant-tester.js');

const DAY = 24 * 60 * 60 * 1000;
const debit = (uid: string, minutes: number) =>
  pool.query(
    `INSERT INTO usage_ledger (uid, entry_type, minutes, billing_period, reason, idempotency_key)
       VALUES ($1, 'debit', $2, $3, 'ingest', $4)`,
    [uid, minutes, currentBillingPeriod(), `${uid}:${minutes}:${Math.random()}`],
  );

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  // What a TestFlight build's first kickoff does: iOS with no DeviceCheck token
  // gets no trial, so the user opens on the free floor.
  await ensureTrial('alice', { platform: 'ios' });
  await ensureTrial('bob', { platform: 'ios' });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('entitlement grants', () => {
  it('without a grant, a user on the free floor is refused (the 402 testers hit)', async () => {
    expect(await resolveEntitlement('alice')).toMatchObject({ state: 'free_floor', includedMinutes: 0 });
    await expect(assertCanMeter('alice', 5)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it("a live grant is Pro: active, Pro's minutes, and a 3 h recording passes", async () => {
    expect(await grantEntitlement({ email: 'ALICE@test.invalid', reason: 'internal_tester' })).toBe('alice');
    expect(await resolveEntitlement('alice')).toMatchObject({
      state: 'active', plan: 'pro', includedMinutes: 1500, overQuota: false, trialEndsAt: null,
    });
    await expect(assertCanMeter('alice', 180)).resolves.toMatchObject({ state: 'active' });
  });

  it("one user's grant never covers another", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester' });
    await expect(assertCanMeter('bob', 5)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('an expired grant counts for nothing', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester', expiresAt: new Date(Date.now() - DAY) });
    expect(await resolveEntitlement('alice')).toMatchObject({ state: 'free_floor' });
  });

  it('usage counts against the granted minutes, and an override replaces the default', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester', includedMinutes: 200 });
    await debit('alice', 150);
    expect(await resolveEntitlement('alice')).toMatchObject({ includedMinutes: 200, usedMinutes: 150 });
    await expect(assertCanMeter('alice', 60)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(assertCanMeter('alice', 50)).resolves.toBeTruthy();
  });

  it('a real paid subscription wins over a grant', async () => {
    await pool.query(`UPDATE subscriptions SET plan = 'pro', current_period_end = NOW() + INTERVAL '20 days' WHERE uid = 'alice'`);
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester', includedMinutes: 200 });
    expect(await resolveEntitlement('alice')).toMatchObject({ state: 'active', plan: 'pro', includedMinutes: 1500 });
  });

  it('only Pro can be granted (team is unmetered), and minutes must be a positive integer', async () => {
    await expect(grantEntitlement({ uid: 'alice', plan: 'team', reason: 'x' })).rejects.toThrow(/can't be granted/);
    await expect(grantEntitlement({ uid: 'alice', includedMinutes: 0, reason: 'x' })).rejects.toThrow(/positive integer/);
    expect(await count(`SELECT 1 FROM entitlement_grants`)).toBe(0);
  });

  it('a user who never signed in, or an ambiguous email, is refused', async () => {
    await expect(grantEntitlement({ email: 'nobody@test.invalid', reason: 'x' })).rejects.toMatchObject({ code: 'GRANT_USER_NOT_FOUND' });
    await expect(grantEntitlement({ uid: 'ghost', reason: 'x' })).rejects.toMatchObject({ code: 'GRANT_USER_NOT_FOUND' });
    await pool.query(`INSERT INTO users (uid, email) VALUES ('alice2', 'Alice@test.invalid')`);
    await expect(grantEntitlement({ email: 'alice@test.invalid', reason: 'x' })).rejects.toMatchObject({ code: 'GRANT_USER_NOT_FOUND' });
  });

  it('revoking ends it, and deleting the account removes the grant', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester' });
    expect(await revokeEntitlement({ uid: 'alice' })).toEqual({ uid: 'alice', revoked: true });
    expect(await resolveEntitlement('alice')).toMatchObject({ state: 'free_floor' });
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester' });
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await count(`SELECT 1 FROM entitlement_grants`)).toBe(0);
  });
});

describe('db-job grant-tester', () => {
  const lines: Array<[Record<string, unknown>, string]> = [];
  const log = { info: (o: Record<string, unknown>, m: string) => void lines.push([o, m]), error: () => {} };

  it('grants for 90 days by default, logging the uid and never the email', async () => {
    lines.length = 0;
    const now = new Date('2026-09-25T00:00:00Z');
    const r = await grantTester.run({ log, repo, env: { GRANT_EMAIL: 'alice@test.invalid' }, now });
    expect(r).toEqual({ uid: 'alice', expiresAt: new Date(now.getTime() + 90 * DAY) });
    expect(lines).toEqual([[expect.objectContaining({ userId: 'alice', plan: 'pro' }), 'entitlement_granted']]);
    expect(JSON.stringify(lines)).not.toContain('test.invalid');
  });

  it('GRANT_DAYS=0 never expires, MODE=revoke removes it, and no target is an error', async () => {
    await grantTester.run({ log, repo, env: { GRANT_UID: 'bob', GRANT_DAYS: '0' } });
    expect((await pool.query(`SELECT expires_at FROM entitlement_grants WHERE uid = 'bob'`)).rows).toEqual([{ expires_at: null }]);
    lines.length = 0;
    expect(await grantTester.run({ log, repo, env: { GRANT_UID: 'bob', MODE: 'revoke' } })).toEqual({ uid: 'bob', revoked: true });
    expect(lines).toEqual([[{ userId: 'bob', revoked: true }, 'entitlement_grant_revoked']]);
    await expect(grantTester.run({ log, repo, env: {} })).rejects.toThrow(/GRANT_EMAIL or GRANT_UID/);
    await expect(grantTester.run({ log, repo, env: { GRANT_UID: 'bob', GRANT_DAYS: '-1' } })).rejects.toThrow(/GRANT_DAYS/);
    // A blank GRANT_DAYS is the default, not "never expires".
    const now = new Date('2026-09-25T00:00:00Z');
    expect(await grantTester.run({ log, repo, env: { GRANT_UID: 'bob', GRANT_DAYS: ' ' }, now }))
      .toEqual({ uid: 'bob', expiresAt: new Date(now.getTime() + 90 * DAY) });
  });

  it('the table refuses a non-Pro or non-positive grant, even inserted by hand', async () => {
    await expect(pool.query(`INSERT INTO entitlement_grants (uid, plan, reason) VALUES ('alice', 'team', 'x')`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO entitlement_grants (uid, plan, included_minutes, reason) VALUES ('alice', 'pro', 0, 'x')`)).rejects.toMatchObject({ code: '23514' });
  });
});
