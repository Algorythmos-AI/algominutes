import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool } from '@algominutes/db';
// @ts-expect-error: plain ESM route modules, no type declarations
import { setRetentionRoute, acceptTermsRoute, supportRoute } from '../../services/api/src/routes/compliance.js';
// @ts-expect-error: plain ESM route module, no type declarations
import { trackEventRoute } from '../../services/api/src/routes/events.js';
import { pool, resetDb, seedUser, count } from './helpers';

// These four handlers hand-validated loosely while stricter schemas sat unused
// in packages/contracts. They now validate with the published schemas, so the
// generated clients and the server agree. Driven for real against Postgres.
beforeEach(async () => {
  await resetDb();
  await seedUser('u1');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function call(route: (req: any, res: any) => Promise<unknown>, body: unknown) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
  const noop = () => {};
  await route({ uid: 'u1', ip: '203.0.113.9', body, log: { warn: noop, info: noop, error: noop } }, res);
  return out;
}

describe('routes validated with the contract schemas', () => {
  it('retention: positive integer or null; anything else (incl. a missing field) is refused', async () => {
    expect((await call(setRetentionRoute, { retentionDays: 30 })).status).toBe(200);
    expect((await pool.query(`SELECT retention_days FROM users WHERE uid = 'u1'`)).rows[0].retention_days).toBe(30);
    expect((await call(setRetentionRoute, { retentionDays: null })).status).toBe(200);
    for (const bad of [{ retentionDays: 0 }, { retentionDays: 1.5 }, { retentionDays: '30' }, {}]) {
      expect(await call(setRetentionRoute, bad)).toEqual({ status: 400, body: { error: 'invalid_retention' } });
    }
  });

  it('accept-terms: versions required as strings; platform must be ios|android|web', async () => {
    expect((await call(acceptTermsRoute, { termsVersion: '2026-09', privacyVersion: '2026-09', platform: 'ios' })).status).toBe(200);
    expect(await count(`SELECT 1 FROM terms_acceptance WHERE uid = 'u1'`)).toBe(1);
    for (const bad of [{ termsVersion: '2026-09' }, { termsVersion: 1, privacyVersion: 2 }, { termsVersion: 'a', privacyVersion: 'b', platform: 'windows' }]) {
      expect((await call(acceptTermsRoute, bad)).status).toBe(400);
    }
    expect(await count(`SELECT 1 FROM terms_acceptance WHERE uid = 'u1'`)).toBe(1);
  });

  it('support: kind enforced; a long message is trimmed to 4000 chars, not refused', async () => {
    const out = await call(supportRoute, { kind: 'bad_summary', message: 'x'.repeat(5000), noteId: 'n1', platform: 'web' });
    expect(out.status).toBe(201);
    const { rows } = await pool.query(`SELECT length(message) AS n, note_id FROM support_requests WHERE uid = 'u1'`);
    expect(rows[0]).toEqual({ n: 4000, note_id: 'n1' });
    expect((await call(supportRoute, { kind: 'rant' })).status).toBe(400);
  });

  it('events: only the published funnel events, with flat primitive props', async () => {
    expect((await call(trackEventRoute, { event: 'paywall_viewed', props: { source: 'quota', minutes: 30, trial: true } })).status).toBe(202);
    expect(await count(`SELECT 1 FROM analytics_events WHERE uid = 'u1' AND event = 'paywall_viewed'`)).toBe(1);
    for (const bad of [{ event: 'totally_made_up' }, {}, { event: 'purchase', props: { nested: { a: 1 } } }]) {
      expect(await call(trackEventRoute, bad)).toEqual({ status: 400, body: { error: 'invalid_event' } });
    }
  });
});
