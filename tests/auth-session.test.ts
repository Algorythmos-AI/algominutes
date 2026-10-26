import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The api's and billing's auth middlewares refuse a disabled account and revoked sessions (RELEASE.md PR 40),
// and let a request through, loudly, when Firebase Auth can't be asked.
const users = new Map<string, Record<string, unknown> | Error>();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: async (t: string) => ({ uid: t, auth_time: Date.parse('2026-09-30T03:00:00Z') / 1000 }),
    getUser: async (uid: string) => {
      const u = users.get(uid);
      if (u instanceof Error) throw u;
      return u ?? {};
    },
  }),
}));
// @ts-expect-error: plain ESM middleware, no type declarations
const { authMiddleware: api } = await import('../services/api/src/middleware/auth.js');
// @ts-expect-error: plain ESM middleware, no type declarations
const { authMiddleware: billing } = await import('../services/billing/src/middleware/auth.js');

async function call(mw: (req: any, res: any, next: () => void) => Promise<unknown>, uid: string) {
  const lines: Array<[string, Record<string, unknown>]> = [];
  const log: any = { warn: (o: Record<string, unknown>, m: string) => lines.push([m, o]), error: () => {}, child: () => log };
  const out = { status: 0, body: undefined as unknown, next: false };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
  await mw({ headers: { authorization: `Bearer ${uid}` }, log }, res, () => { out.next = true; });
  return { ...out, lines };
}

beforeEach(() => {
  users.clear();
  process.env.SESSION_CHECK = 'on';
});
afterEach(() => { delete process.env.SESSION_CHECK; });

describe.each([['api', api], ['billing', billing]])('%s auth', (_name, mw) => {
  it('an ordinary user goes through', async () => {
    users.set('u-ok', { disabled: false });
    expect(await call(mw, 'u-ok')).toMatchObject({ next: true, status: 0 });
  });

  it('a disabled account is refused, and said so in the logs', async () => {
    users.set('u-disabled', { disabled: true });
    const out = await call(mw, 'u-disabled');
    expect(out).toMatchObject({ next: false, status: 401, body: { error: 'account_disabled' } });
    expect(out.lines).toContainEqual(['auth_session_refused', { userId: 'u-disabled', reason: 'disabled' }]);
  });

  it('a token from before the sessions were revoked is refused', async () => {
    users.set('u-revoked', { disabled: false, tokensValidAfterTime: new Date('2026-09-30T04:00:00Z').toUTCString() });
    expect(await call(mw, 'u-revoked')).toMatchObject({ next: false, status: 401, body: { error: 'session_revoked' } });
  });

  it('switched off (the default until Terraform says on): nobody is asked, and a disabled account goes through', async () => {
    delete process.env.SESSION_CHECK;
    users.set('u-off', { disabled: true });
    expect(await call(mw, 'u-off')).toMatchObject({ next: true, status: 0, lines: [] });
  });

  it('Firebase Auth unreachable: the request goes on, and the failure is logged', async () => {
    users.set('u-down', new Error('ECONNRESET'));
    const out = await call(mw, 'u-down');
    expect(out.next).toBe(true);
    expect(out.lines.map((l) => l[0])).toContain('auth_session_check_failed');
  });
});
