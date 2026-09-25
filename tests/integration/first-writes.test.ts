import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  getPool, deleteAccountData, recordTermsAcceptance, registerPushToken, trackEvent,
  createSupportRequest, setRetentionDays, getRetentionDays, admitUser,
} from '@algominutes/db';
import { pool, resetDb, count, quietLog } from './helpers';

// A brand-new user's first requests are onboarding (accept the terms, register
// for push, send analytics), long before their first upload. Only the upload
// and kickoff paths used to create the users row, so every one of these failed
// its foreign key (23503), and the retention choice silently saved nothing.
// The auth middleware now admits the caller: it ensures the row (claims from
// the token) the first time an instance sees the uid, and refuses a deleted
// account as before.
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: async (t: string) => (t === 'anon' ? { uid: 'anon' } : { uid: t, email: `${t}@example.test`, name: 'New' }),
  }),
}));
// @ts-expect-error: plain ESM module, no type declarations
const { authMiddleware } = await import('../../services/api/src/middleware/auth.js');
// @ts-expect-error: plain ESM module, no type declarations
const { authMiddleware: billingAuth } = await import('../../services/billing/src/middleware/auth.js');

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function through(mw: any, token: string) {
  const out = { status: 0, body: undefined as any, next: false };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await mw({ headers: { authorization: `Bearer ${token}` }, log }, res, () => { out.next = true; });
  return out;
}

describe('a brand-new user is admitted by the auth middleware', () => {
  it.each([['api', () => authMiddleware], ['billing', () => billingAuth]])('%s: the first request creates the user row from the token claims', async (svc, mw) => {
    const uid = `newbie-${svc}`;
    expect((await through(mw(), uid)).next).toBe(true);
    const { rows } = await pool.query(`SELECT email, display_name FROM users WHERE uid = $1`, [uid]);
    expect(rows).toEqual([{ email: `${uid}@example.test`, display_name: 'New' }]);
  });

  it('an anonymous caller (no email claim) gets the placeholder email', async () => {
    expect((await through(authMiddleware, 'anon')).next).toBe(true);
    expect(await count(`SELECT 1 FROM users WHERE uid = 'anon' AND email = 'anon@firebase.local'`)).toBe(1);
  });

  it("then every onboarding write succeeds, and the retention choice is saved", async () => {
    // A uid no earlier test admitted: each test starts from an empty database.
    expect((await through(authMiddleware, 'onboarding')).next).toBe(true);
    await recordTermsAcceptance({ uid: 'onboarding', termsVersion: '1', privacyVersion: '1' });
    await registerPushToken({ uid: 'onboarding', token: 'tok', platform: 'ios' });
    await trackEvent({ uid: 'onboarding', event: 'app_open' });
    await createSupportRequest({ uid: 'onboarding', kind: 'contact', message: 'hi' });
    await setRetentionDays('onboarding', 30);
    expect(await getRetentionDays('onboarding')).toBe(30);
  });

  it('an instance upserts a uid once per TTL, then only checks the tombstone', async () => {
    const t0 = 1_000_000;
    expect(await admitUser({ uid: 'memo', name: 'First' }, quietLog, t0)).toBe('live');
    // Remembered: no upsert, so the new name claim isn't written yet.
    expect(await admitUser({ uid: 'memo', name: 'Second' }, quietLog, t0 + 1000)).toBe('live');
    expect((await pool.query(`SELECT display_name FROM users WHERE uid = 'memo'`)).rows).toEqual([{ display_name: 'First' }]);
    // Past the TTL: upserted again (the claims refresh, and a lost row would heal).
    expect(await admitUser({ uid: 'memo', name: 'Second' }, quietLog, t0 + 11 * 60 * 1000)).toBe('live');
    expect((await pool.query(`SELECT display_name FROM users WHERE uid = 'memo'`)).rows).toEqual([{ display_name: 'Second' }]);
  });

  it('a deleted account is still refused, on the first request and after it was admitted', async () => {
    await through(authMiddleware, 'gone');
    await deleteAccountData({ uid: 'gone' }, quietLog);
    expect(await through(authMiddleware, 'gone')).toEqual({ status: 401, body: { error: 'account_deleted' }, next: false });
    expect(await through(billingAuth, 'gone')).toEqual({ status: 401, body: { error: 'account_deleted' }, next: false });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'gone'`)).toBe(0);
  });

  it('an account with no users row: a first request racing its deletion cannot outlive it', async () => {
    // A request's first write, still uncommitted when the deletion starts.
    const racer = await pool.connect();
    try {
      await racer.query('BEGIN');
      await racer.query(`INSERT INTO users (uid, email) VALUES ('racer', 'r@example.test')`);
      const deletion = deleteAccountData({ uid: 'racer' }, quietLog);
      await new Promise((r) => setTimeout(r, 200));
      await racer.query('COMMIT'); // the deletion waited for it
      expect(await deletion).toMatchObject({ deleted: true });
    } finally {
      racer.release();
    }
    expect(await count(`SELECT 1 FROM users WHERE uid = 'racer'`)).toBe(0);
    expect(await count(`SELECT 1 FROM account_deletions WHERE uid = 'racer'`)).toBe(1);
  });

  it('deleting an account that never had a row reports nothing deleted, and leaves no row', async () => {
    expect(await deleteAccountData({ uid: 'never' }, quietLog)).toMatchObject({ deleted: false });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'never'`)).toBe(0);
  });

  it('a deleted account this instance never admitted is refused, and its row is not re-created', async () => {
    await pool.query(`INSERT INTO users (uid, email) VALUES ('gone2', 'g@example.test')`);
    await deleteAccountData({ uid: 'gone2' }, quietLog);
    expect(await through(authMiddleware, 'gone2')).toEqual({ status: 401, body: { error: 'account_deleted' }, next: false });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'gone2'`)).toBe(0);
  });
});
