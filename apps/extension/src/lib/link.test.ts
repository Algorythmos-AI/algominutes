import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hello, link, PENDING_TTL_MS } from './link';
import { readSession } from './session';
import { fakeStorage, fakeFetch, json, idTokenFor, type Call } from './testing';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';

function world(answer?: (c: Call) => Response) {
  const storage = fakeStorage();
  let t = 1_000_000;
  const net = fakeFetch(answer ?? ((c) => {
    if (c.url.endsWith('/v1/auth/extension-token')) return json(200, { customToken: 'minted-custom-token' });
    if (c.url.includes('accounts:signInWithCustomToken')) return json(200, { idToken: idTokenFor('alice'), refreshToken: 'refresh-1', expiresIn: '3600' });
    return json(500, {});
  }));
  const deps = { storage, fetch: net.fetch, now: () => t, extensionId: EXT };
  return { deps, storage, calls: net.calls, advance: (ms: number) => { t += ms; } };
}

describe('hello', () => {
  it('keeps a fresh verifier in session storage and answers only its S256', async () => {
    const w = world();
    const a = await hello(w.deps);
    const kept = w.storage.data.get('pendingLink') as { verifier: string };
    expect(kept.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifierHash).toBe(createHash('sha256').update(kept.verifier).digest('base64url'));
    expect(JSON.stringify(a)).not.toContain(kept.verifier);
    const b = await hello(w.deps);
    expect(b.verifierHash).not.toBe(a.verifierHash);
  });
});

describe('link', () => {
  it('trades the code and the verifier, signs in to Firebase with the custom token, and keeps the session', async () => {
    const w = world();
    await hello(w.deps);
    const { verifier } = w.storage.data.get('pendingLink') as { verifier: string };
    expect(await link(w.deps, 'the-code')).toEqual({ ok: true, uid: 'alice' });

    const [trade, signIn] = w.calls;
    expect(trade!.url).toBe('https://api.example.test/v1/auth/extension-token');
    expect(JSON.parse(trade!.body!)).toEqual({ code: 'the-code', verifier, extensionId: EXT });
    expect(trade!.headers['X-AlgoMinutes-Client']).toBe('extension/1.0.0');
    expect(trade!.headers.Authorization).toBeUndefined();
    expect(signIn!.url).toBe('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=test-firebase-web-key');
    expect(JSON.parse(signIn!.body!)).toEqual({ token: 'minted-custom-token', returnSecureToken: true });

    expect(await readSession(w.deps)).toEqual({ uid: 'alice', idToken: idTokenFor('alice'), refreshToken: 'refresh-1', expiresAt: 1_000_000 + 3_600_000 });
    expect(w.storage.data.has('pendingLink')).toBe(false);
  });

  it('a verifier is good for one try', async () => {
    const w = world();
    await hello(w.deps);
    await link(w.deps, 'the-code');
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'expired' });
    expect(w.calls).toHaveLength(2);
  });

  it('and for two minutes', async () => {
    const w = world();
    await hello(w.deps);
    w.advance(PENDING_TTL_MS + 1);
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'expired' });
    expect(w.calls).toHaveLength(0);
  });

  it('a refused code signs nothing in', async () => {
    const w = world(() => json(400, { error: 'extension_link_invalid' }));
    await hello(w.deps);
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'refused' });
    expect(await readSession(w.deps)).toBeNull();
    expect(w.calls).toHaveLength(1);
  });

  it('a failed answer is refused whatever its body says', async () => {
    const w = world(() => json(502, { customToken: 'from-a-proxy-page' }));
    await hello(w.deps);
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'refused' });
    expect(w.calls).toHaveLength(1);
  });

  it('an answer without a custom token signs nothing in', async () => {
    const w = world(() => json(200, { nope: true }));
    await hello(w.deps);
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'refused' });
    expect(w.calls).toHaveLength(1);
  });

  it('a build too old for the api says so', async () => {
    const w = world(() => json(426, { error: 'please_update' }));
    await hello(w.deps);
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'please_update' });
  });

  it('Firebase refusing the custom token signs nothing in', async () => {
    const w = world((c) => (c.url.endsWith('/v1/auth/extension-token') ? json(200, { customToken: 'minted' }) : json(400, { error: { message: 'INVALID_CUSTOM_TOKEN' } })));
    await hello(w.deps);
    expect(await link(w.deps, 'the-code')).toEqual({ ok: false, error: 'refused' });
    expect(await readSession(w.deps)).toBeNull();
  });

  it('the network failing is thrown, for the page to report', async () => {
    const w = world(() => { throw new TypeError('Failed to fetch'); });
    await hello(w.deps);
    await expect(link(w.deps, 'the-code')).rejects.toThrow('Failed to fetch');
  });
});
