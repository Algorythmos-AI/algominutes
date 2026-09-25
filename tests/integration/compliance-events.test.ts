import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser } from './helpers';
// @ts-expect-error: plain ESM route module, no type declarations
import { setRetentionRoute, acceptTermsRoute, supportRoute } from '../../services/api/src/routes/compliance.js';

// The compliance routes record what happened as ServerAnalyticsEvents, after
// the action succeeded (a client can't post these to /v1/events).
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function call(route: (req: unknown, res: unknown) => Promise<unknown>, body: Record<string, unknown>) {
  const out = { status: 0 };
  const res = { status(c: number) { out.status = c; return this; }, json() { return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await route({ uid: 'alice', log, body, ip: '203.0.113.9' }, res);
  return out.status;
}

const events = async () =>
  (await pool.query(`SELECT event, uid, props FROM analytics_events ORDER BY id`)).rows;

describe('compliance routes record server analytics events', () => {
  it('terms_accepted, retention_set and support_requested, each after the action', async () => {
    expect(await call(acceptTermsRoute, { termsVersion: '2026-09', privacyVersion: '2026-09', platform: 'ios' })).toBe(200);
    expect(await call(setRetentionRoute, { retentionDays: 30 })).toBe(200);
    expect(await call(setRetentionRoute, { retentionDays: null })).toBe(200);
    expect(await call(supportRoute, { kind: 'bad_transcript', message: 'x', platform: 'ios' })).toBe(201);
    expect(await events()).toEqual([
      { event: 'terms_accepted', uid: 'alice', props: { termsVersion: '2026-09', privacyVersion: '2026-09', platform: 'ios' } },
      { event: 'retention_set', uid: 'alice', props: { days: 30 } },
      { event: 'retention_set', uid: 'alice', props: { days: 'keep' } },
      { event: 'support_requested', uid: 'alice', props: { kind: 'bad_transcript', platform: 'ios' } },
    ]);
  });

  it('an invalid request records nothing', async () => {
    expect(await call(setRetentionRoute, { retentionDays: -3 })).toBe(400);
    expect(await call(acceptTermsRoute, {})).toBe(400);
    expect(await events()).toEqual([]);
  });
});
