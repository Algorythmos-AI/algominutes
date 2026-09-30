import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import * as repo from '@algominutes/db';
import { ExtensionLinkResponse } from '@algominutes/contracts/schemas';
import { pool, resetDb, seedUser, count, quietLog } from './helpers';

// Signing the browser extension in (migration 035, docs/plans/RELEASE.md PR 34)
// against real Postgres: a one-time code bound to the user, the extension and a
// verifier's hash, spent by the first attempt to trade it.
const { getPool, createExtensionLink, redeemExtensionLink, extensionVerifierHash, deleteAccountData } = repo;

const minted: string[] = [];
let failMint = false;
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    createCustomToken: async (uid: string) => {
      if (failMint) throw new Error('signBlob denied');
      minted.push(uid);
      return `custom-token-for-${uid}`;
    },
  }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { extensionLinkRoute, extensionTokenRoute, allowedExtensionIds } = await import('../../services/api/src/routes/extension-auth.js');

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EDGE = 'ponmlkjihgfedcbaponmlkjihgfedcba';
// A verifier the way the extension makes one: 32 random bytes, base64url.
const newVerifier = () => crypto.randomBytes(32).toString('base64url');

beforeEach(async () => {
  await resetDb();
  minted.length = 0;
  failMint = false;
  await seedUser('alice');
  await seedUser('bob');
  process.env.ALLOWED_ORIGINS = `https://beta.example.test,chrome-extension://${EXT},chrome-extension://${EDGE}`;
});
afterEach(() => { delete process.env.ALLOWED_ORIGINS; });
afterAll(async () => { await getPool().end(); await pool.end(); });

// A logger that records each line with the fields its children were bound to.
function captureLog() {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const make = (bound: Record<string, unknown>): any => {
    const at = (level: string) => (o: Record<string, unknown>, m: string) => { lines.push([level, m, { ...bound, ...o }]); };
    return { info: at('info'), warn: at('warn'), error: at('error'), child: (b: Record<string, unknown>) => make({ ...bound, ...b }) };
  };
  return { log: make({}), lines };
}

async function overHttp(route: (req: any, res: any) => Promise<unknown>, req: Record<string, unknown>) {
  const out = { status: 0, body: undefined as any, headers: {} as Record<string, string> };
  const res = {
    set(k: string, v: string) { out.headers[k] = v; return this; },
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.status ||= 200; out.body = b; return this; },
  };
  const { log, lines } = captureLog();
  await route({ log, headers: {}, ...req }, res);
  return { ...out, lines };
}
const link = (uid: string, body: unknown) => overHttp(extensionLinkRoute, { uid, body });
const trade = (body: unknown, headers: Record<string, string> = { origin: `chrome-extension://${EXT}` }) =>
  overHttp(extensionTokenRoute, { body, headers });

