import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// A verified token's session is still good (RELEASE.md PR 40): the account isn't disabled, and the token was
// issued after the user's sessions were last revoked. Asked of Firebase Auth once a minute per user.
const require = createRequire(import.meta.url);
const { createSessionCheck } = require('@algominutes/ai/session-check.cjs') as {
  createSessionCheck: (o: { getUser: (uid: string) => Promise<Record<string, unknown>>; ttlMs?: number; max?: number; now?: () => number }) =>
    (d: { uid: string; auth_time?: number }) => Promise<string>;
};

const REVOKED_AT = '2026-09-30T02:00:00.000Z';
const before = Date.parse(REVOKED_AT) / 1000 - 60;
const after = Date.parse(REVOKED_AT) / 1000 + 60;

function world(users: Record<string, Record<string, unknown> | Error>) {
  let t = 0;
  const asked: string[] = [];
  const getUser = vi.fn(async (uid: string) => {
    asked.push(uid);
    const u = users[uid];
    if (u instanceof Error) throw u;
    if (!u) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
    return u;
  });
  const check = createSessionCheck({ getUser, now: () => t });
  return { check, asked, advance: (ms: number) => { t += ms; }, users };
}

describe('a session', () => {
  it('is good for an ordinary user', async () => {
    const w = world({ alice: { disabled: false } });
    expect(await w.check({ uid: 'alice', auth_time: after })).toBe('ok');
  });

  it('a disabled account is refused', async () => {
    const w = world({ alice: { disabled: true } });
    expect(await w.check({ uid: 'alice', auth_time: after })).toBe('disabled');
  });

  it('a token issued before the sessions were revoked is refused; one issued after is good', async () => {
    const w = world({ alice: { disabled: false, tokensValidAfterTime: new Date(REVOKED_AT).toUTCString() } });
    expect(await w.check({ uid: 'alice', auth_time: before })).toBe('revoked');
    expect(await w.check({ uid: 'alice', auth_time: after })).toBe('ok');
    expect(await w.check({ uid: 'alice' })).toBe('revoked');
  });

  it('a Firebase user that no longer exists is revoked', async () => {
    const w = world({});
    expect(await w.check({ uid: 'ghost', auth_time: after })).toBe('revoked');
  });

  it('Firebase Auth failing is thrown, for the middleware to decide', async () => {
    const w = world({ alice: new Error('503 unavailable') });
    await expect(w.check({ uid: 'alice', auth_time: after })).rejects.toThrow('503');
  });

  it('asks once a minute per user, so a disabled account is refused within a minute', async () => {
    const w = world({ alice: { disabled: false }, bob: { disabled: false } });
    for (let i = 0; i < 5; i++) await w.check({ uid: 'alice', auth_time: after });
    await w.check({ uid: 'bob', auth_time: after });
    expect(w.asked).toEqual(['alice', 'bob']);
    w.users.alice = { disabled: true };
    w.advance(59_999);
    expect(await w.check({ uid: 'alice', auth_time: after })).toBe('ok');
    w.advance(1);
    expect(await w.check({ uid: 'alice', auth_time: after })).toBe('disabled');
    expect(w.asked).toEqual(['alice', 'bob', 'alice']);
  });

  it('remembers a bounded number of users', async () => {
    let asked = 0;
    const check = createSessionCheck({ getUser: async () => { asked += 1; return {}; }, max: 2, now: () => 0 });
    for (const uid of ['a', 'b', 'c', 'a']) await check({ uid, auth_time: after });
    expect(asked).toBe(4);
  });
});
