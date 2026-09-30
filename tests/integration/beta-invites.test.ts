import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { RedeemInviteResponse } from '@algominutes/contracts/schemas';
import { pool, resetDb, seedUser, seedWorkspace, count, quietLog } from './helpers';

// Beta invite codes (migration 025, docs/plans/RELEASE.md PR 2) against real
// Postgres: redeeming gives a time-limited Pro grant (019) and, when the invite
// says so, the notetaker (024). Only the code's hash is ever stored or logged.
const {
  getPool, createInvite, revokeInvite, listInvites, redeemInvite, normaliseInviteCode, hashInviteCode,
  resolveEntitlement, grantEntitlement, grantNotetaker, isNotetakerTester, deleteAccountData, ensureTrial,
} = repo;
const require = createRequire(import.meta.url);
const betaInviteJob = require('../../services/db-job/src/handlers/beta-invite.js');

// The kickoff's network edges, faked as in process-kickoff.test.ts.
const docs = new Map<string, Record<string, unknown>>();
function docRef(path: string) {
  return {
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async set(v: Record<string, unknown>, o?: { merge?: boolean }) {
      docs.set(path, o?.merge ? { ...(docs.get(path) ?? {}), ...v } : v);
    },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
    async delete() { docs.delete(path); },
  };
}
const fakeDb = { doc: docRef, collection: () => ({ add: async () => ({}) }) };
vi.mock('firebase-admin/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFirestore: () => fakeDb,
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: () => ({ getMetadata: async () => [{ size: '1000' }] }) }) }),
}));
const enqueued: Array<Record<string, unknown>> = [];
vi.mock('@algominutes/ai/cloud-tasks.cjs', () => ({
  default: { enqueueTask: async ({ payload }: { payload: Record<string, unknown> }) => { enqueued.push(payload); } },
}));
vi.mock('@algominutes/ai/intelligence.cjs', async (importOriginal) => {
  const real = ((await importOriginal()) as { default: Record<string, unknown> }).default;
  return { default: { ...real, enforceUsageBudget: async () => {} } };
});
// @ts-expect-error: plain ESM route module, no type declarations
const { processIntelligenceRoute, setTrialDevicesForTests } = await import('../../services/api/src/routes/process-intelligence.js');
// @ts-expect-error: plain ESM route module, no type declarations
const { redeemInviteRoute } = await import('../../services/api/src/routes/beta.js');

process.env.TRANSCODER_URL = 'https://transcoder.invalid';
process.env.JOBS_SA_EMAIL = 'jobs@example.invalid';
process.env.TASKS_PROJECT = 'test-project';

const DAY = 24 * 60 * 60 * 1000;
const CODE = 'BETA-7K2QX-M9D4R-TW8HN'; // gitleaks:allow (a test fixture, not a real invite)
const CODE2 = 'BETA-0000A-1111B-2222C'; // gitleaks:allow

beforeEach(async () => {
  await resetDb();
  docs.clear();
  enqueued.length = 0;
  await seedUser('alice');
  await seedUser('bob');
});
afterEach(() => {
  delete process.env.TRIAL_ON_FIRST_USE;
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

type InviteInput = Omit<Parameters<typeof createInvite>[0], 'codeHash'> & { code: string };
const invite = ({ code, ...over }: Partial<InviteInput> = {}) =>
  createInvite({ codeHash: hashInviteCode(code ?? CODE), label: 'cohort 1', grantDays: 30, maxRedemptions: 5, ...over });
const grantOf = async (uid: string) =>
  (await pool.query(`SELECT included_minutes, expires_at, reason FROM entitlement_grants WHERE uid = $1`, [uid])).rows[0];

// A captured request log, so tests can check what was (and wasn't) logged.
function captureLog() {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const at = (level: string) => (o: Record<string, unknown>, m: string) => { lines.push([level, m, o]); };
  const log: any = { info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
  return { log, lines };
}

async function redeemOverHttp(uid: string, body: unknown, extra: Record<string, unknown> = {}) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.status ||= 200; out.body = b; return this; },
  };
  const { log, lines } = captureLog();
  await redeemInviteRoute({ uid, authEmail: null, authName: null, log, body, ...extra }, res);
  return { ...out, lines };
}