describe('extension links (repo)', () => {
  it('stores only the code\'s hash, for 60 seconds', async () => {
    const verifier = newVerifier();
    const now = new Date('2026-09-30T00:00:00Z');
    const { code, expiresAt } = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier), now });
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.toISOString()).toBe('2026-09-30T00:01:00.000Z');
    const { rows } = await pool.query('SELECT * FROM extension_links');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(verifier);
    expect(rows[0].code_hash).toBe(crypto.createHash('sha256').update(code).digest('hex'));
  });

  it('trades once: the second attempt finds nothing', async () => {
    const verifier = newVerifier();
    const { code } = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    expect(await redeemExtensionLink({ code, verifier, extensionId: EXT })).toEqual({ kind: 'ok', uid: 'alice' });
    expect(await redeemExtensionLink({ code, verifier, extensionId: EXT })).toEqual({ kind: 'unknown' });
  });

  it('a wrong verifier or another extension spends the code, so the right one can\'t follow', async () => {
    const verifier = newVerifier();
    const a = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    expect(await redeemExtensionLink({ code: a.code, verifier: newVerifier(), extensionId: EXT })).toEqual({ kind: 'mismatch', uid: 'alice' });
    expect(await redeemExtensionLink({ code: a.code, verifier, extensionId: EXT })).toEqual({ kind: 'unknown' });

    const b = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    expect(await redeemExtensionLink({ code: b.code, verifier, extensionId: EDGE })).toEqual({ kind: 'mismatch', uid: 'alice' });
    expect(await redeemExtensionLink({ code: b.code, verifier, extensionId: EXT })).toEqual({ kind: 'unknown' });
  });

  it('a code is dead after 60 seconds', async () => {
    const verifier = newVerifier();
    const now = new Date();
    const { code } = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier), now });
    const later = new Date(now.getTime() + 60_001);
    expect(await redeemExtensionLink({ code, verifier, extensionId: EXT, now: later })).toEqual({ kind: 'expired', uid: 'alice' });
    expect(await redeemExtensionLink({ code, verifier, extensionId: EXT })).toEqual({ kind: 'unknown' });
  });

  it('two attempts at once: exactly one gets the user', async () => {
    const verifier = newVerifier();
    const { code } = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    const results = await Promise.all(Array.from({ length: 5 }, () => redeemExtensionLink({ code, verifier, extensionId: EXT })));
    expect(results.filter((r) => r.kind === 'ok')).toEqual([{ kind: 'ok', uid: 'alice' }]);
    expect(results.filter((r) => r.kind === 'unknown')).toHaveLength(4);
  });

  it('a new code clears the user\'s own spent and expired codes, and nobody else\'s', async () => {
    const verifier = newVerifier();
    const hash = extensionVerifierHash(verifier);
    const live = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: hash });
    const row = (n: number, uid: string, expires: string, used: string | null) => pool.query(
      `INSERT INTO extension_links (code_hash, uid, extension_id, verifier_hash, expires_at, used_at)
       VALUES (repeat($1, 64), $2, $3, $4, NOW() + $5::interval, NOW() + $6::interval)`,
      [String(n), uid, EXT, hash, expires, used],
    );
    await row(1, 'alice', '-1 minute', null); // expired
    await row(2, 'alice', '1 minute', '0 seconds'); // spent
    await row(3, 'bob', '-1 minute', null); // bob's, expired
    await row(4, 'bob', '1 minute', '0 seconds'); // bob's, spent
    expect(await count('SELECT 1 FROM extension_links WHERE uid = $1', ['alice'])).toBe(3);

    await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: hash });
    expect(await count('SELECT 1 FROM extension_links WHERE uid = $1', ['alice'])).toBe(2);
    expect(await count('SELECT 1 FROM extension_links WHERE uid = $1', ['bob'])).toBe(2);
    expect(await redeemExtensionLink({ code: live.code, verifier, extensionId: EXT })).toEqual({ kind: 'ok', uid: 'alice' });
  });

  it('goes with the account', async () => {
    const verifier = newVerifier();
    const { code } = await createExtensionLink({ uid: 'alice', extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    await createExtensionLink({ uid: 'bob', extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await count('SELECT 1 FROM extension_links WHERE uid = $1', ['alice'])).toBe(0);
    expect(await count('SELECT 1 FROM extension_links WHERE uid = $1', ['bob'])).toBe(1);
    expect(await redeemExtensionLink({ code, verifier, extensionId: EXT })).toEqual({ kind: 'unknown' });
  });
});

describe('POST /v1/auth/extension-link and /v1/auth/extension-token', () => {
  it('only the chrome-extension:// origins in ALLOWED_ORIGINS may sign in', () => {
    expect([...allowedExtensionIds()].sort()).toEqual([EXT, EDGE].sort());
    expect(allowedExtensionIds({ ALLOWED_ORIGINS: 'https://beta.example.test, chrome-extension://short' }).size).toBe(0);
  });

  it('signs the extension in as the user who asked, and logs neither the code, the verifier nor the token', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    expect(made.status).toBe(200);
    expect(ExtensionLinkResponse.parse(made.body)).toEqual(made.body);
    expect(made.headers['Cache-Control']).toBe('no-store');

    const got = await trade({ code: made.body.code, verifier, extensionId: EXT });
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ customToken: 'custom-token-for-alice' });
    expect(got.headers['Cache-Control']).toBe('no-store');
    expect(minted).toEqual(['alice']);
    expect(got.lines).toContainEqual(['info', 'extension_token_issued', { extensionId: EXT, userId: 'alice' }]);

    const logged = JSON.stringify([...made.lines, ...got.lines]);
    expect(logged).not.toContain(made.body.code);
    expect(logged).not.toContain(verifier);
    expect(logged).not.toContain('custom-token-for-alice');

    const again = await trade({ code: made.body.code, verifier, extensionId: EXT });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'extension_link_invalid' });
    expect(minted).toEqual(['alice']);
  });

  it('bob\'s code signs in bob, never alice', async () => {
    const verifier = newVerifier();
    await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    const bobs = await link('bob', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    const got = await trade({ code: bobs.body.code, verifier, extensionId: EXT });
    expect(got.body).toEqual({ customToken: 'custom-token-for-bob' });
    expect(minted).toEqual(['bob']);
  });

  it('refuses an extension that isn\'t allowed, or a malformed request', async () => {
    const hash = extensionVerifierHash(newVerifier());
    const unknown = await link('alice', { extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verifierHash: hash });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: 'extension_unknown' });
    const bad = await link('alice', { extensionId: EXT, verifierHash: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'extension_link_invalid' });
    const badTrade = await trade({ code: 'x', verifier: 'too-short', extensionId: EXT });
    expect(badTrade.status).toBe(400);
    expect(await count('SELECT 1 FROM extension_links')).toBe(0);
  });

  it('answers 503 on both routes until an extension is allowed', async () => {
    process.env.ALLOWED_ORIGINS = 'https://beta.example.test';
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    expect(made.status).toBe(503);
    expect(made.body).toEqual({ error: 'feature_disabled' });
    const got = await trade({ code: 'a'.repeat(43), verifier, extensionId: EXT });
    expect(got.status).toBe(503);
    expect(await count('SELECT 1 FROM extension_links')).toBe(0);
  });

  it('a web page can\'t trade a code, even one it saw, and trying spends it', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    const fromPage = await trade({ code: made.body.code, verifier, extensionId: EXT }, { origin: 'https://evil.example.test' });
    expect(fromPage.status).toBe(400);
    expect(fromPage.lines).toContainEqual(['warn', 'extension_token_refused', { reason: 'origin', extensionId: EXT, userId: 'alice' }]);
    const fromExtension = await trade({ code: made.body.code, verifier, extensionId: EXT });
    expect(fromExtension.status).toBe(400);
    expect(minted).toEqual([]);
  });

  it('another extension\'s origin is refused too', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    const got = await trade({ code: made.body.code, verifier, extensionId: EXT }, { origin: `chrome-extension://${EDGE}` });
    expect(got.status).toBe(400);
    expect(minted).toEqual([]);
  });

  it('an extension taken off the allowlist after its code was made is refused', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    process.env.ALLOWED_ORIGINS = `chrome-extension://${EDGE}`;
    const got = await trade({ code: made.body.code, verifier, extensionId: EXT });
    expect(got.status).toBe(400);
    expect(got.lines).toContainEqual(['warn', 'extension_token_refused', { reason: 'extension_unknown', extensionId: EXT, userId: 'alice' }]);
    expect(minted).toEqual([]);
  });

  it('an account deleted after its code was made gets no token', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    // The deletion's tombstone lands between the code and the trade.
    await pool.query('INSERT INTO account_deletions (uid) VALUES ($1)', ['alice']);
    const got = await trade({ code: made.body.code, verifier, extensionId: EXT });
    expect(got.status).toBe(401);
    expect(got.body).toEqual({ error: 'account_deleted' });
    expect(minted).toEqual([]);
  });

  it('a failed mint after the code is spent still names the user in the error line', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    failMint = true;
    const { log, lines } = captureLog();
    const req: any = { log, headers: { origin: `chrome-extension://${EXT}` }, body: { code: made.body.code, verifier, extensionId: EXT } };
    const res = { set() { return this; }, status() { return this; }, json() { return this; } };
    await expect(extensionTokenRoute(req, res)).rejects.toThrow('signBlob denied');
    // What app.js's error handler does with an unhandled rejection.
    req.log.error({ err: 'signBlob denied' }, 'unhandled_error');
    expect(lines.at(-1)).toEqual(['error', 'unhandled_error', { uid: 'alice', userId: 'alice', err: 'signBlob denied' }]);
  });

  it('with no Origin header (not a browser), the code and verifier alone decide', async () => {
    const verifier = newVerifier();
    const made = await link('alice', { extensionId: EXT, verifierHash: extensionVerifierHash(verifier) });
    const got = await trade({ code: made.body.code, verifier, extensionId: EXT }, {});
    expect(got.status).toBe(200);
    expect(minted).toEqual(['alice']);
  });
});