describe('normaliseInviteCode', () => {
  it('ignores case, spaces and any dash, and reads look-alike letters as digits', () => {
    expect(normaliseInviteCode('beta-7k2qx-m9d4r-tw8hn')).toBe(CODE);
    expect(normaliseInviteCode('  BETA 7K2QX M9D4R TW8HN ')).toBe(CODE);
    expect(normaliseInviteCode('BETA—7K2QX–M9D4R‐TW8HN')).toBe(CODE);
    expect(normaliseInviteCode('BETA7K2QXM9D4RTW8HN')).toBe(CODE);
    expect(normaliseInviteCode('BETA-OOOOA-IIIIB-LLLLC')).toBe('BETA-0000A-1111B-1111C');
  });

  it('refuses anything that cannot be a code', () => {
    for (const bad of ['', 'BETA', 'BETA-7K2QX-M9D4R', 'BETA-7K2QX-M9D4R-TW8HNX', 'GAMMA-7K2QX-M9D4R-TW8HN',
      'BETA-UUUUU-M9D4R-TW8HN', 'x'.repeat(65), 12345, null, undefined, { code: CODE }]) {
      expect(normaliseInviteCode(bad as never)).toBeNull();
    }
  });
});

describe('invites', () => {
  it("are stored as the code's hash alone", async () => {
    const i = await invite();
    const row = (await pool.query(`SELECT * FROM beta_invites WHERE id = $1`, [i.id])).rows[0];
    expect(row.code_hash).toBe(hashInviteCode(CODE));
    expect(JSON.stringify(row)).not.toContain('7K2QX');
  });

  it('refuse something that is not a hash, a duplicate, or limits out of range', async () => {
    for (const bad of ['', 'BETA-7K2QX-M9D4R-TW8HN', hashInviteCode(CODE).toUpperCase(), 'ab'.repeat(33)]) {
      await expect(createInvite({ codeHash: bad, label: 'x', grantDays: 30, maxRedemptions: 1 })).rejects.toMatchObject({ code: 'INVITE_CODE_INVALID' });
    }
    await invite();
    await expect(invite({ label: 'again' })).rejects.toMatchObject({ code: 'INVITE_CODE_EXISTS' });
    await expect(invite({ code: CODE2, grantDays: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(invite({ code: CODE2, maxRedemptions: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(invite({ code: CODE2, includedMinutes: 20000 })).rejects.toMatchObject({ code: '23514' });
    expect(await count(`SELECT 1 FROM beta_invites`)).toBe(1);
  });
});

describe('redeemInvite', () => {
  it('gives Pro until the invite window ends, and uses one redemption', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const i = await invite({ includedMinutes: 600 });
    const r = await redeemInvite({ uid: 'alice', code: 'beta 7k2qx m9d4r tw8hn', now });
    expect(r).toEqual({ kind: 'redeemed', inviteId: i.id, replay: false, grantEndsAt: new Date(now.getTime() + 30 * DAY), notetaker: false });
    expect(await grantOf('alice')).toMatchObject({ included_minutes: 600, reason: `invite:${i.id}` });
    expect((await listInvites())[0]).toMatchObject({ redemptions: 1 });
  });

  it('a replay by the same user returns the same answer and uses nothing', async () => {
    const now = new Date();
    await invite();
    const first = await redeemInvite({ uid: 'alice', code: CODE, now });
    const again = await redeemInvite({ uid: 'alice', code: CODE, now: new Date(now.getTime() + 60_000) });
    expect(again).toEqual({ ...first, replay: true });
    expect((await listInvites())[0]).toMatchObject({ redemptions: 1 });
  });

  it('refuses an unknown or revoked code as invalid, an expired one, and a used-up one', async () => {
    expect(await redeemInvite({ uid: 'alice', code: CODE })).toEqual({ kind: 'invalid' });
    expect(await redeemInvite({ uid: 'alice', code: 'not a code' })).toEqual({ kind: 'invalid' });

    const expired = await invite({ expiresAt: new Date(Date.now() - 1000) });
    expect(await redeemInvite({ uid: 'alice', code: CODE })).toEqual({ kind: 'expired', inviteId: expired.id });

    const one = await invite({ code: CODE2, maxRedemptions: 1 });
    expect((await redeemInvite({ uid: 'alice', code: CODE2 })).kind).toBe('redeemed');
    expect(await redeemInvite({ uid: 'bob', code: CODE2 })).toEqual({ kind: 'used_up', inviteId: one.id });

    expect(await revokeInvite({ codeHash: hashInviteCode(CODE2) })).toEqual({ id: one.id, revoked: true });
    expect(await revokeInvite({ id: one.id })).toEqual({ id: one.id, revoked: false });
    await seedUser('carol');
    expect(await redeemInvite({ uid: 'carol', code: CODE2 })).toEqual({ kind: 'invalid' });
    // A user who redeemed before the revoke keeps the grant, and a replay still answers redeemed.
    expect((await redeemInvite({ uid: 'alice', code: CODE2 })).kind).toBe('redeemed');
    expect(await grantOf('alice')).toBeTruthy();
    await expect(revokeInvite({ id: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND' });
  });

  it("the last use can't be taken twice: concurrent redemptions, exactly one wins", async () => {
    const { id } = await invite({ maxRedemptions: 1 });
    // Hold the invite row, so both redemptions are in flight at once when it's released.
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM beta_invites WHERE id = $1 FOR UPDATE', [id]);
    const racing = Promise.allSettled([
      redeemInvite({ uid: 'alice', code: CODE }),
      redeemInvite({ uid: 'bob', code: CODE }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    await blocker.query('COMMIT');
    blocker.release();
    const results = await racing;
    // Neither fails (no constraint error), one wins, one is told it's used up.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const kinds = results.map((r) => (r as PromiseFulfilledResult<{ kind: string }>).value.kind).sort();
    expect(kinds).toEqual(['redeemed', 'used_up']);
    expect(await count(`SELECT 1 FROM entitlement_grants`)).toBe(1);
    expect((await listInvites())[0]).toMatchObject({ redemptions: 1 });
  });

  it('never takes from a live grant: the invite replaces it only when as good on both counts', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    // The owner's grant beats the invite on both counts: untouched.
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester', includedMinutes: 2000, expiresAt: null });
    await invite({ includedMinutes: 600 });
    expect(await redeemInvite({ uid: 'alice', code: CODE, now })).toMatchObject({ kind: 'redeemed', grantEndsAt: null });
    expect(await grantOf('alice')).toMatchObject({ included_minutes: 2000, expires_at: null, reason: 'internal_tester' });

    // The invite is as good on both (later end; NULL = Pro's 1,500 > 200): it replaces the grant whole.
    const i2 = await invite({ code: CODE2, includedMinutes: null, grantDays: 30 });
    await grantEntitlement({ uid: 'bob', reason: 'internal_tester', includedMinutes: 200, expiresAt: new Date(now.getTime() + 5 * DAY) });
    expect(await redeemInvite({ uid: 'bob', code: CODE2, now })).toMatchObject({ kind: 'redeemed', grantEndsAt: new Date(now.getTime() + 30 * DAY) });
    expect(await grantOf('bob')).toEqual({ included_minutes: null, expires_at: new Date(now.getTime() + 30 * DAY), reason: `invite:${i2.id}` });
  });

  it('never mixes two grants into one bigger than either: a split decision keeps the live grant', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    await invite({ includedMinutes: 600, grantDays: 30, maxRedemptions: 5 });
    // Fewer minutes but no end, vs more minutes for 30 days: kept as it is.
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester', includedMinutes: 100, expiresAt: null });
    expect(await redeemInvite({ uid: 'alice', code: CODE, now })).toMatchObject({ kind: 'redeemed', grantEndsAt: null });
    expect(await grantOf('alice')).toEqual({ included_minutes: 100, expires_at: null, reason: 'internal_tester' });
    // More minutes ending tomorrow, vs fewer for 30 days: kept as it is.
    const tomorrow = new Date(now.getTime() + DAY);
    await grantEntitlement({ uid: 'bob', reason: 'internal_tester', includedMinutes: 5000, expiresAt: tomorrow });
    expect(await redeemInvite({ uid: 'bob', code: CODE, now })).toMatchObject({ kind: 'redeemed', grantEndsAt: tomorrow });
    expect(await grantOf('bob')).toEqual({ included_minutes: 5000, expires_at: tomorrow, reason: 'internal_tester' });
  });

  it("a live grant the owner commits mid-redemption is left alone", async () => {
    await invite({ includedMinutes: 600 });
    // The owner's grant-tester inserts a grant for bob and hasn't committed yet.
    const owner = await pool.connect();
    await owner.query('BEGIN');
    await owner.query(`INSERT INTO entitlement_grants (uid, plan, reason, expires_at) VALUES ('bob', 'pro', 'owner', NULL)`);
    const redeeming = redeemInvite({ uid: 'bob', code: CODE });
    await new Promise((r) => setTimeout(r, 300));
    await owner.query('COMMIT');
    owner.release();
    expect(await redeeming).toMatchObject({ kind: 'redeemed', grantEndsAt: null });
    expect(await grantOf('bob')).toEqual({ included_minutes: null, expires_at: null, reason: 'owner' });
  });

  it('a replay reports what the user has now; once the grant is gone the code is spent', async () => {
    await invite({ notetaker: true });
    expect(await redeemInvite({ uid: 'alice', code: CODE })).toMatchObject({ kind: 'redeemed', notetaker: true });
    await repo.revokeNotetaker({ uid: 'alice' });
    expect(await redeemInvite({ uid: 'alice', code: CODE })).toMatchObject({ kind: 'redeemed', replay: true, notetaker: false });
    await repo.revokeEntitlement({ uid: 'alice' });
    const i = (await listInvites())[0]!;
    expect(await redeemInvite({ uid: 'alice', code: CODE })).toEqual({ kind: 'used_up', inviteId: i.id });
    expect(i.redemptions).toBe(1);
  });

  it('replaces a grant that has already ended', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    await grantEntitlement({ uid: 'alice', reason: 'old', includedMinutes: 5000, expiresAt: new Date(now.getTime() - DAY) });
    const i = await invite({ includedMinutes: 600 });
    await redeemInvite({ uid: 'alice', code: CODE, now });
    expect(await grantOf('alice')).toMatchObject({ included_minutes: 600, reason: `invite:${i.id}`, expires_at: new Date(now.getTime() + 30 * DAY) });
  });

  it("allowlists the notetaker when the invite says so, for the invite's own window", async () => {
    const now = new Date();
    await invite({ notetaker: true, grantDays: 14 });
    // A longer manual grant doesn't stretch the notetaker's window.
    await grantEntitlement({ uid: 'alice', reason: 'internal_tester', expiresAt: null });
    expect(await redeemInvite({ uid: 'alice', code: CODE, now })).toMatchObject({ notetaker: true });
    expect(await isNotetakerTester('alice')).toBe(true);
    const row = (await pool.query(`SELECT expires_at FROM notetaker_testers WHERE uid = 'alice'`)).rows[0];
    expect(row.expires_at).toEqual(new Date(now.getTime() + 14 * DAY));
    // An invite without it grants no notetaker.
    await invite({ code: CODE2 });
    await redeemInvite({ uid: 'bob', code: CODE2 });
    expect(await isNotetakerTester('bob')).toBe(false);
    // An existing allowlisting until revoked stays until revoked.
    await grantNotetaker({ uid: 'bob', reason: 'owner', expiresAt: null });
    await pool.query(`UPDATE beta_invites SET notetaker = TRUE`);
    await seedUser('carol');
    await grantNotetaker({ uid: 'carol', reason: 'owner', expiresAt: null });
    await redeemInvite({ uid: 'carol', code: CODE2 });
    expect((await pool.query(`SELECT expires_at FROM notetaker_testers WHERE uid = 'carol'`)).rows[0].expires_at).toBeNull();
  });

  it("one user's redemption gives another nothing, and each user's replay is their own", async () => {
    await invite({ maxRedemptions: 2 });
    await redeemInvite({ uid: 'alice', code: CODE });
    expect(await resolveEntitlement('bob')).not.toMatchObject({ state: 'active' });
    expect(await redeemInvite({ uid: 'bob', code: CODE })).toMatchObject({ kind: 'redeemed', replay: false });
    expect(await count(`SELECT 1 FROM beta_invite_redemptions`)).toBe(2);
  });

  it("a brand-new guest's first write can be a redemption; a deleted account can't redeem", async () => {
    await invite();
    expect((await redeemInvite({ uid: 'guest1', code: CODE })).kind).toBe('redeemed');
    expect(await count(`SELECT 1 FROM users WHERE uid = 'guest1'`)).toBe(1);

    await deleteAccountData({ uid: 'bob' }, quietLog);
    await expect(redeemInvite({ uid: 'bob', code: CODE })).rejects.toMatchObject({ code: 'ACCOUNT_DELETED' });
  });

  it('goes with the account: the redemption and the grant are removed, and the use stays counted', async () => {
    await invite();
    await redeemInvite({ uid: 'alice', code: CODE });
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await count(`SELECT 1 FROM beta_invite_redemptions`)).toBe(0);
    expect(await count(`SELECT 1 FROM entitlement_grants`)).toBe(0);
    expect((await listInvites())[0]).toMatchObject({ redemptions: 1 });
  });
});

describe('POST /v1/beta/redeem', () => {
  it('answers the contract, and never logs the code', async () => {
    await invite({ includedMinutes: 600 });
    const out = await redeemOverHttp('alice', { code: 'beta-7k2qx-m9d4r-tw8hn' });
    expect(out.status).toBe(200);
    expect(() => RedeemInviteResponse.parse(out.body)).not.toThrow();
    expect(out.body).toMatchObject({ entitlement: { state: 'active', plan: 'pro', includedMinutes: 600 }, notetaker: false });
    expect(out.lines.map((l) => l[1])).toEqual(['beta_invite_redeemed']);
    expect(JSON.stringify(out.lines).toUpperCase()).not.toContain('7K2QX');
  });

  it('maps each refusal to its status, and logs the reason without the code', async () => {
    expect(await redeemOverHttp('alice', { code: CODE })).toMatchObject({ status: 400, body: { error: 'invite_invalid' } });
    expect(await redeemOverHttp('alice', {})).toMatchObject({ status: 400, body: { error: 'invite_invalid' } });
    expect(await redeemOverHttp('alice', { code: 'x'.repeat(65) })).toMatchObject({ status: 400 });
    await invite({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await redeemOverHttp('alice', { code: CODE });
    expect(expired).toMatchObject({ status: 410, body: { error: 'invite_expired' } });
    expect(JSON.stringify(expired.lines)).not.toContain('7K2QX');
    await invite({ code: CODE2, maxRedemptions: 1 });
    await redeemOverHttp('alice', { code: CODE2 });
    expect(await redeemOverHttp('bob', { code: CODE2 })).toMatchObject({ status: 409, body: { error: 'invite_used_up' } });
  });

  it('a deleted account gets 401 account_deleted', async () => {
    await invite();
    await deleteAccountData({ uid: 'bob' }, quietLog);
    expect(await redeemOverHttp('bob', { code: CODE })).toMatchObject({ status: 401, body: { error: 'account_deleted' } });
  });
});

// The beta's path on staging: the trial is off, so a new tester's first
// recording is refused, they redeem their code, and the retry is queued.
describe('trial switched off (TRIAL_ON_FIRST_USE=off)', () => {
  async function kickoff(uid: string, noteId: string, headers: Record<string, string> = {}) {
    docs.set(`workspaces/workspace_${uid}/notes/${noteId}`, { authorId: uid, status: 'uploading' });
    const out = { status: 0, body: undefined as any };
    const res = {
      status(c: number) { out.status = c; return this; },
      json(b: unknown) { out.status ||= 200; out.body = b; return this; },
    };
    const { log } = captureLog();
    await processIntelligenceRoute({
      // req.client as the client-version gate sets it (from X-AlgoMinutes-Client): the iPhone app.
      uid, authEmail: null, log, traceId: 'trace-beta', headers, client: { platform: 'ios', version: '1.0.0' },
      body: { noteId, workspaceId: `workspace_${uid}`, type: 'recording', storagePath: `recordings/workspace_${uid}/${noteId}.m4a`, durationSec: 120 },
    }, res);
    return out;
  }

  const unusedDevice = () => ({ trialUsed: async () => false, markTrialUsed: async () => {} });

  it("a new user opens on the free floor, even with a device token; switched on, they'd trial", async () => {
    process.env.TRIAL_ON_FIRST_USE = 'off';
    await seedUser('dan');
    expect(await resolveEntitlement('dan')).toMatchObject({ state: 'free_floor', includedMinutes: 0 });
    await ensureTrial('dan', { platform: 'ios', device: unusedDevice() });
    expect((await pool.query(`SELECT entitlement_state, trial_end FROM subscriptions WHERE uid = 'dan'`)).rows[0])
      .toEqual({ entitlement_state: 'free_floor', trial_end: null });

    delete process.env.TRIAL_ON_FIRST_USE;
    await seedUser('erin');
    expect(await resolveEntitlement('erin')).toMatchObject({ state: 'trialing' });
    await ensureTrial('erin', { platform: 'ios', device: unusedDevice() });
    expect(await resolveEntitlement('erin')).toMatchObject({ state: 'trialing' });
  });

  // RELEASE.md PR 22: a new iOS user's trial is Apple's DeviceCheck to decide, and the device is marked once it
  // starts, so a reinstall (a new uid on the same phone) can't start another.
  function appleDevice(used: boolean, over: Partial<{ markFails: boolean; checkFails: boolean }> = {}) {
    const calls: string[] = [];
    return {
      calls,
      device: {
        trialUsed: async () => { calls.push('check'); if (over.checkFails) throw new Error('devicecheck 503'); return used; },
        markTrialUsed: async () => { calls.push('mark'); if (over.markFails) throw new Error('devicecheck 503'); },
      },
    };
  }
  const logLines = () => {
    const lines: any[] = [];
    return { lines, log: { error: (o: any, m: string) => lines.push({ level: 'error', m, ...o }), warn: (o: any, m: string) => lines.push({ level: 'warn', m, ...o }) } };
  };

  it('an iPhone Apple has never seen trial starts the trial and marks the device; one that has, opens on the free floor', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    await seedUser('dan');
    const fresh = appleDevice(false);
    await ensureTrial('dan', { platform: 'ios', device: fresh.device });
    expect(fresh.calls).toEqual(['check', 'mark']);
    expect(await resolveEntitlement('dan')).toMatchObject({ state: 'trialing' });

    await seedUser('erin');
    const reinstalled = appleDevice(true);
    await ensureTrial('erin', { platform: 'ios', device: reinstalled.device });
    expect(reinstalled.calls).toEqual(['check']);
    expect((await pool.query(`SELECT entitlement_state, trial_end FROM subscriptions WHERE uid = 'erin'`)).rows[0])
      .toEqual({ entitlement_state: 'free_floor', trial_end: null });
  });

  it('no device to ask (no token), or Android, opens on the free floor; the trial switched off never asks Apple', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    await seedUser('dan');
    const { log, lines } = logLines();
    await ensureTrial('dan', { platform: 'ios', log });
    expect(await resolveEntitlement('dan')).toMatchObject({ state: 'free_floor' });
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', m: 'trial_device_unverified', userId: 'dan' })]);
    await seedUser('erin');
    const android = appleDevice(false);
    await ensureTrial('erin', { platform: 'android', device: android.device });
    expect(await resolveEntitlement('erin')).toMatchObject({ state: 'free_floor' });
    expect(android.calls).toEqual([]);
    process.env.TRIAL_ON_FIRST_USE = 'off';
    await seedUser('frank');
    const off = appleDevice(false);
    await ensureTrial('frank', { platform: 'ios', device: off.device });
    expect(off.calls).toEqual([]);
  });

  it('Apple unreachable writes nothing, so a retry can still start the trial', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    await seedUser('dan');
    await expect(ensureTrial('dan', { platform: 'ios', device: appleDevice(false, { checkFails: true }).device })).rejects.toThrow('devicecheck 503');
    expect(await count(`SELECT 1 FROM subscriptions WHERE uid = 'dan'`)).toBe(0);
    await ensureTrial('dan', { platform: 'ios', device: appleDevice(false).device });
    expect(await resolveEntitlement('dan')).toMatchObject({ state: 'trialing' });
  });

  it('a device that can\'t be marked keeps its trial, and says so', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    await seedUser('dan');
    const { log, lines } = logLines();
    await ensureTrial('dan', { platform: 'ios', device: appleDevice(false, { markFails: true }).device, log });
    expect(await resolveEntitlement('dan')).toMatchObject({ state: 'trialing' });
    expect(lines).toEqual([expect.objectContaining({ level: 'error', m: 'trial_device_mark_failed', userId: 'dan' })]);
  });

  it('a user who already has a row is never asked about again', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    await ensureTrial('alice', { platform: 'ios', device: appleDevice(false).device });
    const again = appleDevice(false);
    await ensureTrial('alice', { platform: 'ios', device: again.device });
    expect(again.calls).toEqual([]);
  });

  it('the kickoff asks Apple about the iPhone it came from, and a new user\'s first recording starts the trial', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    const asked: any[] = [];
    setTrialDevicesForTests(({ token, platform }: { token: string; platform?: string }) => {
      asked.push({ token, platform });
      return platform === 'ios' && token ? { trialUsed: async () => false, markTrialUsed: async () => { asked.push('marked'); } } : undefined;
    });
    try {
      await seedUser('dan');
      await seedWorkspace('workspace_dan', 'dan');
      const out = await kickoff('dan', 'n1', { 'x-device-attestation': 'dc-token' });
      expect(out).toMatchObject({ status: 200, body: { status: 'queued' } });
      expect(asked).toEqual([{ token: 'dc-token', platform: 'ios' }, 'marked']);
      expect(await resolveEntitlement('dan')).toMatchObject({ state: 'trialing' });
    } finally {
      setTrialDevicesForTests(null);
    }
  });

  it('a kickoff the client gate gave no platform gets no trial (the route never passes none)', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    await seedUser('gina');
    await seedWorkspace('workspace_gina', 'gina');
    docs.set('workspaces/workspace_gina/notes/n9', { authorId: 'gina', status: 'uploading' });
    const out = { status: 0, body: undefined as any };
    const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
    await processIntelligenceRoute({
      uid: 'gina', authEmail: 'gina@test.invalid', log: captureLog().log, traceId: 't', headers: {},
      body: { noteId: 'n9', workspaceId: 'workspace_gina', type: 'recording', storagePath: 'recordings/workspace_gina/n9.m4a', durationSec: 120 },
    }, res);
    expect(out.status).toBe(402);
    expect(await resolveEntitlement('gina')).toMatchObject({ state: 'free_floor' });
  });

  it('a platform nobody ships, or none from the gate, gets no trial; only a direct repo caller may omit it', async () => {
    delete process.env.TRIAL_ON_FIRST_USE;
    for (const [uid, platform] of [['dan', 'server'], ['erin', 'unknown'], ['frank', 'android']]) {
      await seedUser(uid);
      await ensureTrial(uid, { platform, device: unusedDevice() });
      expect(await resolveEntitlement(uid), platform).toMatchObject({ state: 'free_floor' });
    }
  });

  it('never changes a user who already has a trial', async () => {
    await ensureTrial('alice', { platform: 'ios', device: unusedDevice() });
    process.env.TRIAL_ON_FIRST_USE = 'off';
    expect(await resolveEntitlement('alice')).toMatchObject({ state: 'trialing' });
  });

  it('a first recording is refused (402), the tester redeems, and the retry is queued', async () => {
    process.env.TRIAL_ON_FIRST_USE = 'off';
    await seedWorkspace('workspace_alice', 'alice');
    const refused = await kickoff('alice', 'n1', { 'x-device-attestation': 'token', 'x-device-platform': 'ios' });
    expect(refused.status).toBe(402);
    expect(enqueued).toHaveLength(0);

    await invite();
    expect((await redeemOverHttp('alice', { code: CODE })).status).toBe(200);
    const retried = await kickoff('alice', 'n1');
    expect(retried).toMatchObject({ status: 200, body: { status: 'queued' } });
    expect(enqueued).toHaveLength(1);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1' AND status = 'queued'`)).toBe(1);
  });
});

describe('db-job beta-invite', () => {
  it('creates an invite from a code, logging its id and never the code', async () => {
    const { log, lines } = captureLog();
    const now = new Date('2026-10-01T00:00:00Z');
    const r = await betaInviteJob.run({
      log, repo, now,
      env: { INVITE_CODE_SHA256: hashInviteCode(CODE).toUpperCase(), INVITE_LABEL: 'cohort 1', INVITE_USES: '25', INVITE_MINUTES: '600', INVITE_NOTETAKER: 'true', INVITE_EXPIRES_DAYS: '14' },
    });
    const [i] = await listInvites();
    expect(r).toEqual({ id: i!.id });
    expect(i).toMatchObject({ label: 'cohort 1', maxRedemptions: 25, grantDays: 30, includedMinutes: 600, notetaker: true, expiresAt: new Date(now.getTime() + 14 * DAY) });
    expect(lines).toEqual([['info', 'beta_invite_created', expect.objectContaining({ inviteId: i!.id })]]);
    expect(JSON.stringify(lines)).not.toContain(hashInviteCode(CODE));
    // The code it was made from redeems.
    expect((await redeemInvite({ uid: 'alice', code: CODE })).kind).toBe('redeemed');
  });

  it('refuses a plaintext code: it would already sit in the execution\'s env overrides', async () => {
    const { log } = captureLog();
    // Even alongside a hash: the plaintext must never be passed at all.
    const withHash = { INVITE_CODE: CODE, INVITE_CODE_SHA256: hashInviteCode(CODE), INVITE_LABEL: 'x' };
    await expect(betaInviteJob.run({ log, repo, env: withHash })).rejects.toThrow(/never the code itself/);
    await expect(betaInviteJob.run({ log, repo, env: { ...withHash, MODE: 'revoke' } })).rejects.toThrow(/never the code itself/);
    expect(await count(`SELECT 1 FROM beta_invites`)).toBe(0);
  });

  it('defaults to one use for 30 days; lists and revokes; refuses bad input', async () => {
    const { log, lines } = captureLog();
    await betaInviteJob.run({ log, repo, env: { INVITE_CODE_SHA256: hashInviteCode(CODE), INVITE_LABEL: 'reviewer', INVITE_USES: ' ' } });
    expect((await listInvites())[0]).toMatchObject({ maxRedemptions: 1, grantDays: 30, includedMinutes: null, notetaker: false, expiresAt: null });
    lines.length = 0;
    expect(await betaInviteJob.run({ log, repo, env: { MODE: 'list' } })).toEqual({ count: 1 });
    const [listed] = lines;
    expect(listed).toEqual(['info', 'beta_invite_listed', expect.objectContaining({ label: 'reviewer', redemptions: 0 })]);
    const id = (listed![2] as { inviteId: string }).inviteId;
    expect(await betaInviteJob.run({ log, repo, env: { MODE: 'revoke', INVITE_ID: id } })).toEqual({ id, revoked: true });
    expect(await betaInviteJob.run({ log, repo, env: { MODE: 'revoke', INVITE_CODE_SHA256: hashInviteCode(CODE) } })).toEqual({ id, revoked: false });

    const h2 = hashInviteCode(CODE2);
    await expect(betaInviteJob.run({ log, repo, env: { INVITE_LABEL: 'x' } })).rejects.toThrow(/INVITE_CODE_SHA256/);
    await expect(betaInviteJob.run({ log, repo, env: { INVITE_CODE_SHA256: h2 } })).rejects.toThrow(/INVITE_LABEL/);
    await expect(betaInviteJob.run({ log, repo, env: { INVITE_CODE_SHA256: h2, INVITE_LABEL: 'x', INVITE_USES: '0' } })).rejects.toThrow(/INVITE_USES/);
    await expect(betaInviteJob.run({ log, repo, env: { INVITE_CODE_SHA256: h2, INVITE_LABEL: 'x', INVITE_DAYS: '1.5' } })).rejects.toThrow(/INVITE_DAYS/);
    await expect(betaInviteJob.run({ log, repo, env: { INVITE_CODE_SHA256: 'nothex', INVITE_LABEL: 'x' } })).rejects.toMatchObject({ code: 'INVITE_CODE_INVALID' });
    await expect(betaInviteJob.run({ log, repo, env: { MODE: 'revoke' } })).rejects.toThrow(/INVITE_ID/);
    await expect(betaInviteJob.run({ log, repo, env: { MODE: 'drop' } })).rejects.toThrow(/MODE/);
  });
});
